import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_LANE_ENVIRONMENTS,
	type LaneState,
} from '../shared/lane-protocol';
import { createLaneIpcHandlers } from './lane-ipc';

const state: LaneState = {
	revision: 1,
	updatedAt: 1,
	environments: [...DEFAULT_LANE_ENVIRONMENTS],
	lanes: [],
	worktrees: [],
	repositories: [],
};

function fixture(selected: string | null = '/Users/dev/app') {
	const service = {
		getState: vi.fn(() => state),
		runOperation: vi.fn(
			async (operation: { actionId: string; kind: string }) => ({
				actionId: operation.actionId,
				kind: operation.kind as 'lane.refresh',
				completed: true,
				state,
			})
		),
		addRepository: vi.fn(async () => state),
	};
	const assertTrustedRenderer = vi.fn();
	const selectRepository = vi.fn(async () => selected ?? undefined);
	const handlers = createLaneIpcHandlers({
		service,
		assertTrustedRenderer,
		selectRepository,
	});
	return { service, assertTrustedRenderer, selectRepository, handlers };
}

describe('Lane IPC', () => {
	it('checks the renderer and validates the state it returns', () => {
		const { assertTrustedRenderer, handlers } = fixture();
		expect(handlers.getState({} as never)).toEqual(state);
		expect(assertTrustedRenderer).toHaveBeenCalledOnce();
	});

	it('rejects malformed operations before they reach the service', async () => {
		const { service, handlers } = fixture();
		await expect(
			handlers.runOperation({} as never, {
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: '../escape',
				simulatorUdid: 'nope',
			})
		).rejects.toThrow();
		expect(service.runOperation).not.toHaveBeenCalled();
	});

	it('forwards ordinary operations to the service', async () => {
		const { service, handlers } = fixture();
		const receipt = await handlers.runOperation({} as never, {
			actionId: 'op-1',
			kind: 'lane.refresh',
		});
		expect(service.runOperation).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'lane.refresh' })
		);
		expect(receipt).toMatchObject({ completed: true });
	});

	it('resolves repository selection through the main-owned dialog', async () => {
		const { service, selectRepository, handlers } = fixture();
		const receipt = await handlers.runOperation({} as never, {
			actionId: 'op-2',
			kind: 'lane.add-repository',
		});
		expect(selectRepository).toHaveBeenCalledOnce();
		expect(service.addRepository).toHaveBeenCalledWith('/Users/dev/app');
		expect(service.runOperation).not.toHaveBeenCalled();
		expect(receipt).toMatchObject({ completed: true, state });
	});

	it('returns a typed cancellation when the dialog is dismissed', async () => {
		const { service, handlers } = fixture(null);
		await expect(
			handlers.runOperation({} as never, {
				actionId: 'op-3',
				kind: 'lane.add-repository',
			})
		).resolves.toMatchObject({ completed: false, cancelled: true });
		expect(service.addRepository).not.toHaveBeenCalled();
	});

	it('reports a non-repository selection as a redacted error', async () => {
		const { service, handlers } = fixture('/Users/dev/not-a-repo');
		service.addRepository.mockRejectedValueOnce(
			new Error('/Users/dev/not-a-repo is not inside a git repository.')
		);
		const receipt = await handlers.runOperation({} as never, {
			actionId: 'op-4',
			kind: 'lane.add-repository',
		});
		expect(receipt.completed).toBe(false);
		expect(receipt.error).toMatch(/not inside a git repository/);
	});
});
