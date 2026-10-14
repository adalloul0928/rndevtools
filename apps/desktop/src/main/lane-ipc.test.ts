import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_LANE_ENVIRONMENTS,
	type Lane,
	type LaneState,
} from '../shared/lane-protocol';
import { createLaneIpcHandlers } from './lane-ipc';

const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const pendingLane: Lane = {
	id: 'lane-11111111-2222-4333-8444-555555555555',
	worktreePath: '/Users/dev/app-feature',
	branch: 'feature',
	simulatorUdid: UDID,
	environment: 'development',
	port: 8_100,
	metro: 'ready',
	logPath: '/Users/dev/lane.log',
	startedAt: 1,
	slim: {
		profileId: 'rndevtools-development',
		status: 'needs-approval',
		updatedAt: 1,
	},
};
const state: LaneState = {
	revision: 1,
	updatedAt: 1,
	environments: [...DEFAULT_LANE_ENVIRONMENTS],
	lanes: [pendingLane],
	worktrees: [],
	repositories: [],
};

function fixture(
	selected: string | null = '/Users/dev/app',
	approveSlim = true
) {
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
	const confirmSlim = vi.fn(async () => approveSlim);
	const findLane = vi.fn((laneId: string) =>
		state.lanes.find((lane) => lane.id === laneId)
	);
	const handlers = createLaneIpcHandlers({
		service,
		assertTrustedRenderer,
		selectRepository,
		confirmSlim,
		findLane,
	});
	return {
		service,
		assertTrustedRenderer,
		selectRepository,
		confirmSlim,
		findLane,
		handlers,
	};
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

	describe('slimming approval', () => {
		it('asks the native dialog before a lane.start with a slim profile and forwards the answer', async () => {
			const { service, confirmSlim, handlers } = fixture(
				'/Users/dev/app',
				true
			);
			await handlers.runOperation({} as never, {
				actionId: 'op-slim-1',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app-feature',
				simulatorUdid: UDID,
				slimProfileId: 'rndevtools-development',
			});
			expect(confirmSlim).toHaveBeenCalledWith(expect.anything(), {
				profileId: 'rndevtools-development',
				simulatorUdid: UDID,
			});
			expect(service.runOperation).toHaveBeenCalledWith(
				expect.objectContaining({ kind: 'lane.start' }),
				undefined,
				{ slimApproved: true }
			);
		});

		it('still starts the lane when the operator declines, without approval', async () => {
			const { service, handlers } = fixture('/Users/dev/app', false);
			await handlers.runOperation({} as never, {
				actionId: 'op-slim-2',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app-feature',
				simulatorUdid: UDID,
				slimProfileId: 'rndevtools-development',
			});
			expect(service.runOperation).toHaveBeenCalledWith(
				expect.objectContaining({ kind: 'lane.start' }),
				undefined,
				{ slimApproved: false }
			);
		});

		it('never shows a dialog for a lane.start without a slim profile', async () => {
			const { service, confirmSlim, handlers } = fixture();
			await handlers.runOperation({} as never, {
				actionId: 'op-plain',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app-feature',
				simulatorUdid: UDID,
			});
			expect(confirmSlim).not.toHaveBeenCalled();
			expect(service.runOperation).toHaveBeenCalledWith(
				expect.objectContaining({ kind: 'lane.start' })
			);
		});

		it('approves a pending lane.slim only after the dialog, using the lane on record', async () => {
			const { service, confirmSlim, handlers } = fixture(
				'/Users/dev/app',
				true
			);
			await handlers.runOperation({} as never, {
				actionId: 'op-approve',
				kind: 'lane.slim',
				laneId: pendingLane.id,
				decision: 'approve',
			});
			expect(confirmSlim).toHaveBeenCalledWith(expect.anything(), {
				laneId: pendingLane.id,
				profileId: 'rndevtools-development',
				simulatorUdid: UDID,
			});
			expect(service.runOperation).toHaveBeenCalledWith(
				expect.objectContaining({ kind: 'lane.slim', decision: 'approve' }),
				undefined,
				{ slimApproved: true }
			);
		});

		it('returns a typed cancellation when the approval dialog is declined', async () => {
			const { service, handlers } = fixture('/Users/dev/app', false);
			await expect(
				handlers.runOperation({} as never, {
					actionId: 'op-approve-declined',
					kind: 'lane.slim',
					laneId: pendingLane.id,
					decision: 'approve',
				})
			).resolves.toMatchObject({ completed: false, cancelled: true });
			expect(service.runOperation).not.toHaveBeenCalled();
		});

		it('refuses to approve a lane with nothing pending and passes dismissals straight through', async () => {
			const { service, confirmSlim, handlers } = fixture();
			const missing = await handlers.runOperation({} as never, {
				actionId: 'op-approve-missing',
				kind: 'lane.slim',
				laneId: 'lane-99999999-2222-4333-8444-555555555555',
				decision: 'approve',
			});
			expect(missing).toMatchObject({ completed: false });
			expect(missing.error).toMatch(/no slimming request/);
			await handlers.runOperation({} as never, {
				actionId: 'op-dismiss',
				kind: 'lane.slim',
				laneId: pendingLane.id,
				decision: 'dismiss',
			});
			expect(confirmSlim).not.toHaveBeenCalled();
			expect(service.runOperation).toHaveBeenCalledWith(
				expect.objectContaining({ kind: 'lane.slim', decision: 'dismiss' })
			);
		});
	});
});
