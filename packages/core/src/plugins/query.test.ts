import { QueryClient } from '@tanstack/react-query';
import {
	createMutationSnapshot,
	createQueryPlugin,
	createQuerySnapshot,
} from './query';

describe('createQuerySnapshot', () => {
	it('captures public query state and optional data', () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { gcTime: Number.POSITIVE_INFINITY } },
		});
		queryClient.setQueryData(['workouts', { page: 1 }], { items: [1, 2] });
		const query = queryClient.getQueryCache().getAll()[0];
		if (!query) throw new Error('Expected cached query');

		const snapshot = createQuerySnapshot(query, true, 1024);

		expect(snapshot.key).toContain('workouts');
		expect(snapshot.status).toBe('success');
		expect(snapshot.data).toContain('items');
		expect(snapshot.dataUpdateCount).toBe(1);
		queryClient.clear();
	});
});

describe('createQueryPlugin', () => {
	it('limits raw cache entries before snapshotting and defers payload serialization', () => {
		const queryClient = new QueryClient();
		for (let index = 0; index < 10; index += 1) {
			queryClient.setQueryData(['query', index], {
				payload: 'x'.repeat(10_000),
			});
		}
		const plugin = createQueryPlugin({
			queryClient,
			captureData: true,
			maxQueries: 2,
			maxStoreBytes: 32 * 1024,
		});
		const dispose = plugin.install?.();

		expect(plugin.getSnapshot().queries).toHaveLength(2);
		expect(plugin.getSnapshot().queries[0]?.data).toBeUndefined();

		dispose?.();
		queryClient.clear();
	});

	it('supports reusable metadata overrides', () => {
		const queryClient = new QueryClient();
		const plugin = createQueryPlugin({
			queryClient,
			id: 'pumpd-query',
			title: 'PUMPD Query',
			description: 'Custom description',
			section: 'Diagnostics',
			systemImage: 'bolt.fill',
		});

		expect(plugin).toEqual(
			expect.objectContaining({
				id: 'pumpd-query',
				title: 'PUMPD Query',
				description: 'Custom description',
				section: 'Diagnostics',
				systemImage: 'bolt.fill',
			}),
		);
	});

	it('rejects invalid retention bounds', () => {
		const queryClient = new QueryClient();
		expect(() => createQueryPlugin({ queryClient, maxQueries: 0 })).toThrow(
			'maxQueries',
		);
		expect(() =>
			createQueryPlugin({ queryClient, maxStoreBytes: Number.NaN }),
		).toThrow('maxStoreBytes');
	});
});

describe('createMutationSnapshot', () => {
	it('captures mutation metadata and variables without private state APIs', () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { gcTime: Number.POSITIVE_INFINITY } },
		});
		const mutation = queryClient.getMutationCache().build(queryClient, {
			mutationKey: ['save-workout'],
			mutationFn: async (variables: { id: string }) => variables,
		});

		const snapshot = createMutationSnapshot(mutation, true, 1024);

		expect(snapshot.key).toContain('save-workout');
		expect(snapshot.status).toBe('idle');
		expect(snapshot.id).toBe(mutation.mutationId);
		queryClient.clear();
	});
});
