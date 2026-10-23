import { DevtoolsEventStore } from '../core/event-store';
import {
	createQuerySimulationController,
	type QuerySimulationLease,
} from './query-simulation';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe('createQuerySimulationController', () => {
	it('rejects mutation callbacks before they can apply without registered cleanup', () => {
		const mutate = jest.fn(() => ({}) as QuerySimulationLease);
		expect(() =>
			createQuerySimulationController([
				{ id: 'all', label: 'All', operations: { offline: mutate as never } },
			]),
		).toThrow('apply and release');
		expect(mutate).not.toHaveBeenCalled();
	});

	it('releases a partially applied operation that fails', async () => {
		let offline = false;
		const release = jest.fn(() => {
			offline = false;
		});
		const controller = createQuerySimulationController([
			{
				id: 'all',
				label: 'All',
				operations: {
					offline: {
						apply: () => {
							offline = true;
							throw new Error('Apply failed');
						},
						release,
					},
				},
			},
		]);
		await expect(controller.apply('all', 'offline')).rejects.toThrow(
			'Apply failed',
		);
		expect(release).toHaveBeenCalledTimes(1);
		expect(offline).toBe(false);
		expect(controller.getSnapshot().active).toBeUndefined();
	});

	it('retains failed cleanup for an explicit retry', async () => {
		const release = jest
			.fn()
			.mockRejectedValueOnce(new Error('Busy'))
			.mockResolvedValue(undefined);
		const apply = jest.fn(() => {
			throw new Error('Apply failed');
		});
		const controller = createQuerySimulationController([
			{ id: 'all', label: 'All', operations: { offline: { apply, release } } },
		]);
		await expect(controller.apply('all', 'offline')).rejects.toThrow('cleanup');
		const receipt = controller.getSnapshot().active?.receiptId;
		expect(receipt).toBeDefined();
		await expect(controller.apply('all', 'offline')).rejects.toThrow('cleanup');
		expect(apply).toHaveBeenCalledTimes(1);
		await controller.clear(receipt);
		expect(release).toHaveBeenCalledTimes(2);
		expect(controller.getSnapshot().active).toBeUndefined();
	});

	it('advertises unsupported states with concrete reasons', async () => {
		const controller = createQuerySimulationController([
			{
				id: 'all',
				label: 'All queries',
				operations: { offline: { apply: () => {}, release: jest.fn() } },
				unsupportedReasons: { loading: 'No loading adapter is installed.' },
			},
		]);

		expect(controller.getSnapshot().families[0]?.modes).toEqual(
			expect.arrayContaining([
				{
					mode: 'loading',
					supported: false,
					reason: 'No loading adapter is installed.',
				},
				{ mode: 'offline', supported: true },
			]),
		);
		await expect(controller.apply('all', 'loading')).rejects.toThrow(
			'No loading adapter',
		);
	});

	it('applies, publishes, clears by exact receipt, and records events', async () => {
		const release = jest.fn();
		const eventStore = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
			now: () => 1_000,
		});
		const controller = createQuerySimulationController(
			[
				{
					id: 'all',
					label: 'All queries',
					operations: { offline: { apply: () => {}, release } },
				},
			],
			{ eventStore, now: () => 900 },
		);
		const listener = jest.fn();
		controller.subscribe(listener);

		const active = await controller.apply('all', 'offline');
		expect(active).toEqual({
			familyId: 'all',
			familyLabel: 'All queries',
			mode: 'offline',
			receiptId: 'query-simulation-1',
			startedAt: 900,
		});
		expect(Object.isFrozen(active)).toBe(true);
		expect(controller.getSnapshot().active).toEqual(active);
		await expect(controller.clear('query-simulation-stale')).rejects.toThrow(
			'changed',
		);
		expect(release).not.toHaveBeenCalled();
		await controller.clear(active.receiptId);
		expect(release).toHaveBeenCalledTimes(1);
		expect(controller.getSnapshot().active).toBeUndefined();
		expect(listener).toHaveBeenCalledTimes(2);
		expect(eventStore.getEvents().map((event) => event.kind)).toEqual([
			'simulation-applied',
			'simulation-cleared',
		]);
	});

	it('serializes mutations and releases the previous state before switching', async () => {
		const firstRelease = deferred<void>();
		const firstReleaseStarted = jest.fn();
		const secondApply = jest.fn();
		const controller = createQuerySimulationController([
			{
				id: 'all',
				label: 'All queries',
				operations: {
					offline: {
						apply: () => {},
						release: () => {
							firstReleaseStarted();
							return firstRelease.promise;
						},
					},
					paused: { apply: secondApply, release: () => {} },
				},
			},
		]);
		await controller.apply('all', 'offline');

		const switching = controller.apply('all', 'paused');
		const queuedClear = controller.clear();
		await Promise.resolve();
		expect(firstReleaseStarted).toHaveBeenCalledTimes(1);
		expect(secondApply).not.toHaveBeenCalled();
		firstRelease.resolve();
		await switching;
		await queuedClear;
		expect(secondApply).toHaveBeenCalledTimes(1);
		expect(controller.getSnapshot().active).toBeUndefined();
	});

	it('does not invoke configuration or lease accessors', async () => {
		const familyGetter = jest.fn(() => 'unsafe');
		const family = { label: 'All queries' } as Record<string, unknown>;
		Object.defineProperty(family, 'id', {
			enumerable: true,
			get: familyGetter,
		});
		expect(() => createQuerySimulationController([family as never])).toThrow(
			'data field',
		);
		expect(familyGetter).not.toHaveBeenCalled();

		const leaseGetter = jest.fn(() => jest.fn());
		const unsafe = Object.defineProperty({ apply: () => {} }, 'release', {
			enumerable: true,
			get: leaseGetter,
		});
		expect(() =>
			createQuerySimulationController([
				{
					id: 'all',
					label: 'All queries',
					operations: { offline: unsafe as never },
				},
			]),
		).toThrow('data field');
		expect(leaseGetter).not.toHaveBeenCalled();
	});

	it('rejects malformed bounds, clocks, and non-reversible leases', async () => {
		expect(() => createQuerySimulationController([])).toThrow(
			'between 1 and 50',
		);
		expect(() =>
			createQuerySimulationController([
				{ id: 'duplicate', label: 'One' },
				{ id: 'duplicate', label: 'Two' },
			]),
		).toThrow('duplicate');

		const invalidClock = createQuerySimulationController(
			[
				{
					id: 'all',
					label: 'All queries',
					operations: { offline: { apply: () => {}, release: jest.fn() } },
				},
			],
			{ now: () => Number.NaN },
		);
		await expect(invalidClock.apply('all', 'offline')).rejects.toThrow('clock');

		expect(() =>
			createQuerySimulationController([
				{
					id: 'all',
					label: 'All queries',
					operations: { offline: { apply: () => {} } as never },
				},
			]),
		).toThrow('apply and release');
	});
});
