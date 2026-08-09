import {
	parsePersistedState,
	SerializedPersistenceWriter,
} from './persistence';

describe('parsePersistedState', () => {
	it('accepts a valid versioned runtime state', () => {
		expect(
			parsePersistedState(
				JSON.stringify({
					version: 1,
					presentationMode: 'window',
					restoreMode: 'window',
					launcherPosition: { x: 12, y: 24 },
				}),
			),
		).toEqual({
			version: 1,
			presentationMode: 'window',
			restoreMode: 'window',
			launcherPosition: { x: 12, y: 24 },
		});
	});

	it('rejects malformed and unsupported state', () => {
		expect(parsePersistedState('not-json')).toBeNull();
		expect(
			parsePersistedState(
				JSON.stringify({
					version: 2,
					presentationMode: 'sheet',
					restoreMode: 'sheet',
				}),
			),
		).toBeNull();
	});
});

describe('SerializedPersistenceWriter', () => {
	it('preserves write order when storage resolves out of order', async () => {
		let resolveFirst: (() => void) | undefined;
		const writes: string[] = [];
		const storage = {
			setItem: jest.fn((_key: string, value: string) => {
				writes.push(value);
				if (value === 'first') {
					return new Promise<void>((resolve) => {
						resolveFirst = resolve;
					});
				}
			}),
		};
		const writer = new SerializedPersistenceWriter();
		const first = writer.write(storage, 'key', 'first');
		const second = writer.write(storage, 'key', 'second');
		await Promise.resolve();
		expect(writes).toEqual(['first']);
		resolveFirst?.();
		await Promise.all([first, second]);
		expect(writes).toEqual(['first', 'second']);
	});
});
