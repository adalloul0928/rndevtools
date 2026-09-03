import {
	canonicalizeRestoreValue,
	createRestorePointsPlugin,
} from './restore-points';

describe('createRestorePointsPlugin', () => {
	it('captures detached JSON and restores through the explicit source', async () => {
		let state = { mode: 'live', nested: { count: 1 } };
		const diagnostics = createRestorePointsPlugin({
			sources: [
				{
					id: 'scenario',
					title: 'Scenario',
					capture: () => state,
					restore: (snapshot) => {
						state = snapshot as typeof state;
					},
				},
			],
		});

		const point = await diagnostics.capture('Before repro');
		state.nested.count = 99;
		state = { mode: 'mock', nested: { count: 2 } };
		await diagnostics.restore(point.id);

		expect(state).toEqual({ mode: 'live', nested: { count: 1 } });
		expect(diagnostics.getPoints()[0]?.label).toBe('Before repro');
	});

	it('rolls attempted sources back if a restore fails', async () => {
		let first = 1;
		let second = 1;
		const diagnostics = createRestorePointsPlugin({
			sources: [
				{
					id: 'first',
					title: 'First',
					capture: () => first,
					restore: (value) => {
						first = value as number;
					},
				},
				{
					id: 'second',
					title: 'Second',
					capture: () => second,
					restore: (value) => {
						if (value === 1) throw new Error('source rejected old state');
						second = value as number;
					},
				},
			],
		});
		const point = await diagnostics.capture();
		first = 2;
		second = 2;

		await expect(diagnostics.restore(point.id)).rejects.toThrow(
			'The pre-restore state was reapplied',
		);
		expect(first).toBe(2);
		expect(second).toBe(2);
	});

	it('evicts the oldest points by count', async () => {
		let state = 1;
		const diagnostics = createRestorePointsPlugin({
			maxPoints: 1,
			sources: [
				{
					id: 'state',
					title: 'State',
					capture: () => state,
					restore: () => {},
				},
			],
		});
		await diagnostics.capture('One');
		state = 2;
		await diagnostics.capture('Two');

		expect(diagnostics.getPoints()).toHaveLength(1);
		expect(diagnostics.getPoints()[0]?.label).toBe('Two');
	});

	it('validates source metadata and bounds labels', async () => {
		expect(() =>
			createRestorePointsPlugin({
				sources: [
					{
						id: ' spaced ',
						title: 'Invalid',
						capture: () => 1,
						restore: () => {},
					},
				],
			}),
		).toThrow('surrounding whitespace');

		const diagnostics = createRestorePointsPlugin({
			sources: [
				{ id: 'state', title: 'State', capture: () => 1, restore: () => {} },
			],
		});
		const point = await diagnostics.capture('x'.repeat(1_000));
		expect(point.label.length).toBeLessThan(1_000);
		expect(point.estimatedBytes).toBe(
			new TextEncoder().encode(JSON.stringify(point)).byteLength,
		);
		expect(() => diagnostics.remove('missing')).toThrow('no longer available');
	});

	it('bounds the explicit source registry', () => {
		expect(() =>
			createRestorePointsPlugin({
				sources: Array.from({ length: 51 }, (_, index) => ({
					id: `source-${index}`,
					title: `Source ${index}`,
					capture: () => index,
					restore: () => {},
				})),
			}),
		).toThrow('at most 50');
	});

	it('does not invoke source accessors and caps retained state', () => {
		const getter = jest.fn(() => () => ({ ready: true }));
		const source = {
			id: 'unsafe',
			title: 'Unsafe',
			restore: () => {},
		} as Record<string, unknown>;
		Object.defineProperty(source, 'capture', {
			enumerable: true,
			get: getter,
		});
		expect(() =>
			createRestorePointsPlugin({
				sources: [source] as unknown as Parameters<
					typeof createRestorePointsPlugin
				>[0]['sources'],
			}),
		).toThrow('capture and restore functions');
		expect(getter).not.toHaveBeenCalled();
		expect(() =>
			createRestorePointsPlugin({ sources: [], maxPoints: 51 }),
		).toThrow('maxPoints cannot exceed');
		expect(() =>
			createRestorePointsPlugin({
				sources: [],
				maxTotalBytes: 16 * 1024 * 1024 + 1,
			}),
		).toThrow('maxTotalBytes cannot exceed');
	});
});

describe('canonicalizeRestoreValue', () => {
	it('rejects non-JSON and oversized snapshots', () => {
		expect(() => canonicalizeRestoreValue(undefined, 100)).toThrow(
			'non-JSON undefined',
		);
		expect(() => canonicalizeRestoreValue({ value: 'too large' }, 4)).toThrow(
			'per-source limit',
		);
		expect(() =>
			canonicalizeRestoreValue({ nested: undefined }, 1_000),
		).toThrow('non-JSON undefined');
		expect(() =>
			canonicalizeRestoreValue({ value: Number.NaN }, 1_000),
		).toThrow('finite JSON number');
		expect(() => canonicalizeRestoreValue({ date: new Date() }, 1_000)).toThrow(
			'plain JSON object',
		);
		expect(() => canonicalizeRestoreValue({ map: new Map() }, 1_000)).toThrow(
			'plain JSON object',
		);
		const circular: { self?: unknown } = {};
		circular.self = circular;
		expect(() => canonicalizeRestoreValue(circular, 1_000)).toThrow(
			'circular or shared reference',
		);
	});

	it('keeps exact JSON for restore while redacting its display preview', () => {
		const canonical = canonicalizeRestoreValue(
			{ password: 'private-value', ready: true },
			1_000,
		);

		expect(canonical.json).toContain('private-value');
		expect(canonical.preview).toContain('[REDACTED]');
		expect(canonical.preview).not.toContain('private-value');
	});

	it('rejects array accessors without invoking them', () => {
		const value: unknown[] = [];
		Object.defineProperty(value, '0', {
			enumerable: true,
			get() {
				throw new Error('getter must not run');
			},
		});
		value.length = 1;

		expect(() => canonicalizeRestoreValue(value, 1_000)).toThrow(
			'is an accessor',
		);
	});

	it('serializes from descriptors without invoking proxy property reads', () => {
		const get = jest.fn(() => {
			throw new Error('property reads must not run');
		});
		const value = new Proxy({ ready: true }, { get });

		expect(canonicalizeRestoreValue(value, 1_000).json).toBe('{"ready":true}');
		expect(get).not.toHaveBeenCalled();
	});

	it('bounds structural work before JSON serialization', () => {
		let value: Record<string, unknown> = {};
		for (let index = 0; index < 70; index += 1) {
			value = { nested: value };
		}

		expect(() => canonicalizeRestoreValue(value, 1_000_000)).toThrow(
			'depth limit',
		);
		expect(() =>
			canonicalizeRestoreValue(new Array(100_001), 1_000_000),
		).toThrow('entry limit');
		expect(() =>
			canonicalizeRestoreValue({}, Number.POSITIVE_INFINITY),
		).toThrow('maxBytes');
	});
});
