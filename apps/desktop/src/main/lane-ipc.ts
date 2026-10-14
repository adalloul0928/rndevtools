import {
	diagnosticErrorText,
	redactDiagnosticText,
} from '@rndevtools/core/redact';
import type { IpcMainInvokeEvent } from 'electron';
import {
	type Lane,
	type LaneOperation,
	type LaneOperationReceipt,
	type LaneState,
	laneOperationReceiptSchema,
	laneOperationSchema,
	laneStateSchema,
} from '../shared/lane-protocol';

const MAX_ERROR_LENGTH = 4 * 1024;

type LaneIpcService = {
	getState: () => LaneState;
	runOperation: (
		operation: LaneOperation,
		signal?: AbortSignal,
		options?: { slimApproved?: boolean }
	) => Promise<LaneOperationReceipt>;
	addRepository: (root: string) => Promise<LaneState>;
};

/** What the operator is asked to approve before a lane slims a Simulator. */
type LaneSlimConfirmation = {
	profileId: string;
	simulatorUdid: string;
	/** Set when the lane already exists; absent on a fresh `lane.start`. */
	laneId?: string;
};

type LaneIpcDependencies = {
	service: LaneIpcService;
	assertTrustedRenderer: (event: IpcMainInvokeEvent) => void;
	/** Native folder picker; the renderer never names a path on its own. */
	selectRepository: (event: IpcMainInvokeEvent) => Promise<string | undefined>;
	/**
	 * Native confirmation dialog for slimming. Returning true is the only way
	 * `slimApproved` ever reaches the service: the renderer cannot assert it,
	 * and the CLI router never calls this.
	 */
	confirmSlim: (
		event: IpcMainInvokeEvent,
		confirmation: LaneSlimConfirmation
	) => Promise<boolean>;
	/** Looks up the lane a `lane.slim` operation names, for the dialog copy. */
	findLane: (laneId: string) => Lane | undefined;
};

function safeError(error: unknown): string {
	return redactDiagnosticText(diagnosticErrorText(error)).slice(
		0,
		MAX_ERROR_LENGTH
	);
}

/**
 * Lane IPC. Every other lane operation names a lane id or a worktree the
 * service already discovered; the one path the renderer can introduce — a new
 * repository root — comes from a dialog owned by the main process.
 */
export function createLaneIpcHandlers({
	service,
	assertTrustedRenderer,
	selectRepository,
	confirmSlim,
	findLane,
}: LaneIpcDependencies) {
	return {
		getState: (event: IpcMainInvokeEvent): LaneState => {
			assertTrustedRenderer(event);
			return laneStateSchema.parse(service.getState());
		},
		runOperation: async (
			event: IpcMainInvokeEvent,
			value: unknown
		): Promise<LaneOperationReceipt> => {
			assertTrustedRenderer(event);
			const operation = laneOperationSchema.parse(value);
			if (operation.kind === 'lane.start' && operation.slimProfileId) {
				// A declined dialog still starts the lane; the slim request is
				// recorded as needs-approval so the row can offer it again.
				const approved = await confirmSlim(event, {
					profileId: operation.slimProfileId,
					simulatorUdid: operation.simulatorUdid,
				});
				return service.runOperation(operation, undefined, {
					slimApproved: approved,
				});
			}
			if (operation.kind === 'lane.slim' && operation.decision === 'approve') {
				const lane = findLane(operation.laneId);
				if (!lane?.slim) {
					return laneOperationReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: false,
						error: 'This lane has no slimming request waiting on approval.',
					});
				}
				const approved = await confirmSlim(event, {
					laneId: operation.laneId,
					profileId: lane.slim.profileId,
					simulatorUdid: lane.simulatorUdid,
				});
				if (!approved) {
					return laneOperationReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: false,
						cancelled: true,
					});
				}
				return service.runOperation(operation, undefined, {
					slimApproved: true,
				});
			}
			if (operation.kind !== 'lane.add-repository') {
				return service.runOperation(operation);
			}
			try {
				const selected = await selectRepository(event);
				if (!selected) {
					return laneOperationReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: false,
						cancelled: true,
					});
				}
				const state = await service.addRepository(selected);
				return laneOperationReceiptSchema.parse({
					actionId: operation.actionId,
					kind: operation.kind,
					completed: true,
					state,
				});
			} catch (error) {
				return laneOperationReceiptSchema.parse({
					actionId: operation.actionId,
					kind: operation.kind,
					completed: false,
					error: safeError(error),
				});
			}
		},
	};
}
