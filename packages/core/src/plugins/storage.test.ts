import {
	createStoragePlugin,
	isStorageEntryEditable,
	parseStorageDraft,
	validateStorageSnapshot,
} from './storage';

describe('createStoragePlugin', () => {
	it('loads registered values but never reads protected adapter values', async () => {
		const readStandard = jest.fn(() => 'value');
		const readSecure = jest.fn(() => 'secret');
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys: () => ['key'],
					getValue: readStandard,
				},
				{
					id: 'secure',
					title: 'Secure',
					sensitive: true,
					getAllKeys: () => ['token'],
					getValue: readSecure,
				},
			],
		});

		await storage.refresh();

		expect(readStandard).toHaveBeenCalledWith('key');
		expect(readSecure).not.toHaveBeenCalled();
		expect(storage.getSnapshot().adapters[1]?.entries[0]).toEqual({
			binary: false,
			key: 'token',
			truncated: false,
			valueHidden: true,
		});
	});

	it('validates expected keys and records adapter changes after its baseline', async () => {
		let value = 'first';
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys: () => ['key'],
					getValue: () => value,
				},
			],
			rules: [{ adapterId: 'standard', key: 'key', expectedType: 'string' }],
		});
		await storage.refresh();
		expect(
			validateStorageSnapshot(storage.getSnapshot(), [
				{ adapterId: 'standard', key: 'key', expectedType: 'string' },
			])[0]?.status,
		).toBe('valid');

		value = 'second';
		await storage.refresh();
		expect(storage.getEvents()).toEqual([
			expect.objectContaining({
				adapterId: 'standard',
				key: 'key',
				type: 'updated',
				previousValue: 'first',
				value: 'second',
			}),
		]);
	});

	it('preserves primitive types and rejects unsafe storage edits', () => {
		expect(parseStorageDraft('42', 'number')).toBe(42);
		expect(parseStorageDraft('false', 'boolean')).toBe(false);
		expect(parseStorageDraft('{"ok":true}', 'object')).toEqual({ ok: true });
		expect(() => parseStorageDraft('no', 'boolean')).toThrow('true or false');
		const adapter = {
			id: 'standard',
			title: 'Standard',
			getAllKeys: () => [],
			setValue: jest.fn(),
		};
		expect(
			isStorageEntryEditable(adapter, {
				key: 'large',
				value: 'partial',
				valueType: 'string',
				truncated: true,
				valueHidden: false,
				binary: false,
			}),
		).toBe(false);
	});

	it('rolls back subscriptions if a later adapter fails to subscribe', () => {
		const unsubscribe = jest.fn();
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'first',
					title: 'First',
					getAllKeys: () => [],
					subscribe: () => unsubscribe,
				},
				{
					id: 'second',
					title: 'Second',
					getAllKeys: () => [],
					subscribe: () => {
						throw new Error('subscribe failed');
					},
				},
			],
		});

		expect(() => storage.plugin.install?.()).toThrow('subscribe failed');
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('does not fabricate removals when an adapter refresh fails', async () => {
		let fail = false;
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys: () => {
						if (fail) throw new Error('offline');
						return ['key'];
					},
					getValue: () => 'value',
				},
			],
		});
		await storage.refresh();
		fail = true;
		await storage.refresh();
		expect(storage.getEvents()).toEqual([]);
		expect(storage.getSnapshot().adapters[0]?.error).toBe('offline');
	});

	it('rejects invalid value bounds', () => {
		expect(() =>
			createStoragePlugin({ adapters: [], maxValueBytes: 0 }),
		).toThrow('maxValueBytes');
	});

	it('restarts an in-flight refresh when the collector lifecycle changes', async () => {
		let resolveFirst: (() => void) | undefined;
		const getAllKeys = jest
			.fn<Promise<readonly string[]>, []>()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = () => resolve(['first']);
					}),
			)
			.mockResolvedValue(['second']);
		const storage = createStoragePlugin({
			adapters: [{ id: 'standard', title: 'Standard', getAllKeys }],
		});
		const initialRefresh = storage.refresh();
		const dispose = storage.plugin.install?.();
		resolveFirst?.();
		await initialRefresh;
		await Promise.resolve();

		expect(getAllKeys).toHaveBeenCalledTimes(2);
		expect(storage.getSnapshot().loading).toBe(false);
		expect(storage.getSnapshot().adapters[0]?.entries[0]?.key).toBe('second');
		dispose?.();
	});

	it('cancels a queued subscription refresh when disposed', async () => {
		let listener: (() => void) | undefined;
		const getAllKeys = jest.fn(() => ['key']);
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys,
					subscribe: (nextListener) => {
						listener = nextListener;
						return jest.fn();
					},
				},
			],
		});
		const dispose = storage.plugin.install?.();
		await storage.refresh();
		getAllKeys.mockClear();

		listener?.();
		dispose?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(getAllKeys).not.toHaveBeenCalled();
	});
});
