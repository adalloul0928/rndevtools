import { BoundedEventStore } from './external-store';

describe('BoundedEventStore', () => {
	it('evicts the oldest events by count', () => {
		const store = new BoundedEventStore<number>({
			maxEvents: 2,
			maxBytes: 100,
			estimateBytes: () => 1,
		});

		store.append(1);
		store.append(2);
		store.append(3);

		expect(store.getSnapshot()).toEqual([2, 3]);
	});

	it('replaces and upserts events while preserving bounds', () => {
		const store = new BoundedEventStore<{ id: number; value: string }>({
			maxEvents: 2,
			maxBytes: 20,
			estimateBytes: (event) => event.value.length,
		});
		store.append({ id: 1, value: 'one' });
		expect(
			store.replace((event) => event.id === 1, { id: 1, value: 'done' }),
		).toBe(true);
		store.upsert((event) => event.id === 2, { id: 2, value: 'two' });

		expect(store.getSnapshot()).toEqual([
			{ id: 1, value: 'done' },
			{ id: 2, value: 'two' },
		]);
	});

	it('evicts the oldest events by estimated bytes', () => {
		const store = new BoundedEventStore<string>({
			maxEvents: 10,
			maxBytes: 5,
			estimateBytes: (event) => event.length,
		});

		store.append('abc');
		store.append('def');

		expect(store.getSnapshot()).toEqual(['def']);
	});

	it('does not retain an event larger than the byte budget', () => {
		const store = new BoundedEventStore<string>({
			maxEvents: 10,
			maxBytes: 2,
			estimateBytes: (event) => event.length,
		});

		store.append('oversized');

		expect(store.getSnapshot()).toEqual([]);
	});

	it('rejects invalid bounds and non-finite event estimates', () => {
		expect(
			() =>
				new BoundedEventStore({
					maxEvents: 0,
					maxBytes: 10,
					estimateBytes: () => 1,
				}),
		).toThrow('maxEvents');
		const store = new BoundedEventStore<number>({
			maxEvents: 2,
			maxBytes: 10,
			estimateBytes: () => Number.NaN,
		});
		store.append(1);
		expect(store.getSnapshot()).toEqual([]);
		expect(store.getEstimatedBytes()).toBe(0);
	});
});
