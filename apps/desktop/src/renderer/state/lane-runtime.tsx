import { diagnosticErrorText } from '@rndevtools/core/redact';
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
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

/**
 * Where another panel sends the operator in Lanes: a lane by id (a bare
 * string), or the Agents view, optionally at one session's card, keyed
 * `kind:sessionId` like agentSessionKey.
 * @public
 */
export type LaneFocusTarget =
	| string
	| Readonly<{ view: 'lanes'; laneId?: string }>
	| Readonly<{ view: 'agents'; sessionKey?: string }>;

/** A focus request the Lanes panel applies once, then reports handled. */
type LaneFocusRequest = Readonly<{
	view: 'lanes' | 'agents';
	laneId?: string;
	sessionKey?: string;
	nonce: number;
}>;

export function laneFocusRequest(
	target: LaneFocusTarget,
	nonce: number
): LaneFocusRequest {
	if (typeof target === 'string') {
		return { view: 'lanes', laneId: target, nonce };
	}
	if (target.view === 'agents') {
		return {
			view: 'agents',
			...(target.sessionKey === undefined
				? {}
				: { sessionKey: target.sessionKey }),
			nonce,
		};
	}
	return {
		view: 'lanes',
		...(target.laneId === undefined ? {} : { laneId: target.laneId }),
		nonce,
	};
}

/**
 * What the Lanes panel does with a pending request: wait for the first lane
 * state when it names a lane not listed yet, or apply it. A lane that is gone
 * by then still opens Lanes, on its default selection.
 */
export function resolveLaneFocus(
	request: LaneFocusRequest,
	lanes: readonly Readonly<{ id: string }>[],
	isLoading: boolean
):
	| Readonly<{ kind: 'wait' }>
	| Readonly<{
			kind: 'apply';
			view: 'lanes' | 'agents';
			laneId?: string;
			sessionKey?: string;
	  }> {
	if (request.view === 'agents') {
		return {
			kind: 'apply',
			view: 'agents',
			...(request.sessionKey === undefined
				? {}
				: { sessionKey: request.sessionKey }),
		};
	}
	const listed =
		request.laneId !== undefined &&
		lanes.some((lane) => lane.id === request.laneId);
	if (request.laneId !== undefined && !listed && isLoading) {
		return { kind: 'wait' };
	}
	return {
		kind: 'apply',
		view: 'lanes',
		...(listed && request.laneId !== undefined
			? { laneId: request.laneId }
			: {}),
	};
}

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
	/** The latest request to show a lane or an Agents card, until handled. */
	focus: LaneFocusRequest | null;
	/**
	 * Opens Lanes at a lane, or the Agents view at a session's card, and
	 * navigates to `#simulator/lanes`.
	 */
	focusLane: (target: LaneFocusTarget) => void;
	/** The Lanes panel applied the request with this nonce. */
	focusHandled: (nonce: number) => void;
};

const EMPTY_LANE_STATE: LaneState = {
	revision: 0,
	updatedAt: 0,
	environments: [...DEFAULT_LANE_ENVIRONMENTS],
	lanes: [],
	worktrees: [],
	repositories: [],
	deviceRequests: [],
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

	// The Lanes panel mounts lazily and keeps its view and selection locally,
	// so a deep link waits here until the panel applies it.
	const [focus, setFocus] = useState<LaneFocusRequest | null>(null);
	const focusNonce = useRef(0);
	const focusLane = useCallback((target: LaneFocusTarget) => {
		focusNonce.current += 1;
		setFocus(laneFocusRequest(target, focusNonce.current));
		if (window.location.hash !== '#simulator/lanes') {
			window.location.hash = 'simulator/lanes';
		}
	}, []);
	const focusHandled = useCallback((nonce: number) => {
		setFocus((current) => (current?.nonce === nonce ? null : current));
	}, []);

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
			focus,
			focusLane,
			focusHandled,
		}),
		[
			state,
			isLoading,
			bridge,
			pendingOperation,
			actionStatus,
			refresh,
			runOperation,
			focus,
			focusLane,
			focusHandled,
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
