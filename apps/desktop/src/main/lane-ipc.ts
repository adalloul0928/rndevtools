import {
	diagnosticErrorText,
	redactDiagnosticText,
} from '@rndevtools/core/redact';
import type { IpcMainInvokeEvent } from 'electron';
import {
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
	runOperation: (operation: LaneOperation) => Promise<LaneOperationReceipt>;
	addRepository: (root: string) => Promise<LaneState>;
};

type LaneIpcDependencies = {
	service: LaneIpcService;
	assertTrustedRenderer: (event: IpcMainInvokeEvent) => void;
	/** Native folder picker; the renderer never names a path on its own. */
	selectRepository: (event: IpcMainInvokeEvent) => Promise<string | undefined>;
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
