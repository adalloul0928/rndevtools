import {
	diagnosticErrorText,
	redactDiagnosticText,
	truncateText,
	utf8ByteLength,
} from '@pumpd/devtools';
import {
	type DesktopDeviceAction,
	PUMPD_DESKTOP_PROTOCOL_VERSION,
	parseDesktopActionEnvelope,
} from '@pumpd/devtools/desktop-protocol';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import {
	capturePumpdDesktopTools,
	createPumpdDesktopDeviceInfo,
	type DesktopDiagnostic,
	runPumpdDesktopAction,
} from '@/features/dev-menu/desktop/desktop-snapshot';
import { isDevelopmentVariant } from '@/lib/app-variant';
import { getInternalToolsAuthorization } from '@/services/devtools/internal-tools-authorization';

const DEFAULT_PORT = 47_931;
const DEFAULT_PORT_ATTEMPTS = 10;
const CONNECT_TIMEOUT_MS = 3_500;
const SNAPSHOT_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const RETRY_DELAY_MS = 2_500;
const MAX_DIAGNOSTICS = 200;
const MAX_PROCESSED_ACTIONS = 200;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_INCOMING_MESSAGE_BYTES = 600 * 1024;
const MAX_OUTGOING_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_BROKER_URL_LENGTH = 8 * 1024;
const MAX_BROKER_CANDIDATES = 100;
const MAX_BROKER_TOKEN_LENGTH = 512;
const MIN_REMOTE_BROKER_TOKEN_LENGTH = 16;
const MAX_PENDING_DESKTOP_ACTIONS = 16;
const MAX_DESKTOP_ACTIONS_PER_WINDOW = 60;
const DESKTOP_ACTION_RATE_WINDOW_MS = 10_000;

type ActionResultMessage = {
	type: 'action-result';
	actionId: string;
	ok: boolean;
	error?: string;
};

type ProcessedAction = {
	fingerprint: string;
	result: ActionResultMessage;
};

type ActionReplayLookup =
	| { kind: 'new' }
	| { kind: 'replay'; result: ActionResultMessage }
	| { kind: 'conflict' };

export class DesktopActionReplayCache {
	readonly #maxEntries: number;
	readonly #entries = new Map<string, ProcessedAction>();

	constructor(maxEntries = MAX_PROCESSED_ACTIONS) {
		if (!Number.isInteger(maxEntries) || maxEntries < 1) {
			throw new Error('maxEntries must be a positive integer.');
		}
		this.#maxEntries = maxEntries;
	}

	lookup(action: DesktopDeviceAction): ActionReplayLookup {
		const processed = this.#entries.get(action.actionId);
		if (!processed) return { kind: 'new' };
		return processed.fingerprint === JSON.stringify(action)
			? { kind: 'replay', result: processed.result }
			: { kind: 'conflict' };
	}

	remember(action: DesktopDeviceAction, result: ActionResultMessage): void {
		this.#entries.set(action.actionId, {
			fingerprint: JSON.stringify(action),
			result,
		});
		while (this.#entries.size > this.#maxEntries) {
			const oldest = this.#entries.keys().next().value;
			if (typeof oldest !== 'string') break;
			this.#entries.delete(oldest);
		}
	}
}

type DesktopActionAdmission =
	| { accepted: false; reason: 'queue-full' | 'rate-limited' }
	| { accepted: true; release: () => void };

export class DesktopActionAdmissionController {
	readonly #maxPending: number;
	readonly #maxPerWindow: number;
	readonly #windowMs: number;
	readonly #now: () => number;
	readonly #acceptedAt: number[] = [];
	#pending = 0;

	constructor({
		maxPending = MAX_PENDING_DESKTOP_ACTIONS,
		maxPerWindow = MAX_DESKTOP_ACTIONS_PER_WINDOW,
		windowMs = DESKTOP_ACTION_RATE_WINDOW_MS,
		now = Date.now,
	}: {
		maxPending?: number;
		maxPerWindow?: number;
		windowMs?: number;
		now?: () => number;
	} = {}) {
		if (!Number.isInteger(maxPending) || maxPending < 1) {
			throw new Error('maxPending must be a positive integer.');
		}
		if (!Number.isInteger(maxPerWindow) || maxPerWindow < 1) {
			throw new Error('maxPerWindow must be a positive integer.');
		}
		if (!Number.isFinite(windowMs) || windowMs <= 0) {
			throw new Error('windowMs must be a positive finite number.');
		}
		this.#maxPending = maxPending;
		this.#maxPerWindow = maxPerWindow;
		this.#windowMs = windowMs;
		this.#now = now;
	}

	admit(): DesktopActionAdmission {
		const now = this.#now();
		const cutoff = now - this.#windowMs;
		while ((this.#acceptedAt[0] ?? Number.POSITIVE_INFINITY) <= cutoff) {
			this.#acceptedAt.shift();
		}
		if (this.#pending >= this.#maxPending) {
			return { accepted: false, reason: 'queue-full' };
		}
		if (this.#acceptedAt.length >= this.#maxPerWindow) {
			return { accepted: false, reason: 'rate-limited' };
		}

		this.#acceptedAt.push(now);
		this.#pending += 1;
		let released = false;
		return {
			accepted: true,
			release: () => {
				if (released) return;
				released = true;
				this.#pending = Math.max(0, this.#pending - 1);
			},
		};
	}
}

function hostFromUri(value: string | undefined): string | undefined {
	if (!value || value.length > MAX_BROKER_URL_LENGTH) return undefined;
	try {
		return new URL(value.includes('://') ? value : `http://${value}`).hostname;
	} catch {
		return undefined;
	}
}

function socketUrl(host: string, port: number): string {
	const displayHost =
		host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
	return `ws://${displayHost}:${port}/device`;
}

function isLocalBrokerHost(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return (
		normalized === 'localhost' ||
		normalized === '127.0.0.1' ||
		normalized === '::1' ||
		normalized === '0:0:0:0:0:0:0:1' ||
		normalized === '10.0.2.2'
	);
}

function isLoopbackBrokerHost(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return (
		normalized === 'localhost' ||
		normalized === '127.0.0.1' ||
		normalized === '::1' ||
		normalized === '0:0:0:0:0:0:0:1'
	);
}

function normalizeExplicitUrl(
	value: string,
	{ allowAndroidEmulatorAlias = false } = {}
): string | undefined {
	if (!value || value.length > MAX_BROKER_URL_LENGTH) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined;
		if (url.username || url.password || url.hash) return undefined;
		const isLoopback = isLoopbackBrokerHost(url.hostname);
		const isTrustedEmulatorAlias =
			allowAndroidEmulatorAlias && url.hostname === '10.0.2.2';
		if (url.protocol === 'ws:' && !isLoopback && !isTrustedEmulatorAlias) {
			return undefined;
		}
		if (url.pathname === '/' || url.pathname === '') url.pathname = '/device';
		if (url.pathname !== '/device') return undefined;
		for (const name of url.searchParams.keys()) {
			if (name !== 'token') return undefined;
		}
		const tokens = url.searchParams.getAll('token');
		if (
			tokens.length > 1 ||
			tokens.some((token) => !token || token.length > MAX_BROKER_TOKEN_LENGTH)
		) {
			return undefined;
		}
		if (
			!isLoopback &&
			!isTrustedEmulatorAlias &&
			(tokens[0]?.length ?? 0) < MIN_REMOTE_BROKER_TOKEN_LENGTH
		) {
			return undefined;
		}
		const normalized = url.toString();
		return normalized.length <= MAX_BROKER_URL_LENGTH ? normalized : undefined;
	} catch {
		return undefined;
	}
}

function socketDiagnosticLabel(value: string): string {
	try {
		const url = new URL(value);
		const hadQuery = url.search.length > 0;
		url.search = '';
		return `${redactDiagnosticText(url.toString())}${hadQuery ? '?<redacted>' : ''}`;
	} catch {
		return 'configured desktop broker';
	}
}

export function pumpdDesktopBrokerCandidates({
	explicitUrl = process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_URL,
	hostUri = Constants.expoConfig?.hostUri,
	platform = Platform.OS,
	isEmulator = Device.isDevice === false,
	port = DEFAULT_PORT,
	portAttempts = DEFAULT_PORT_ATTEMPTS,
}: {
	explicitUrl?: string;
	hostUri?: string;
	platform?: string;
	isEmulator?: boolean;
	port?: number;
	portAttempts?: number;
} = {}): string[] {
	if (explicitUrl) {
		const normalized = normalizeExplicitUrl(explicitUrl);
		return normalized ? [normalized] : [];
	}
	const hosts = [
		hostFromUri(hostUri),
		// 10.0.2.2 is the host loopback alias *inside an Android emulator*. On a
		// physical phone it is an ordinary routable RFC1918 address, so sweeping it
		// would offer a full unauthenticated diagnostic snapshot to whatever
		// machine happens to hold it on the developer's network.
		platform === 'android' && isEmulator ? '10.0.2.2' : undefined,
		'127.0.0.1',
		'localhost',
	].filter(
		(host): host is string => Boolean(host) && isLocalBrokerHost(host ?? '')
	);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) return [];
	const attempts = Number.isFinite(portAttempts)
		? Math.max(1, Math.min(10, Math.floor(portAttempts)))
		: DEFAULT_PORT_ATTEMPTS;
	const ports = Array.from(
		{ length: attempts },
		(_, index) => port + index
	).filter((candidate) => candidate <= 65_535);
	const uniqueHosts = [...new Set(hosts)];
	return ports.flatMap((candidate) =>
		uniqueHosts.map((host) => socketUrl(host, candidate))
	);
}

/**
 * Internal tools are also enabled for `preview`, but a preview build runs on
 * testers' devices where no broker exists and `hostUri` is undefined, so
 * discovery would sweep every loopback candidate for the whole session. Keeping
 * the client on development builds also confines the unauthenticated loopback
 * socket to machines the developer controls.
 */
export function shouldStartPumpdDesktopClient(): boolean {
	return (
		isDevelopmentVariant() &&
		process.env.NODE_ENV !== 'test' &&
		process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED !== 'true'
	);
}

export type PumpdDesktopClientHandle = {
	stop: () => void;
};

export function startPumpdDesktopClient(
	candidates?: readonly string[]
): PumpdDesktopClientHandle {
	const allowAndroidEmulatorAlias =
		candidates === undefined &&
		!process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_URL &&
		Platform.OS === 'android';
	const requestedCandidates = candidates ?? pumpdDesktopBrokerCandidates();
	const brokerCandidates = [
		...new Set(
			requestedCandidates
				.slice(0, MAX_BROKER_CANDIDATES)
				.flatMap((candidate) => {
					const normalized = normalizeExplicitUrl(candidate, {
						allowAndroidEmulatorAlias,
					});
					return normalized ? [normalized] : [];
				})
		),
	];
	let active = true;
	let candidateIndex = 0;
	let sequence = 0;
	let diagnosticSequence = 0;
	let socket: WebSocket | undefined;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let connectTimer: ReturnType<typeof setTimeout> | undefined;
	let snapshotTimer: ReturnType<typeof setInterval> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let actionQueue = Promise.resolve();
	let backpressureReported = false;
	const diagnostics: DesktopDiagnostic[] = [];
	const processedActions = new DesktopActionReplayCache();
	const actionAdmission = new DesktopActionAdmissionController();
	const device = createPumpdDesktopDeviceInfo();

	const record = (
		level: DesktopDiagnostic['level'],
		scope: string,
		message: string
	) => {
		const at = Date.now();
		const safeMessage = redactDiagnosticText(message);
		diagnosticSequence += 1;
		diagnostics.push({
			id: `desktop-client-${at}-${diagnosticSequence}`,
			at,
			level,
			scope,
			message: truncateText(safeMessage, 4_096).text,
		});
		if (diagnostics.length > MAX_DIAGNOSTICS) {
			diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
		}
	};

	const clearConnectionTimers = () => {
		if (connectTimer) clearTimeout(connectTimer);
		if (snapshotTimer) clearInterval(snapshotTimer);
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		connectTimer = undefined;
		snapshotTimer = undefined;
		heartbeatTimer = undefined;
	};

	const sendSerialized = (serialized: string, target = socket): boolean => {
		if (!active || !target || socket !== target || target.readyState !== 1) {
			return false;
		}
		try {
			target.send(serialized);
			return true;
		} catch (error) {
			record(
				'warn',
				'transport',
				`Failed to send desktop message: ${diagnosticErrorText(error)}`
			);
			return false;
		}
	};

	const send = (message: unknown, target = socket): boolean => {
		try {
			return sendSerialized(JSON.stringify(message), target);
		} catch (error) {
			record(
				'warn',
				'transport',
				`Failed to serialize desktop message: ${diagnosticErrorText(error)}`
			);
			return false;
		}
	};

	const sendSnapshot = (target = socket) => {
		if (!target || socket !== target || target.readyState !== 1) return;
		if (target.bufferedAmount > MAX_BUFFERED_BYTES) {
			if (!backpressureReported) {
				backpressureReported = true;
				record(
					'warn',
					'transport',
					'Desktop snapshot skipped while the socket send buffer drains.'
				);
			}
			return;
		}
		backpressureReported = false;
		const nextSequence = sequence + 1;
		try {
			const serialized = JSON.stringify({
				type: 'snapshot',
				sequence: nextSequence,
				sentAt: Date.now(),
				tools: capturePumpdDesktopTools(diagnostics),
			});
			if (utf8ByteLength(serialized) > MAX_OUTGOING_SNAPSHOT_BYTES) {
				record(
					'error',
					'snapshot',
					'Desktop snapshot exceeded the 8 MiB wire budget and was not sent.'
				);
				return;
			}
			if (sendSerialized(serialized, target)) {
				sequence = nextSequence;
			}
		} catch (error) {
			record(
				'error',
				'snapshot',
				`Snapshot capture failed: ${diagnosticErrorText(error)}`
			);
		}
	};

	const handleAction = async (
		action: DesktopDeviceAction,
		target: WebSocket,
		expectedOwnerId: string | null
	) => {
		if (!active || socket !== target || target.readyState !== 1) return;
		const authorization = getInternalToolsAuthorization();
		if (!authorization.enabled || authorization.ownerId !== expectedOwnerId) {
			const result: ActionResultMessage = {
				type: 'action-result',
				actionId: action.actionId,
				ok: false,
				error: 'Internal tools authorization changed before execution.',
			};
			send(result, target);
			return;
		}
		const processed = processedActions.lookup(action);
		if (processed.kind !== 'new') {
			send(
				processed.kind === 'replay'
					? processed.result
					: {
							type: 'action-result',
							actionId: action.actionId,
							ok: false,
							error: 'Action identifier was reused with different contents.',
						},
				target
			);
			return;
		}
		let result: ActionResultMessage;
		try {
			await runPumpdDesktopAction(action);
			record(
				'info',
				action.tool,
				`Desktop action completed: ${action.command}.`
			);
			result = {
				type: 'action-result',
				actionId: action.actionId,
				ok: true,
			};
		} catch (error) {
			const message = truncateText(diagnosticErrorText(error), 4_096).text;
			record('warn', action.tool, `Desktop action rejected: ${message}`);
			result = {
				type: 'action-result',
				actionId: action.actionId,
				ok: false,
				error: message,
			};
		}
		processedActions.remember(action, result);
		send(result, target);
		sendSnapshot(target);
	};

	const scheduleReconnect = (delay: number) => {
		if (!active || brokerCandidates.length === 0 || reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			connect();
		}, delay);
	};

	const connect = () => {
		if (!active || socket || brokerCandidates.length === 0) return;
		const currentCandidateIndex = candidateIndex % brokerCandidates.length;
		const url = brokerCandidates[currentCandidateIndex];
		if (!url) return;
		const urlLabel = socketDiagnosticLabel(url);
		let nextSocket: WebSocket;
		try {
			nextSocket = new WebSocket(url);
		} catch (error) {
			record(
				'warn',
				'transport',
				`Could not open ${urlLabel}: ${diagnosticErrorText(error)}`
			);
			candidateIndex = (currentCandidateIndex + 1) % brokerCandidates.length;
			scheduleReconnect(candidateIndex === 0 ? RETRY_DELAY_MS : 100);
			return;
		}
		socket = nextSocket;
		let opened = false;
		connectTimer = setTimeout(() => {
			if (!opened && socket === nextSocket) {
				socket = undefined;
				connectTimer = undefined;
				candidateIndex = (currentCandidateIndex + 1) % brokerCandidates.length;
				try {
					nextSocket.close();
				} catch (error) {
					record(
						'warn',
						'transport',
						`Timed-out socket could not close: ${diagnosticErrorText(error)}`
					);
				}
				if (candidateIndex === 0) {
					record(
						'warn',
						'transport',
						'Could not reach a desktop broker candidate; retrying discovery.'
					);
				}
				scheduleReconnect(candidateIndex === 0 ? RETRY_DELAY_MS : 100);
			}
		}, CONNECT_TIMEOUT_MS);

		nextSocket.onopen = () => {
			if (!active || socket !== nextSocket) {
				try {
					nextSocket.close(1000, 'stale desktop connection');
				} catch {
					// The connection is already detached from the diagnostics client.
				}
				return;
			}
			opened = true;
			if (connectTimer) clearTimeout(connectTimer);
			connectTimer = undefined;
			candidateIndex = currentCandidateIndex;
			record('info', 'transport', `Connected to ${urlLabel}.`);
			const sentHello = send(
				{
					type: 'hello',
					protocolVersion: PUMPD_DESKTOP_PROTOCOL_VERSION,
					device,
				},
				nextSocket
			);
			if (!sentHello) {
				nextSocket.close(1011, 'hello could not be sent');
				return;
			}
			sendSnapshot(nextSocket);
			snapshotTimer = setInterval(
				() => sendSnapshot(nextSocket),
				SNAPSHOT_INTERVAL_MS
			);
			heartbeatTimer = setInterval(() => {
				send({ type: 'heartbeat', sentAt: Date.now() }, nextSocket);
			}, HEARTBEAT_INTERVAL_MS);
		};

		nextSocket.onmessage = (event) => {
			if (typeof event.data !== 'string') return;
			if (utf8ByteLength(event.data) > MAX_INCOMING_MESSAGE_BYTES) {
				record('warn', 'protocol', 'Rejected an oversized desktop action.');
				try {
					nextSocket.close(1009, 'desktop action too large');
				} catch {
					// The transport may already be closing after the oversized message.
				}
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(event.data);
			} catch {
				record('warn', 'protocol', 'Ignored malformed desktop action JSON.');
				return;
			}
			const action = parseDesktopActionEnvelope(parsed);
			if (!action) {
				record('warn', 'protocol', 'Ignored an invalid desktop action.');
				return;
			}
			const authorization = getInternalToolsAuthorization();
			if (!authorization.enabled) {
				send(
					{
						type: 'action-result',
						actionId: action.actionId,
						ok: false,
						error: 'Internal tools are not authorized.',
					},
					nextSocket
				);
				try {
					nextSocket.close(1008, 'internal tools authorization required');
				} catch {
					// The transport may already be closing after the policy violation.
				}
				return;
			}
			const admission = actionAdmission.admit();
			if (!admission.accepted) {
				const queueFull = admission.reason === 'queue-full';
				record(
					'warn',
					'protocol',
					queueFull
						? 'Rejected a desktop action because the pending queue is full.'
						: 'Rejected a desktop action because the rate limit was exceeded.'
				);
				send(
					{
						type: 'action-result',
						actionId: action.actionId,
						ok: false,
						error: queueFull
							? 'Desktop action queue is full; retry later.'
							: 'Desktop action rate limit exceeded; retry later.',
					},
					nextSocket
				);
				try {
					nextSocket.close(1008, 'desktop action admission limit exceeded');
				} catch {
					// The transport may already be closing after the policy violation.
				}
				return;
			}
			actionQueue = actionQueue
				.catch(() => undefined)
				.then(() => handleAction(action, nextSocket, authorization.ownerId))
				.catch((error: unknown) => {
					record(
						'error',
						'action',
						`Desktop action processing failed: ${diagnosticErrorText(error)}`
					);
				})
				.finally(admission.release);
		};

		nextSocket.onerror = () => {
			if (opened)
				record('warn', 'transport', `Desktop socket error at ${urlLabel}.`);
		};

		nextSocket.onclose = () => {
			if (socket !== nextSocket) return;
			clearConnectionTimers();
			socket = undefined;
			if (!active) return;
			if (opened) record('warn', 'transport', `Disconnected from ${urlLabel}.`);
			if (opened) {
				scheduleReconnect(RETRY_DELAY_MS);
				return;
			}
			candidateIndex = (currentCandidateIndex + 1) % brokerCandidates.length;
			if (candidateIndex === 0) {
				record(
					'warn',
					'transport',
					'Could not reach a desktop broker candidate; retrying discovery.'
				);
			}
			scheduleReconnect(candidateIndex === 0 ? RETRY_DELAY_MS : 100);
		};
	};

	if (brokerCandidates.length === 0) {
		record(
			'error',
			'configuration',
			'No valid desktop broker URL is configured.'
		);
	} else {
		record('debug', 'transport', 'Desktop diagnostics client started.');
		connect();
	}

	return {
		stop: () => {
			active = false;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
			clearConnectionTimers();
			const activeSocket = socket;
			socket = undefined;
			if (activeSocket && activeSocket.readyState < 2) {
				try {
					activeSocket.close(1000, 'PUMPD internal tools unmounted');
				} catch {
					// Stopping diagnostics must never interrupt app teardown.
				}
			}
		},
	};
}
