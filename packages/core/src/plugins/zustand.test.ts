import { changedZustandKeys, createZustandPlugin } from './zustand';

/**
 * Store notifications coalesce into one capture per task, so assertions have to
 * let the queued microtask run first.
 */
function flushCaptures(): Promise<void> {
	return new Promise<void>((resolve) => {
		queueMicrotask(resolve);
	});
}

describe('createZustandPlugin', () => {
	it('captures only an explicit projection while installed', async () => {
		let state = { count: 1, secret: 'never expose this' };
		const listeners = new Set<() => void>();
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => ({ count: state.count }),
					subscribe: (listener) => {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
				},
			],
		});

		expect(diagnostics.getSnapshot().stores).toEqual([]);
		const dispose = diagnostics.plugin.install?.();
		expect(diagnostics.getSnapshot().stores[0]?.stateText).toContain(
			'"count": 1',
		);
		expect(diagnostics.getSnapshot().stores[0]?.stateText).not.toContain(
			'secret',
		);

		state = { count: 2, secret: 'still hidden' };
		for (const listener of listeners) listener();
		await flushCaptures();
		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({ storeId: 'counter', changedKeys: ['count'] }),
		]);
		expect(JSON.stringify(diagnostics.getEvents())).not.toContain('hidden');
		state = { count: 2, secret: 'raw-only change' };
		for (const listener of listeners) listener();
		await flushCaptures();
		expect(diagnostics.getEvents()).toHaveLength(1);

		dispose?.();
		state = { count: 3, secret: 'hidden after dispose' };
		for (const listener of listeners) listener();
		await flushCaptures();
		expect(diagnostics.getEvents()).toHaveLength(1);
	});

	it('coalesces a burst of store notifications into one capture', async () => {
		let count = 0;
		let notify = () => {};
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => ({ count }),
					subscribe: (listener) => {
						notify = listener;
						return () => {};
					},
				},
			],
		});
		diagnostics.plugin.install?.();
		// A host store that calls set() repeatedly inside one task must not pay
		// for a full sanitize/serialize pass per call.
		for (let tick = 1; tick <= 25; tick += 1) {
			count = tick;
			notify();
		}
		await flushCaptures();
		expect(diagnostics.getEvents()).toHaveLength(1);
		expect(diagnostics.getEvents()[0]?.stateText).toContain('25');
	});

	it('detects a change that lands past the first kilobyte of a field', async () => {
		// Fingerprints once compared a 1 KB prefix, so an edit deeper into a large
		// field left the change log empty while the store text updated.
		const padding = 'x'.repeat(4_096);
		let notes = { padding, edited: 'before' };
		let notify = () => {};
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'notes',
					title: 'Notes',
					getInspectableState: () => ({ notes }),
					subscribe: (listener) => {
						notify = listener;
						return () => {};
					},
				},
			],
		});
		diagnostics.plugin.install?.();
		notes = { padding, edited: 'after' };
		notify();
		await flushCaptures();
		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({ changedKeys: ['notes'] }),
		]);
	});

	it('bounds the change history by count', async () => {
		let count = 0;
		let notify = () => {};
		const diagnostics = createZustandPlugin({
			maxEvents: 1,
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => ({ count }),
					subscribe: (listener) => {
						notify = listener;
						return () => {};
					},
				},
			],
		});
		diagnostics.plugin.install?.();
		count = 1;
		notify();
		await flushCaptures();
		count = 2;
		notify();
		await flushCaptures();

		expect(diagnostics.getEvents()).toHaveLength(1);
		expect(diagnostics.getEvents()[0]?.stateText).toContain('2');
	});

	it('redacts credential-shaped fields from explicit projections', () => {
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'session',
					title: 'Session',
					getInspectableState: () => ({
						accessToken: 'private-access-token',
						ready: true,
					}),
					subscribe: () => () => {},
				},
			],
		});
		diagnostics.plugin.install?.();

		const snapshot = JSON.stringify(diagnostics.getSnapshot());
		expect(snapshot).toContain('[REDACTED]');
		expect(snapshot).not.toContain('private-access-token');
	});

	it('does not invoke accessors while fingerprinting projected state', () => {
		const getter = jest.fn(() => 'unsafe');
		const state = { count: 1 } as Record<string, unknown>;
		Object.defineProperty(state, 'computed', {
			enumerable: true,
			get: getter,
		});
		let notify = () => {};
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'safe',
					title: 'Safe',
					getInspectableState: () => state,
					subscribe: (listener) => {
						notify = listener;
						return () => {};
					},
				},
			],
		});

		diagnostics.plugin.install?.();
		notify();
		expect(getter).not.toHaveBeenCalled();
		expect(diagnostics.getSnapshot().stores[0]?.stateText).toContain(
			'[Accessor omitted]',
		);
	});

	it('bounds the number and aggregate size of projected stores', () => {
		const stores = Array.from({ length: 4 }, (_, index) => ({
			id: `store-${index}`,
			title: `Store ${index}`,
			getInspectableState: () => ({ value: 'x'.repeat(1_024) }),
			subscribe: () => () => {},
		}));
		const byCount = createZustandPlugin({ maxStores: 2, stores });
		byCount.plugin.install?.();
		expect(byCount.getSnapshot()).toMatchObject({
			stores: expect.arrayContaining([
				expect.objectContaining({ id: 'store-0' }),
				expect.objectContaining({ id: 'store-1' }),
			]),
			totalStoreCount: 4,
			omittedStoreCount: 2,
			truncated: true,
		});

		const byBytes = createZustandPlugin({
			maxSnapshotBytes: 400,
			maxValueBytes: 1_024,
			stores,
		});
		byBytes.plugin.install?.();
		expect(byBytes.getSnapshot().stores.length).toBeLessThan(stores.length);
		expect(byBytes.getSnapshot().truncated).toBe(true);
		expect(() => createZustandPlugin({ stores, maxEvents: 10_001 })).toThrow(
			'maxEvents cannot exceed',
		);
		expect(() =>
			createZustandPlugin({ stores, maxValueBytes: 1024 * 1024 + 1 }),
		).toThrow('maxValueBytes cannot exceed');
	});

	it('keeps array field metadata within the protocol key limit', async () => {
		let values = Array.from({ length: 700 }, (_, index) => index);
		let notify = () => {};
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'large-array',
					title: 'Large array',
					getInspectableState: () => values,
					subscribe: (listener) => {
						notify = listener;
						return () => {};
					},
				},
			],
		});
		diagnostics.plugin.install?.();
		expect(
			diagnostics.getSnapshot().stores[0]?.keys.length,
		).toBeLessThanOrEqual(500);
		expect(diagnostics.getSnapshot().stores[0]?.truncated).toBe(true);

		values = values.map((value) => value + 1);
		notify();
		await flushCaptures();
		expect(diagnostics.getEvents()[0]?.changedKeys.length).toBeLessThanOrEqual(
			500,
		);
	});

	it('contains faulty host subscriptions and disposers', () => {
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'faulty',
					title: 'Faulty',
					getInspectableState: () => ({ ready: true }),
					subscribe: () => {
						throw new Error('subscribe failed');
					},
				},
			],
			subscribeToStores: () => {
				throw new Error('registry failed');
			},
		});

		let dispose: (() => void) | undefined;
		expect(() => {
			dispose = diagnostics.plugin.install?.();
		}).not.toThrow();
		expect(diagnostics.getSnapshot().stores[0]?.id).toBe('faulty');
		expect(diagnostics.getSnapshot().stores[0]?.error).toContain(
			'Subscription failed',
		);
		expect(diagnostics.getEvents()[0]?.error).toContain('Subscription failed');
		expect(() => dispose?.()).not.toThrow();
	});

	it('ignores adapter callbacks after disposal and reinstallation', async () => {
		let count = 0;
		const listeners: Array<() => void> = [];
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => ({ count }),
					subscribe: (listener) => {
						listeners.push(listener);
						return () => {};
					},
				},
			],
		});
		const firstDispose = diagnostics.plugin.install?.();
		const staleListener = listeners[0];
		firstDispose?.();
		const secondDispose = diagnostics.plugin.install?.();
		count = 1;

		staleListener?.();
		await flushCaptures();

		expect(diagnostics.getEvents()).toEqual([]);
		expect(diagnostics.getSnapshot().stores[0]?.stateText).toContain(
			'"count": 0',
		);
		listeners[1]?.();
		await flushCaptures();
		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({ changedKeys: ['count'] }),
		]);
		secondDispose?.();
	});

	it('keeps another install subscribed when a disposer is called twice', () => {
		const unsubscribe = jest.fn();
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => ({ count: 0 }),
					subscribe: () => unsubscribe,
				},
			],
		});
		const firstDispose = diagnostics.plugin.install?.();
		const secondDispose = diagnostics.plugin.install?.();

		firstDispose?.();
		firstDispose?.();
		expect(unsubscribe).not.toHaveBeenCalled();
		secondDispose?.();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('surfaces invalid adapter contracts without making installation fatal', () => {
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'invalid',
					title: 'Invalid',
					getInspectableState: undefined,
					subscribe: () => () => {},
				},
			] as unknown as Parameters<typeof createZustandPlugin>[0]['stores'],
		});

		expect(() => diagnostics.plugin.install?.()).not.toThrow();
		expect(diagnostics.getSnapshot().error).toContain(
			'projection and subscription callbacks',
		);
	});

	it('does not invoke adapter accessors and reports invalid registry disposers', () => {
		const getter = jest.fn(() => () => ({ ready: true }));
		const adapter = {
			id: 'unsafe',
			title: 'Unsafe',
			subscribe: () => () => {},
		} as Record<string, unknown>;
		Object.defineProperty(adapter, 'getInspectableState', {
			enumerable: true,
			get: getter,
		});
		const unsafe = createZustandPlugin({
			stores: [adapter] as unknown as Parameters<
				typeof createZustandPlugin
			>[0]['stores'],
		});
		unsafe.plugin.install?.();
		expect(getter).not.toHaveBeenCalled();
		expect(unsafe.getSnapshot().error).toContain('must be plain data');

		const invalidRegistry = createZustandPlugin({
			stores: [],
			subscribeToStores: (() => undefined) as unknown as (
				listener: () => void,
			) => () => void,
		});
		invalidRegistry.plugin.install?.();
		expect(invalidRegistry.getSnapshot().error).toContain(
			'did not return a disposer',
		);
	});
});

describe('changedZustandKeys', () => {
	it('reports added, removed, and modified top-level keys', () => {
		expect(
			changedZustandKeys(
				{ unchanged: '1', removed: '2', changed: 'before' },
				{ unchanged: '1', added: '3', changed: 'after' },
			),
		).toEqual(['added', 'changed', 'removed']);
	});

	it('bounds a completely replaced top-level key set', () => {
		const previous = Object.fromEntries(
			Array.from({ length: 500 }, (_, index) => [`old-${index}`, 'before']),
		);
		const next = Object.fromEntries(
			Array.from({ length: 500 }, (_, index) => [`new-${index}`, 'after']),
		);
		expect(changedZustandKeys(previous, next)).toHaveLength(500);
	});
});
