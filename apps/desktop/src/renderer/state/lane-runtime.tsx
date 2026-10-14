import { diagnosticErrorText } from '@rndevtools/core/redact';
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react';
import {
	DEFAULT_LANE_ENVIRONMENTS,
	type LaneBridge,
	type LaneOperation,
	type LaneOperationReceipt,
	type LaneState,
} from '../../shared/lane-protocol';

export type LaneActionStatus =
	| { kind: 'idle'; message: '' }
	| { kind: 'pending'; message: string }
	| { kind: 'success'; message: string }
	| { kind: 'error'; message: string };

type WithoutActionId<T> = T extends { actionId: string }
	? Omit<T, 'actionId'>
	: never;
type LaneOperationInput = WithoutActionId<LaneOperation>;

type LaneRuntimeValue = {
	state: LaneState;
	isLoading: boolean;
	isBridgeAvailable: boolean;
	/** Operation kind currently in flight, or null. */
	pendingOperation: LaneOperation['kind'] | null;
	actionStatus: LaneActionStatus;
	clearActionStatus: () => void;
	refresh: () => Promise<void>;
	runOperation: (
		operation: LaneOperationInput,
		messages?: { pendingMessage?: string; successMessage?: string }
	) => Promise<LaneOperationReceipt | undefined>;
	laneForSimulator: (udid: string) => LaneState['lanes'][number] | undefined;
};

const EMPTY_LANE_STATE: LaneState = {
	revision: 0,
	updatedAt: 0,
	environments: [...DEFAULT_LANE_ENVIRONMENTS],
	lanes: [],
	worktrees: [],
	repositories: [],
};

const LaneRuntimeContext = createContext<LaneRuntimeValue | null>(null);

function laneBridge(): LaneBridge | null {
	const candidate = window.rnDevtools as
		| (NonNullable<typeof window.rnDevtools> & Partial<LaneBridge>)
		| undefined;
	if (
		!candidate ||
		typeof candidate.getLaneState !== 'function' ||
		typeof candidate.subscribeLaneState !== 'function' ||
		typeof candidate.runLaneOperation !== 'function'
	) {
		return null;
	}
	return candidate as LaneBridge;
}

function errorText(error: unknown): string {
	return diagnosticErrorText(error).slice(0, 8 * 1024);
}

export function LaneRuntimeProvider({ children }: { children: ReactNode }) {
	const bridge = useMemo(laneBridge, []);
	const [state, setState] = useState<LaneState>(EMPTY_LANE_STATE);
	const [isLoading, setIsLoading] = useState(Boolean(bridge));
	const [pendingOperation, setPendingOperation] = useState<
		LaneOperation['kind'] | null
	>(null);
	const [actionStatus, setActionStatus] = useState<LaneActionStatus>({
		kind: 'idle',
		message: '',
	});

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		let unsubscribe = () => {};
		try {
			unsubscribe = bridge.subscribeLaneState((next) => {
				if (active) setState(next);
			});
		} catch (error) {
			setActionStatus({ kind: 'error', message: errorText(error) });
		}
		void bridge
			.getLaneState()
			.then((next) => {
				if (active) setState(next);
			})
			.catch((error: unknown) => {
				if (active)
					setActionStatus({ kind: 'error', message: errorText(error) });
			})
			.finally(() => {
				if (active) setIsLoading(false);
			});
		return () => {
			active = false;
			try {
				unsubscribe();
			} catch {
				// A faulty native disposer must not break React teardown.
			}
		};
	}, [bridge]);

	const runOperation = useCallback<LaneRuntimeValue['runOperation']>(
		async (input, messages = {}) => {
			if (!bridge) {
				setActionStatus({
					kind: 'error',
					message: 'Lanes require the secure desktop bridge.',
				});
				return undefined;
			}
			const operation = {
				...input,
				actionId: `lane-${crypto.randomUUID()}`,
			} as LaneOperation;
			setPendingOperation(operation.kind);
			if (messages.pendingMessage) {
				setActionStatus({ kind: 'pending', message: messages.pendingMessage });
			}
			try {
				const receipt = await bridge.runLaneOperation(operation);
				if (receipt.state) setState(receipt.state);
				if (receipt.cancelled) {
					setActionStatus({ kind: 'idle', message: '' });
				} else if (!receipt.completed) {
					setActionStatus({
						kind: 'error',
						message: receipt.error ?? 'The lane operation did not complete.',
					});
				} else if (messages.successMessage) {
					setActionStatus({
						kind: 'success',
						message: messages.successMessage,
					});
				} else {
					setActionStatus({ kind: 'idle', message: '' });
				}
				return receipt;
			} catch (error) {
				setActionStatus({ kind: 'error', message: errorText(error) });
				return undefined;
			} finally {
				setPendingOperation(null);
			}
		},
		[bridge]
	);

	const refresh = useCallback(async () => {
		await runOperation({ kind: 'lane.refresh' });
	}, [runOperation]);

	const value = useMemo<LaneRuntimeValue>(
		() => ({
			state,
			isLoading,
			isBridgeAvailable: Boolean(bridge),
			pendingOperation,
			actionStatus,
			clearActionStatus: () => setActionStatus({ kind: 'idle', message: '' }),
			refresh,
			runOperation,
			laneForSimulator: (udid) =>
				state.lanes.find(
					(lane) => lane.simulatorUdid.toUpperCase() === udid.toUpperCase()
				),
		}),
		[
			state,
			isLoading,
			bridge,
			pendingOperation,
			actionStatus,
			refresh,
			runOperation,
		]
	);

	return (
		<LaneRuntimeContext.Provider value={value}>
			{children}
		</LaneRuntimeContext.Provider>
	);
}

export function useLaneRuntime(): LaneRuntimeValue {
	const value = useContext(LaneRuntimeContext);
	if (!value) {
		throw new Error('useLaneRuntime must be used inside LaneRuntimeProvider.');
	}
	return value;
}
