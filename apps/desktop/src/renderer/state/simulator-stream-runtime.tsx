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
import type {
	SimulatorStreamBridge,
	SimulatorStreamFrame,
	SimulatorStreamQuality,
	SimulatorStreamStatus,
	SimulatorStreamSubscription,
} from '../../shared/simulator-stream-protocol';

export type LiveScreen = {
	/** Object URL for the latest frame; revoked when the next one arrives. */
	url: string;
	frame: SimulatorStreamFrame;
};

type ScreenRequest = { udid: string; quality: SimulatorStreamQuality };

type SimulatorStreamRuntimeValue = {
	isAvailable: boolean;
	screens: ReadonlyMap<string, LiveScreen>;
	statuses: ReadonlyMap<string, SimulatorStreamStatus>;
	/**
	 * Registers interest in a screen for as long as the returned disposer is
	 * not called. Many components may want the same UDID; the strongest
	 * quality wins and main sees one subscription per Simulator.
	 */
	request: (request: ScreenRequest) => () => void;
};

const SimulatorStreamContext =
	createContext<SimulatorStreamRuntimeValue | null>(null);

const SUBSCRIPTION_DEBOUNCE_MS = 60;

function streamBridge(): SimulatorStreamBridge | null {
	const candidate = window.rnDevtools as
		| (NonNullable<typeof window.rnDevtools> & Partial<SimulatorStreamBridge>)
		| undefined;
	if (
		!candidate ||
		typeof candidate.setSimulatorStreamSubscriptions !== 'function' ||
		typeof candidate.subscribeSimulatorStreamFrames !== 'function' ||
		typeof candidate.subscribeSimulatorStreamStatus !== 'function'
	) {
		return null;
	}
	return candidate as SimulatorStreamBridge;
}

/**
 * Collapses many component-level requests into the one subscription set the
 * main process wants. `focus` beats `tile` for the same Simulator.
 */
export function resolveStreamSubscriptions(
	requests: Iterable<ScreenRequest>
): SimulatorStreamSubscription[] {
	const byUdid = new Map<string, SimulatorStreamQuality>();
	for (const request of requests) {
		const key = request.udid.toUpperCase();
		const current = byUdid.get(key);
		if (!current || (current === 'tile' && request.quality === 'focus')) {
			byUdid.set(key, request.quality);
		}
	}
	return [...byUdid.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([udid, quality]) => ({ udid, quality }));
}

export function SimulatorStreamProvider({ children }: { children: ReactNode }) {
	const bridge = useMemo(streamBridge, []);
	const [screens, setScreens] = useState<Map<string, LiveScreen>>(new Map());
	const [statuses, setStatuses] = useState<Map<string, SimulatorStreamStatus>>(
		new Map()
	);
	const requests = useRef(new Map<symbol, ScreenRequest>());
	const lastSent = useRef<string>('[]');
	const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const flush = useCallback(() => {
		if (!bridge) return;
		const next = resolveStreamSubscriptions(requests.current.values());
		const serialized = JSON.stringify(next);
		if (serialized === lastSent.current) return;
		lastSent.current = serialized;
		void bridge.setSimulatorStreamSubscriptions(next).catch(() => {
			// Let the next change retry; the renderer has no way to recover here.
			lastSent.current = '';
		});
	}, [bridge]);

	const scheduleFlush = useCallback(() => {
		if (debounce.current) clearTimeout(debounce.current);
		debounce.current = setTimeout(flush, SUBSCRIPTION_DEBOUNCE_MS);
	}, [flush]);

	const request = useCallback<SimulatorStreamRuntimeValue['request']>(
		(value) => {
			const token = Symbol('stream-request');
			requests.current.set(token, value);
			scheduleFlush();
			return () => {
				requests.current.delete(token);
				scheduleFlush();
			};
		},
		[scheduleFlush]
	);

	useEffect(() => {
		if (!bridge) return;
		const unsubscribeFrames = bridge.subscribeSimulatorStreamFrames(
			(frame, bytes) => {
				const key = frame.udid.toUpperCase();
				setScreens((current) => {
					const previous = current.get(key);
					if (previous && previous.frame.sequence >= frame.sequence) {
						return current;
					}
					// Copy into a fresh ArrayBuffer-backed view: the structured-clone
					// result may be a view over a larger (or shared) buffer.
					const copy = new Uint8Array(bytes.byteLength);
					copy.set(bytes);
					const url = URL.createObjectURL(
						new Blob([copy], { type: frame.mimeType })
					);
					if (previous) URL.revokeObjectURL(previous.url);
					const next = new Map(current);
					next.set(key, { url, frame });
					return next;
				});
			}
		);
		const unsubscribeStatus = bridge.subscribeSimulatorStreamStatus(
			(status) => {
				const key = status.udid.toUpperCase();
				setStatuses((current) => {
					const next = new Map(current);
					if (status.status === 'stopped') next.delete(key);
					else next.set(key, status);
					return next;
				});
				if (status.status === 'stopped') {
					setScreens((current) => {
						const previous = current.get(key);
						if (!previous) return current;
						URL.revokeObjectURL(previous.url);
						const next = new Map(current);
						next.delete(key);
						return next;
					});
				}
			}
		);
		return () => {
			unsubscribeFrames();
			unsubscribeStatus();
			if (debounce.current) clearTimeout(debounce.current);
			requests.current.clear();
			lastSent.current = '[]';
			void bridge.setSimulatorStreamSubscriptions([]).catch(() => undefined);
		};
	}, [bridge]);

	const value = useMemo<SimulatorStreamRuntimeValue>(
		() => ({ isAvailable: Boolean(bridge), screens, statuses, request }),
		[bridge, screens, statuses, request]
	);
	return (
		<SimulatorStreamContext.Provider value={value}>
			{children}
		</SimulatorStreamContext.Provider>
	);
}

function useSimulatorStream(): SimulatorStreamRuntimeValue {
	const value = useContext(SimulatorStreamContext);
	if (!value) {
		throw new Error(
			'useSimulatorStream must be used inside SimulatorStreamProvider.'
		);
	}
	return value;
}

/**
 * Subscribes to one Simulator's screen while `active` is true and returns the
 * latest frame. Components pass `active=false` for tiles that are scrolled
 * out of view, so a long wall only streams what is on screen.
 */
export function useLiveScreen(
	udid: string | undefined,
	quality: SimulatorStreamQuality,
	active: boolean
): {
	screen: LiveScreen | undefined;
	status: SimulatorStreamStatus | undefined;
} {
	const stream = useSimulatorStream();
	useEffect(() => {
		if (!udid || !active || !stream.isAvailable) return undefined;
		return stream.request({ udid, quality });
	}, [udid, quality, active, stream]);
	const key = udid?.toUpperCase();
	return {
		screen: key ? stream.screens.get(key) : undefined,
		status: key ? stream.statuses.get(key) : undefined,
	};
}
