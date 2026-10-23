import {
	type DesktopDeviceAction,
	type DesktopDeviceInfoSnapshot,
	type DesktopDeviceToolsSnapshot,
	RNDEVTOOLS_ACTION_TIMEOUTS_MS,
	RNDEVTOOLS_SNAPSHOT_EXTRA_LIMITS,
	RNDEVTOOLS_SNAPSHOT_LIMITS,
	RNDEVTOOLS_SNAPSHOT_NUMBER_LIMITS,
	RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS,
} from '@rndevtools/core/desktop-protocol';
import { utf8ByteLength } from '@rndevtools/core/serialize';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import {
	disableDevtoolsAuthorization,
	getDevtoolsAuthorization,
	setDevtoolsAuthorization,
	subscribeToDevtoolsAuthorization,
} from '../authorization';
import type {
	DesktopClientHandle,
	DesktopClientHost,
	DesktopDiagnostic,
} from './client';
import {
	DesktopActionAdmissionController,
	DesktopActionReplayCache,
	desktopBrokerCandidates,
	limitDesktopProjection,
	shouldStartDesktopClient,
	simulatorUdidFromPath,
	startDesktopClient,
} from './client';

// `./desktop` is the entry point a headless host module imports. It must not
// load the core plugins barrel, which pulls in the panel UI, or the camera's
// optional peers; either factory throws if anything reaches it.
jest.mock('@rndevtools/core/plugins', () => {
	throw new Error('The ./desktop entry point loaded @rndevtools/core/plugins.');
});
jest.mock('expo-file-system', () => {
	throw new Error('The ./desktop entry point loaded expo-file-system.');
});
// A pass-through spy, so a test can tell which strings the client walked to
// count their UTF-8 bytes.
jest.mock('@rndevtools/core/serialize', () => {
	const actual = jest.requireActual<
		typeof import('@rndevtools/core/serialize')
	>('@rndevtools/core/serialize');
	return { ...actual, utf8ByteLength: jest.fn(actual.utf8ByteLength) };
});

const mockUtf8ByteLength = jest.mocked(utf8ByteLength);
// The client's private size limits.
const MAX_INCOMING_BYTES = 600 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

const mockRunDesktopAction = jest.fn<
	Promise<void>,
	Parameters<DesktopClientHost['runAction']>
>();
const mockCaptureDesktopTools = jest.fn<
	DesktopDeviceToolsSnapshot,
	[readonly DesktopDiagnostic[]]
>(() => ({}) as never);

const testDevice: DesktopDeviceInfoSnapshot = {
	id: 'device-1',
	name: 'Test device',
	platform: 'ios',
	capabilities: ['console.clear'],
};

// The client is host-agnostic, so the suite injects a host rather than mocking
// a module. Anything a real app would supply is a plain function here.
const testHost: DesktopClientHost = {
	captureTools: mockCaptureDesktopTools,
	createDeviceInfo: () => testDevice,
	runAction: mockRunDesktopAction,
	getAuthorization: getDevtoolsAuthorization,
};

const BROKER_URL = 'ws://localhost:47931/device';

type CloseEvent = { code?: number; reason?: string };

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];

	readyState = 0;
	bufferedAmount = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event?: CloseEvent) => void) | null = null;
	send = jest.fn();
	close = jest.fn((code?: number, reason?: string) => {
		this.readyState = 3;
		this.onclose?.({ code: code ?? 1005, reason: reason ?? '' });
	});

	/** Every argument after the URL, exactly as the client passed them. */
	readonly connectionArguments: readonly unknown[];

	constructor(
		readonly url: string,
		...connectionArguments: unknown[]
	) {
		this.connectionArguments = connectionArguments;
		FakeWebSocket.instances.push(this);
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	receive(value: unknown): void {
		this.onmessage?.({ data: JSON.stringify(value) });
	}

	/** Delivers a frame exactly as given, without serializing it. */
	receiveFrame(data: string): void {
		this.onmessage?.({ data });
	}

	/** The broker ends the connection, as it does for a policy violation. */
	serverClose(code: number, reason: string): void {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
}

function latestSocket(): FakeWebSocket {
	const socket = FakeWebSocket.instances.at(-1);
	if (!socket) throw new Error('Expected the client to open a socket.');
	return socket;
}

function sentMessages(socket: FakeWebSocket): Record<string, unknown>[] {
	return socket.send.mock.calls.map(
		([message]) => JSON.parse(String(message)) as Record<string, unknown>,
	);
}

function actionResults(socket: FakeWebSocket): Record<string, unknown>[] {
	return sentMessages(socket).filter(
		(message) => message.type === 'action-result',
	);
}

function consoleClear(actionId: string, deviceId = 'device-1') {
	return {
		type: 'action',
		action: {
			actionId,
			deviceId,
			tool: 'console',
			command: 'clear',
			payload: {},
		},
	};
}

/** The diagnostics array the client hands to every snapshot capture. */
function clientDiagnosticMessages(): string[] {
	const diagnostics = mockCaptureDesktopTools.mock.calls[0]?.[0] ?? [];
	return diagnostics.map((diagnostic) => diagnostic.message);
}

async function flushPromises(): Promise<void> {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

/** Advances fake time until the client opens its next socket. */
async function reconnectDelayMs(): Promise<number> {
	const before = FakeWebSocket.instances.length;
	const start = Date.now();
	while (
		FakeWebSocket.instances.length === before &&
		Date.now() - start < 60_000
	) {
		await jest.advanceTimersByTimeAsync(100);
	}
	return Date.now() - start;
}

describe('desktop devtools broker discovery', () => {
	it('requires encryption and authentication for explicit remote endpoints', () => {
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://192.0.2.20:49000',
				hostUri: '10.0.0.3:8081',
				platform: 'android',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://192.0.2.20:49000?token=pairing-secret-123',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'wss://192.0.2.20:49000',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://10.0.2.2:49000',
			}),
		).toEqual([]);
	});

	it('rejects an explicit URL that is not a WebSocket transport', () => {
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'https://192.0.2.20:49000/device',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://user:password@192.0.2.20:49000/device',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://192.0.2.20:49000/device#fragment',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://192.0.2.20:49000/other',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://192.0.2.20:49000/device?password=private',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: `ws://localhost:49000/device?token=${'x'.repeat(513)}`,
			}),
		).toEqual([]);
	});

	it('omits the Android host alias on a physical device', () => {
		expect(
			desktopBrokerCandidates({
				hostUri: '192.168.1.20:8081',
				platform: 'android',
				isEmulator: false,
				port: 47932,
				portAttempts: 1,
			}),
		).toEqual(['ws://127.0.0.1:47932/device', 'ws://localhost:47932/device']);
	});

	it('keeps automatic discovery on local and emulator-safe addresses', () => {
		expect(
			desktopBrokerCandidates({
				hostUri: '192.168.1.20:8081',
				platform: 'android',
				isEmulator: true,
				port: 47932,
				portAttempts: 1,
			}),
		).toEqual([
			'ws://10.0.2.2:47932/device',
			'ws://127.0.0.1:47932/device',
			'ws://localhost:47932/device',
		]);

		expect(
			desktopBrokerCandidates({
				hostUri: 'localhost:8081',
				platform: 'ios',
				portAttempts: 1,
			}),
		).toEqual(['ws://localhost:47931/device', 'ws://127.0.0.1:47931/device']);
	});

	it('matches the desktop broker port fallback range', () => {
		expect(
			desktopBrokerCandidates({
				hostUri: undefined,
				platform: 'ios',
				port: 47931,
				portAttempts: 2,
			}),
		).toEqual([
			'ws://127.0.0.1:47931/device',
			'ws://localhost:47931/device',
			'ws://127.0.0.1:47932/device',
			'ws://localhost:47932/device',
		]);
	});

	it('preserves a token in an explicit broker URL', () => {
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'wss://192.0.2.20:49000?token=pairing-secret-123',
			}),
		).toEqual(['wss://192.0.2.20:49000/device?token=pairing-secret-123']);
	});
});

describe('DesktopActionAdmissionController', () => {
	it('bounds pending work and accepted actions per time window', () => {
		let now = 1_000;
		const controller = new DesktopActionAdmissionController({
			maxPending: 1,
			maxPerWindow: 2,
			windowMs: 1_000,
			now: () => now,
		});
		const first = controller.admit();
		expect(first.accepted).toBe(true);
		expect(controller.admit()).toEqual({
			accepted: false,
			reason: 'queue-full',
		});
		if (!first.accepted) throw new Error('Expected first action admission.');
		first.release();

		const second = controller.admit();
		expect(second.accepted).toBe(true);
		if (!second.accepted) throw new Error('Expected second action admission.');
		second.release();
		expect(controller.admit()).toEqual({
			accepted: false,
			reason: 'rate-limited',
		});

		now += 1_001;
		expect(controller.admit().accepted).toBe(true);
	});
});

describe('DesktopActionReplayCache', () => {
	const action: DesktopDeviceAction = {
		actionId: 'action-1',
		deviceId: 'device-1',
		tool: 'console',
		command: 'clear',
		payload: {},
	};

	it('replays matching results and rejects reused identifiers', () => {
		const cache = new DesktopActionReplayCache();
		const result = {
			type: 'action-result' as const,
			actionId: 'action-1',
			ok: true,
		};

		expect(cache.lookup(action)).toEqual({ kind: 'new' });
		cache.remember(action, result);
		expect(cache.lookup(action)).toEqual({ kind: 'replay', result });
		expect(cache.lookup({ ...action, tool: 'network' })).toEqual({
			kind: 'conflict',
		});
	});

	it('tells a replay from a conflict by fingerprint for large payloads', () => {
		const cache = new DesktopActionReplayCache();
		const fixture = (dataBase64: string): DesktopDeviceAction => ({
			actionId: 'fixture-1',
			deviceId: 'device-1',
			tool: 'camera',
			command: 'setFixture',
			payload: { kind: 'qr', dataBase64 },
		});
		const large = 'A'.repeat(64 * 1024);
		const result = {
			type: 'action-result' as const,
			actionId: 'fixture-1',
			ok: true,
		};

		cache.remember(fixture(large), result);

		expect(cache.lookup(fixture(large))).toEqual({ kind: 'replay', result });
		expect(cache.lookup(fixture(`${large.slice(0, -1)}B`))).toEqual({
			kind: 'conflict',
		});
		expect(cache.lookup(fixture(`${large}A`))).toEqual({ kind: 'conflict' });
	});

	it('bounds retained results and validates its limit', () => {
		const cache = new DesktopActionReplayCache(1);
		cache.remember(action, {
			type: 'action-result',
			actionId: action.actionId,
			ok: true,
		});
		const next = { ...action, actionId: 'action-2' };
		cache.remember(next, {
			type: 'action-result',
			actionId: next.actionId,
			ok: false,
		});

		expect(cache.lookup(action)).toEqual({ kind: 'new' });
		expect(() => new DesktopActionReplayCache(0)).toThrow('positive integer');
	});
});

describe('desktop client', () => {
	const runtime = globalThis as typeof globalThis & {
		WebSocket: typeof WebSocket;
	};
	const originalWebSocket = runtime.WebSocket;

	beforeEach(() => {
		FakeWebSocket.instances = [];
		runtime.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		mockRunDesktopAction.mockReset();
		mockCaptureDesktopTools.mockReset();
		mockCaptureDesktopTools.mockReturnValue({} as never);
	});

	afterEach(() => {
		disableDevtoolsAuthorization();
		runtime.WebSocket = originalWebSocket;
		jest.useRealTimers();
	});

	it('opens a loopback candidate with the default connection options', () => {
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});
		try {
			expect(latestSocket().url).toBe(BROKER_URL);
			expect(latestSocket().connectionArguments).toEqual([]);
		} finally {
			client.stop();
		}
	});

	describe('on an Android emulator', () => {
		// Discovery sweeps 10.0.2.2 only on an Android emulator, and the client
		// keeps it only when it discovered the candidates itself, so the alias is
		// reached through the defaults rather than an explicit candidate list.
		let replaced: { restore(): void }[] = [];

		beforeEach(() => {
			replaced = [
				jest.replaceProperty(Platform, 'OS', 'android'),
				jest.replaceProperty(Device, 'isDevice', false),
			];
		});

		afterEach(() => {
			for (const property of replaced) property.restore();
		});

		it('leaves an explicit candidate on the alias with the default options', () => {
			// An explicit URL is not the alias the client discovered itself; it
			// carries a token, which the broker checks instead of the origin.
			const client = startDesktopClient({
				host: testHost,
				candidates: ['wss://10.0.2.2:47931/device?token=0123456789abcdef'],
			});
			try {
				expect(latestSocket().url).toBe(
					'wss://10.0.2.2:47931/device?token=0123456789abcdef',
				);
				expect(latestSocket().connectionArguments).toEqual([]);
			} finally {
				client.stop();
			}
		});

		it('presents a loopback origin to the broker behind the host alias', async () => {
			jest.useFakeTimers();
			const client = startDesktopClient({ host: testHost });
			try {
				const alias = latestSocket();
				expect(alias.url).toBe('ws://10.0.2.2:47931/device');
				// React Native's third constructor argument. Without it the Android
				// transport sends `Origin: http://10.0.2.2:47931`, which the broker
				// refuses with 403 while it has no token.
				expect(alias.connectionArguments).toEqual([
					undefined,
					{ headers: { origin: 'http://127.0.0.1:47931' } },
				]);

				// The next candidate is the emulator's own loopback, where React
				// Native's default origin is already a loopback one.
				alias.serverClose(1006, '');
				await reconnectDelayMs();
				const loopback = latestSocket();
				expect(loopback.url).toBe('ws://127.0.0.1:47931/device');
				expect(loopback.connectionArguments).toEqual([]);
			} finally {
				client.stop();
			}
		});
	});

	it('rechecks the authorized owner before queued actions execute', async () => {
		let finishFirstAction: (() => void) | undefined;
		mockRunDesktopAction.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishFirstAction = resolve;
				}),
		);
		setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const socket = latestSocket();
			socket.open();
			socket.receive(consoleClear('first'));
			await flushPromises();
			expect(mockRunDesktopAction).toHaveBeenCalledTimes(1);

			socket.receive(consoleClear('second'));
			setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-b' });
			finishFirstAction?.();
			await flushPromises();

			expect(mockRunDesktopAction).toHaveBeenCalledTimes(1);
			expect(actionResults(socket)).toContainEqual(
				expect.objectContaining({
					actionId: 'second',
					ok: false,
					error: expect.stringContaining('authorization changed'),
				}),
			);
		} finally {
			client.stop();
		}
	});

	it.each([
		// Over in UTF-16 code units, so the client never counts its bytes.
		['in UTF-16 code units', 'x', 17, false],
		// Two bytes per character: within the budget in code units, over in bytes.
		['in UTF-8 bytes alone', 'é', 9, true],
	])(
		'refuses to send a snapshot over the aggregate wire budget %s',
		(_case, character, rows, counted) => {
			// Each message is as long as the desktop takes, since the client cuts
			// a longer one, so only the rows together are over the budget.
			const message = character.repeat(RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS.long);
			mockCaptureDesktopTools.mockReturnValueOnce({
				diagnostics: Array.from({ length: rows }, () => ({ message })),
			} as never);
			const client = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
			});

			try {
				const socket = latestSocket();
				mockUtf8ByteLength.mockClear();
				socket.open();
				expect(sentMessages(socket).map((sent) => sent.type)).toEqual([
					'hello',
				]);
				expect(clientDiagnosticMessages()).toContain(
					'Desktop snapshot exceeded the 8 MiB wire budget and was not sent.',
				);
				expect(
					mockUtf8ByteLength.mock.calls.some(([text]) =>
						text.startsWith('{"type":"snapshot"'),
					),
				).toBe(counted);
			} finally {
				client.stop();
			}
		},
	);

	it.each([
		// Over in UTF-16 code units, so the client never counts its bytes.
		['in UTF-16 code units', 'x'.repeat(MAX_INCOMING_BYTES + 1), false],
		// Two bytes per character: within the limit in code units, over in bytes.
		['in UTF-8 bytes alone', 'é'.repeat(MAX_INCOMING_BYTES / 2 + 1), true],
	])(
		'closes on an incoming frame over the size limit %s',
		(_case, frame, counted) => {
			const client = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
			});

			try {
				const socket = latestSocket();
				socket.open();
				mockUtf8ByteLength.mockClear();
				socket.receiveFrame(frame);

				expect(socket.close).toHaveBeenCalledWith(
					1009,
					'desktop action too large',
				);
				expect(clientDiagnosticMessages()).toContain(
					'Rejected an oversized desktop action.',
				);
				expect(
					mockUtf8ByteLength.mock.calls.some(([text]) => text === frame),
				).toBe(counted);
			} finally {
				client.stop();
			}
		},
	);

	it.each([
		['one-byte', 'x'.repeat(MAX_INCOMING_BYTES)],
		['two-byte', 'é'.repeat(MAX_INCOMING_BYTES / 2)],
	])(
		'reads an incoming frame of %s characters exactly at the size limit',
		(_case, frame) => {
			const client = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
			});

			try {
				const socket = latestSocket();
				socket.open();
				socket.receiveFrame(frame);

				expect(socket.close).not.toHaveBeenCalled();
				expect(clientDiagnosticMessages()).toContain(
					'Ignored malformed desktop action JSON.',
				);
			} finally {
				client.stop();
			}
		},
	);

	it.each([
		[
			'a capability the device does not advertise',
			{ deviceId: 'device-1', tool: 'network', command: 'clear' },
			'Device does not advertise network.clear.',
			'desktop action not advertised',
		],
		[
			'another device',
			{ deviceId: 'device-2', tool: 'console', command: 'clear' },
			'Desktop action targets a different device.',
			'desktop action for another device',
		],
	])(
		'refuses an action for %s without running it',
		async (_case, target, error, closeReason) => {
			setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
			const client = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
			});

			try {
				const socket = latestSocket();
				socket.open();
				socket.receive({
					type: 'action',
					action: { actionId: 'forged', payload: {}, ...target },
				});
				await flushPromises();

				expect(mockRunDesktopAction).not.toHaveBeenCalled();
				expect(actionResults(socket)).toEqual([
					{ type: 'action-result', actionId: 'forged', ok: false, error },
				]);
				expect(socket.close).toHaveBeenCalledWith(1008, closeReason);
			} finally {
				client.stop();
			}
		},
	);

	it('times out a host action that never settles and serves the next one', async () => {
		jest.useFakeTimers();
		let hungSignal: AbortSignal | undefined;
		mockRunDesktopAction
			.mockImplementationOnce((_action, { signal }) => {
				hungSignal = signal;
				return new Promise<void>(() => undefined);
			})
			.mockResolvedValueOnce(undefined);
		setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
			actionTimeoutMs: 1_000,
		});

		try {
			const socket = latestSocket();
			socket.open();
			socket.receive(consoleClear('hung'));
			socket.receive(consoleClear('next'));
			await jest.advanceTimersByTimeAsync(999);
			expect(actionResults(socket)).toEqual([]);
			expect(hungSignal?.aborted).toBe(false);

			await jest.advanceTimersByTimeAsync(2_000);

			expect(hungSignal?.aborted).toBe(true);
			expect(mockRunDesktopAction).toHaveBeenCalledTimes(2);
			expect(actionResults(socket)).toEqual([
				{
					type: 'action-result',
					actionId: 'hung',
					ok: false,
					error:
						'Desktop action timed out after 1000 ms; its outcome is unknown.',
				},
				{ type: 'action-result', actionId: 'next', ok: true },
			]);
		} finally {
			client.stop();
		}
	});

	describe('host action deadlines', () => {
		const scenarioHost: DesktopClientHost = {
			...testHost,
			createDeviceInfo: () => ({
				...testDevice,
				capabilities: ['console.clear', 'scenarios.execute'],
			}),
		};
		const scenarioExecute = (actionId: string) => ({
			type: 'action',
			action: {
				actionId,
				deviceId: 'device-1',
				tool: 'scenarios',
				command: 'execute',
				payload: { id: 'scenario', version: 1, definitionToken: 'token' },
			},
		});
		const timedOut = (actionId: string, ms: number) => ({
			type: 'action-result',
			actionId,
			ok: false,
			error: `Desktop action timed out after ${ms} ms; its outcome is unknown.`,
		});

		beforeEach(() => {
			jest.useFakeTimers();
			mockRunDesktopAction.mockImplementation(
				() => new Promise<void>(() => undefined),
			);
			setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
		});

		it('gives a quick command the time it is allowed, not a fixed longer one', async () => {
			const allowance = RNDEVTOOLS_ACTION_TIMEOUTS_MS['console.clear'];
			const client = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
			});
			try {
				const socket = latestSocket();
				socket.open();
				socket.receive(consoleClear('quick'));
				await jest.advanceTimersByTimeAsync(allowance - 1);
				expect(actionResults(socket)).toEqual([]);

				await jest.advanceTimersByTimeAsync(1);
				expect(actionResults(socket)).toEqual([timedOut('quick', allowance)]);
			} finally {
				client.stop();
			}
		});

		it('lets a scenario run take longer than any quick command', async () => {
			const allowance = RNDEVTOOLS_ACTION_TIMEOUTS_MS['scenarios.execute'];
			const client = startDesktopClient({
				host: scenarioHost,
				candidates: [BROKER_URL],
			});
			try {
				const socket = latestSocket();
				socket.open();
				socket.receive(scenarioExecute('long-scenario'));
				await jest.advanceTimersByTimeAsync(allowance - 1);
				expect(actionResults(socket)).toEqual([]);

				await jest.advanceTimersByTimeAsync(1);
				expect(actionResults(socket)).toEqual([
					timedOut('long-scenario', allowance),
				]);
			} finally {
				client.stop();
			}
		});

		it('treats actionTimeoutMs as a ceiling that shortens a command and never extends it', async () => {
			const allowance = RNDEVTOOLS_ACTION_TIMEOUTS_MS['console.clear'];
			const extended = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
				actionTimeoutMs: 60 * 60_000,
			});
			try {
				const socket = latestSocket();
				socket.open();
				socket.receive(consoleClear('capped-above'));
				await jest.advanceTimersByTimeAsync(allowance);
				expect(actionResults(socket)).toEqual([
					timedOut('capped-above', allowance),
				]);
			} finally {
				extended.stop();
			}

			FakeWebSocket.instances = [];
			const shortened = startDesktopClient({
				host: scenarioHost,
				candidates: [BROKER_URL],
				actionTimeoutMs: 2_000,
			});
			try {
				const socket = latestSocket();
				socket.open();
				socket.receive(scenarioExecute('capped-below'));
				await jest.advanceTimersByTimeAsync(2_000);
				expect(actionResults(socket)).toEqual([
					timedOut('capped-below', 2_000),
				]);
			} finally {
				shortened.stop();
			}
		});
	});

	it.each(['stop', 'disconnect'] as const)(
		'aborts an active host action and clears its deadline on %s',
		async (reason) => {
			jest.useFakeTimers();
			let signal: AbortSignal | undefined;
			mockRunDesktopAction.mockImplementationOnce((_action, context) => {
				signal = context.signal;
				return new Promise<void>(() => undefined);
			});
			setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
			const client = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
			});
			const socket = latestSocket();
			socket.open();
			socket.receive(consoleClear('pending-prompt'));
			await flushPromises();
			expect(signal?.aborted).toBe(false);

			if (reason === 'disconnect') socket.serverClose(1000, 'Broker closed');
			else client.stop();
			await flushPromises();

			expect(signal?.aborted).toBe(true);
			expect(jest.getTimerCount()).toBe(reason === 'disconnect' ? 1 : 0);
			expect(actionResults(socket)).toEqual([]);
			client.stop();
			expect(jest.getTimerCount()).toBe(0);
		},
	);

	describe('when authorization is revoked while an action runs', () => {
		const REVOKED_ERROR =
			'Internal tools authorization changed during execution; its outcome is unknown.';
		const REVOKED_DIAGNOSTIC =
			'Desktop action revoked: clear; internal tools authorization changed during execution.';
		const subscribingHost: DesktopClientHost = {
			...testHost,
			subscribeToAuthorization: subscribeToDevtoolsAuthorization,
		};

		it.each([
			['signs out', () => disableDevtoolsAuthorization()],
			[
				'changes owner',
				() => setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-b' }),
			],
		])(
			'aborts the action and reports an unknown outcome when the user %s',
			async (_change, revoke) => {
				jest.useFakeTimers();
				let signal: AbortSignal | undefined;
				let finish: (() => void) | undefined;
				mockRunDesktopAction.mockImplementationOnce((_action, context) => {
					signal = context.signal;
					return new Promise<void>((resolve) => {
						finish = resolve;
					});
				});
				setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
				const client = startDesktopClient({
					host: subscribingHost,
					candidates: [BROKER_URL],
					actionTimeoutMs: 1_000,
				});
				try {
					const socket = latestSocket();
					socket.open();
					socket.receive(consoleClear('running'));
					socket.receive(consoleClear('queued'));
					await flushPromises();
					expect(mockRunDesktopAction).toHaveBeenCalledTimes(1);
					expect(signal?.aborted).toBe(false);

					revoke();
					// The abort is synchronous with the host's notification.
					expect(signal?.aborted).toBe(true);
					await flushPromises();
					// A host that finishes anyway changes nothing.
					finish?.();
					await flushPromises();

					expect(actionResults(socket)).toEqual([
						{
							type: 'action-result',
							actionId: 'running',
							ok: false,
							error: REVOKED_ERROR,
						},
						{
							type: 'action-result',
							actionId: 'queued',
							ok: false,
							error: 'Internal tools authorization changed before execution.',
						},
					]);
					expect(mockRunDesktopAction).toHaveBeenCalledTimes(1);
					expect(clientDiagnosticMessages()).toContain(REVOKED_DIAGNOSTIC);
					// The deadline was cleared, so waiting past it sends nothing more.
					await jest.advanceTimersByTimeAsync(2_000);
					expect(actionResults(socket)).toHaveLength(2);
				} finally {
					client.stop();
				}
			},
		);

		it('reports a host that completes after revocation without a subscription', async () => {
			let signal: AbortSignal | undefined;
			let finish: (() => void) | undefined;
			mockRunDesktopAction.mockImplementationOnce((_action, context) => {
				signal = context.signal;
				return new Promise<void>((resolve) => {
					finish = resolve;
				});
			});
			setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
			const client = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
			});
			try {
				const socket = latestSocket();
				socket.open();
				socket.receive(consoleClear('running'));
				await flushPromises();

				disableDevtoolsAuthorization();
				// Nothing told the client, so the signal stays live until it settles.
				expect(signal?.aborted).toBe(false);
				finish?.();
				await flushPromises();

				expect(actionResults(socket)).toEqual([
					{
						type: 'action-result',
						actionId: 'running',
						ok: false,
						error: REVOKED_ERROR,
					},
				]);
				expect(clientDiagnosticMessages()).toContain(REVOKED_DIAGNOSTIC);
			} finally {
				client.stop();
			}
		});

		it('replays the revoked answer for a repeated action identifier', async () => {
			let finish: (() => void) | undefined;
			mockRunDesktopAction.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
			);
			setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
			const client = startDesktopClient({
				host: subscribingHost,
				candidates: [BROKER_URL],
			});
			try {
				const socket = latestSocket();
				socket.open();
				socket.receive(consoleClear('running'));
				await flushPromises();
				disableDevtoolsAuthorization();
				finish?.();
				await flushPromises();
				// The user signs back in, and the desktop sends the same action again.
				setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
				socket.receive(consoleClear('running'));
				await flushPromises();

				const revoked = {
					type: 'action-result',
					actionId: 'running',
					ok: false,
					error: REVOKED_ERROR,
				};
				expect(actionResults(socket)).toEqual([revoked, revoked]);
				expect(mockRunDesktopAction).toHaveBeenCalledTimes(1);
			} finally {
				client.stop();
			}
		});

		it('answers revocation even when the host rejects from its abort listener', async () => {
			mockRunDesktopAction.mockImplementationOnce(
				(_action, { signal }) =>
					new Promise<void>((_resolve, reject) => {
						signal.addEventListener('abort', () =>
							reject(new Error('Prompt dismissed.')),
						);
					}),
			);
			setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
			const client = startDesktopClient({
				host: subscribingHost,
				candidates: [BROKER_URL],
			});
			try {
				const socket = latestSocket();
				socket.open();
				socket.receive(consoleClear('prompt'));
				await flushPromises();

				disableDevtoolsAuthorization();
				await flushPromises();

				// One result, and it is the revocation, not the host's rejection.
				expect(actionResults(socket)).toEqual([
					{
						type: 'action-result',
						actionId: 'prompt',
						ok: false,
						error: REVOKED_ERROR,
					},
				]);
			} finally {
				client.stop();
			}
		});

		it('keeps running an action when the host reports a change that leaves its grant intact', async () => {
			let notify: (() => void) | undefined;
			let signal: AbortSignal | undefined;
			let finish: (() => void) | undefined;
			mockRunDesktopAction.mockImplementationOnce((_action, context) => {
				signal = context.signal;
				return new Promise<void>((resolve) => {
					finish = resolve;
				});
			});
			setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
			const client = startDesktopClient({
				host: {
					...testHost,
					subscribeToAuthorization: (listener) => {
						notify = listener;
						return () => undefined;
					},
				},
				candidates: [BROKER_URL],
			});
			try {
				const socket = latestSocket();
				socket.open();
				socket.receive(consoleClear('steady'));
				await flushPromises();

				notify?.();
				expect(signal?.aborted).toBe(false);
				finish?.();
				await flushPromises();

				expect(actionResults(socket)).toEqual([
					{ type: 'action-result', actionId: 'steady', ok: true },
				]);
			} finally {
				client.stop();
			}
		});

		it('treats a failed authorization read as a revocation', async () => {
			let signal: AbortSignal | undefined;
			mockRunDesktopAction.mockImplementationOnce((_action, context) => {
				signal = context.signal;
				return new Promise<void>(() => undefined);
			});
			setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
			let readFails = false;
			let notify: (() => void) | undefined;
			const client = startDesktopClient({
				host: {
					...testHost,
					getAuthorization: () => {
						if (readFails) throw new Error('Owner read failed.');
						return getDevtoolsAuthorization();
					},
					subscribeToAuthorization: (listener) => {
						notify = listener;
						return () => undefined;
					},
				},
				candidates: [BROKER_URL],
			});
			try {
				const socket = latestSocket();
				socket.open();
				socket.receive(consoleClear('running'));
				await flushPromises();

				readFails = true;
				notify?.();
				await flushPromises();

				expect(signal?.aborted).toBe(true);
				expect(actionResults(socket)).toEqual([
					{
						type: 'action-result',
						actionId: 'running',
						ok: false,
						error: REVOKED_ERROR,
					},
				]);
			} finally {
				client.stop();
			}
		});

		it.each(['stop', 'disconnect'] as const)(
			'neither answers nor forgets an action that %s aborts under a subscribing host',
			async (reason) => {
				jest.useFakeTimers();
				mockRunDesktopAction
					.mockImplementationOnce(() => new Promise<void>(() => undefined))
					.mockResolvedValueOnce(undefined);
				setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
				const client = startDesktopClient({
					host: subscribingHost,
					candidates: [BROKER_URL],
				});
				try {
					const first = latestSocket();
					first.open();
					first.receive(consoleClear('interrupted'));
					await flushPromises();

					if (reason === 'disconnect') first.serverClose(1000, 'Broker closed');
					else client.stop();
					await flushPromises();

					// Authorization never changed, so this is not a revocation.
					expect(actionResults(first)).toEqual([]);
					expect(clientDiagnosticMessages()).not.toContain(REVOKED_DIAGNOSTIC);
					if (reason === 'stop') return;

					// Nothing was remembered, so the same action sent on the next
					// connection runs again instead of replaying a revoked answer.
					await reconnectDelayMs();
					const second = latestSocket();
					second.open();
					second.receive(consoleClear('interrupted'));
					await flushPromises();
					expect(mockRunDesktopAction).toHaveBeenCalledTimes(2);
					expect(actionResults(second)).toEqual([
						{ type: 'action-result', actionId: 'interrupted', ok: true },
					]);
				} finally {
					client.stop();
				}
			},
		);

		it('unsubscribes when stopped and tolerates a subscription that throws', async () => {
			const unsubscribe = jest.fn();
			const subscribe = jest.fn(() => unsubscribe);
			const subscribed = startDesktopClient({
				host: { ...testHost, subscribeToAuthorization: subscribe },
				candidates: [BROKER_URL],
			});
			expect(subscribe).toHaveBeenCalledTimes(1);
			subscribed.stop();
			subscribed.stop();
			expect(unsubscribe).toHaveBeenCalledTimes(1);

			FakeWebSocket.instances = [];
			const unavailable = startDesktopClient({
				host: {
					...testHost,
					subscribeToAuthorization: () => {
						throw new Error('Authorization events are unavailable.');
					},
				},
				candidates: [BROKER_URL],
			});
			try {
				latestSocket().open();
				expect(clientDiagnosticMessages()).toContain(
					'Could not subscribe to authorization changes (Authorization events are unavailable.); a change during an action is detected when it settles.',
				);
			} finally {
				unavailable.stop();
			}
		});
	});

	it('rejects an action timeout a timer cannot represent', () => {
		let client: DesktopClientHandle | undefined;
		try {
			expect(() => {
				client = startDesktopClient({
					host: testHost,
					candidates: [BROKER_URL],
					actionTimeoutMs: 0,
				});
			}).toThrow('actionTimeoutMs');
			expect(FakeWebSocket.instances).toEqual([]);
		} finally {
			client?.stop();
		}
	});

	it('paces a burst of quick actions under the broker frame limit without dropping a result', async () => {
		jest.useFakeTimers();
		mockRunDesktopAction.mockResolvedValue(undefined);
		setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const socket = latestSocket();
			const sentAt: number[] = [];
			socket.send.mockImplementation(() => {
				sentAt.push(Date.now());
			});
			socket.open();
			const actionIds = Array.from(
				{ length: 6 },
				(_, index) => `burst-${index}`,
			);
			for (const actionId of actionIds) socket.receive(consoleClear(actionId));
			await jest.advanceTimersByTimeAsync(10_000);

			expect(socket.close).not.toHaveBeenCalled();
			expect(actionResults(socket)).toEqual(
				actionIds.map((actionId) => ({
					type: 'action-result',
					actionId,
					ok: true,
				})),
			);
			// The broker closes a device socket once one second holds 9 frames.
			const busiestSecond = Math.max(
				...sentAt.map(
					(start) =>
						sentAt.filter((at) => at >= start && at < start + 1_000).length,
				),
			);
			expect(busiestSecond).toBeLessThanOrEqual(8);
		} finally {
			client.stop();
		}
	});

	it('trims collections to the desktop row limits, keeping the newest rows', async () => {
		jest.useFakeTimers();
		const limit = RNDEVTOOLS_SNAPSHOT_LIMITS.network;
		mockCaptureDesktopTools.mockReturnValue({
			network: Array.from({ length: limit + 1 }, (_, index) => ({
				id: `request-${index}`,
			})),
		} as never);
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const socket = latestSocket();
			socket.open();
			await jest.advanceTimersByTimeAsync(3_000);

			const snapshots = sentMessages(socket).filter(
				(message) => message.type === 'snapshot',
			);
			expect(snapshots.length).toBeGreaterThan(1);
			const [first] = snapshots;
			if (!first) throw new Error('Expected a snapshot.');
			const { network } = first.tools as { network: { id: string }[] };
			expect(network).toHaveLength(limit);
			expect(network[0]).toEqual({ id: 'request-1' });
			expect(network.at(-1)).toEqual({ id: `request-${limit}` });
			expect(
				clientDiagnosticMessages().filter((message) =>
					message.startsWith('Trimmed network to 2000 rows'),
				),
			).toHaveLength(1);
		} finally {
			client.stop();
		}
	});

	it('fits nested lists, texts and numbers to what the desktop validates', async () => {
		jest.useFakeTimers();
		const sourceFiles = RNDEVTOOLS_SNAPSHOT_LIMITS.componentSourceFiles;
		const samples = RNDEVTOOLS_SNAPSHOT_LIMITS.performanceSamples;
		const depth = RNDEVTOOLS_SNAPSHOT_NUMBER_LIMITS.componentDepth;
		mockCaptureDesktopTools.mockReturnValue({
			components: [
				{
					id: 'component-1',
					name: 'n'.repeat(RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS.short + 1),
					depth: depth + 1,
					sourceFiles: Array.from(
						{ length: sourceFiles + 1 },
						(_, index) => `file-${index}.tsx`,
					),
				},
			],
			performance: {
				samples: Array.from({ length: samples + 1 }, (_, index) => ({
					id: `sample-${index}`,
					jsFps: 60,
				})),
			},
			scenarioRuntime: {
				running: true,
				active: {
					warnings: Array.from(
						{ length: RNDEVTOOLS_SNAPSHOT_EXTRA_LIMITS.scenarioWarnings + 1 },
						(_, index) => `warning-${index}`,
					),
				},
			},
		} as never);
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const socket = latestSocket();
			socket.open();
			await jest.advanceTimersByTimeAsync(3_000);

			const snapshots = sentMessages(socket).filter(
				(message) => message.type === 'snapshot',
			);
			expect(snapshots.length).toBeGreaterThan(1);
			const [first] = snapshots;
			if (!first) throw new Error('Expected a snapshot.');
			const tools = first.tools as {
				components: {
					name: string;
					depth: number;
					sourceFiles: string[];
				}[];
				performance: { samples: { id: string }[] };
				scenarioRuntime: { active: { warnings: string[] } };
			};
			const [component] = tools.components;
			expect(component?.sourceFiles).toHaveLength(sourceFiles);
			expect(component?.sourceFiles[0]).toBe('file-0.tsx');
			expect(component?.name).toBe(
				'n'.repeat(RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS.short),
			);
			expect(component?.depth).toBe(depth);
			// A chronological list keeps its newest rows, an ordered one its first.
			expect(tools.performance.samples).toHaveLength(samples);
			expect(tools.performance.samples[0]?.id).toBe('sample-1');
			expect(tools.performance.samples.at(-1)?.id).toBe(`sample-${samples}`);
			expect(tools.scenarioRuntime.active.warnings).toHaveLength(
				RNDEVTOOLS_SNAPSHOT_EXTRA_LIMITS.scenarioWarnings,
			);
			expect(tools.scenarioRuntime.active.warnings[0]).toBe('warning-0');

			const warnings = clientDiagnosticMessages().filter((message) =>
				message.startsWith('Trimmed '),
			);
			expect(warnings).toHaveLength(1);
			for (const change of [
				`components[].sourceFiles to ${sourceFiles} rows`,
				`components[].name to ${RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS.short} characters`,
				`components[].depth to 0..${depth}`,
				`performance.samples to ${samples} rows`,
				`scenarioRuntime.active.warnings to ${RNDEVTOOLS_SNAPSHOT_EXTRA_LIMITS.scenarioWarnings} rows`,
			]) {
				expect(warnings[0]).toContain(change);
			}
		} finally {
			client.stop();
		}
	});

	it('cuts one oversized text so the snapshot is still sent', async () => {
		jest.useFakeTimers();
		const limit = RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS.long;
		mockCaptureDesktopTools.mockReturnValue({
			diagnostics: [
				{ id: 'diagnostic-1', message: 'x'.repeat(MAX_SNAPSHOT_BYTES) },
			],
		} as never);
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const socket = latestSocket();
			socket.open();
			await jest.advanceTimersByTimeAsync(1_000);

			const snapshot = sentMessages(socket).find(
				(message) => message.type === 'snapshot',
			);
			const tools = snapshot?.tools as { diagnostics: { message: string }[] };
			expect(tools.diagnostics[0]?.message).toBe('x'.repeat(limit));
			expect(clientDiagnosticMessages()).toContain(
				`Trimmed diagnostics[].message to ${limit} characters in the desktop snapshot to fit its limits.`,
			);
		} finally {
			client.stop();
		}
	});

	it('names only the first few changes in a warning, and how many more', async () => {
		jest.useFakeTimers();
		const long = 'x'.repeat(RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS.long + 1);
		const row = {
			id: 'request-1',
			url: long,
			path: long,
			requestBody: long,
			responseBody: long,
			error: long,
			host: long,
			contentType: long,
			source: long,
		};
		mockCaptureDesktopTools.mockReturnValue({ network: [row] } as never);
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const socket = latestSocket();
			socket.open();
			await jest.advanceTimersByTimeAsync(3_000);

			// Eight texts are over, and the warning names six of them.
			const warnings = clientDiagnosticMessages().filter((message) =>
				message.startsWith('Trimmed '),
			);
			expect(warnings).toHaveLength(1);
			const [warning = ''] = warnings;
			const { long, short } = RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS;
			const start = `Trimmed network[].url to ${long} characters, network[].host to ${short} characters, `;
			expect(warning.slice(0, start.length)).toBe(start);
			expect(warning.split(' characters')).toHaveLength(7);
			expect(
				warning.endsWith(
					' and 2 more in the desktop snapshot to fit its limits.',
				),
			).toBe(true);
		} finally {
			client.stop();
		}
	});

	it('sends a snapshot that is within every bound as it is, with no warning', async () => {
		jest.useFakeTimers();
		const tools = {
			network: [{ id: 'request-1', url: 'https://example.com/items' }],
			components: [{ id: 'component-1', sourceFiles: ['App.tsx'] }],
		};
		mockCaptureDesktopTools.mockReturnValue(tools as never);
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const socket = latestSocket();
			socket.open();
			await jest.advanceTimersByTimeAsync(1_000);

			const snapshot = sentMessages(socket).find(
				(message) => message.type === 'snapshot',
			);
			expect(snapshot?.tools).toEqual(tools);
			expect(
				clientDiagnosticMessages().filter((message) =>
					message.startsWith('Trimmed '),
				),
			).toEqual([]);
		} finally {
			client.stop();
		}
	});

	it.each([
		['undefined', undefined],
		['null', null],
	])(
		'records a failed capture, not a frame, when captureTools returns %s',
		async (_name, returned) => {
			jest.useFakeTimers();
			mockCaptureDesktopTools.mockReturnValue(returned as never);
			const client = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
			});
			try {
				const socket = latestSocket();
				socket.open();
				await jest.advanceTimersByTimeAsync(1_500);

				expect(
					sentMessages(socket).filter((message) => message.type === 'snapshot'),
				).toEqual([]);
				expect(
					clientDiagnosticMessages().some((message) =>
						message.includes('captureTools returned no snapshot object'),
					),
				).toBe(true);
			} finally {
				client.stop();
			}
		},
	);

	it('backs off after consecutive broker rejections and reports why', async () => {
		jest.useFakeTimers();
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const delays: number[] = [];
			for (let attempt = 0; attempt < 4; attempt += 1) {
				const socket = latestSocket();
				socket.open();
				socket.serverClose(1008, 'invalid protocol message');
				delays.push(await reconnectDelayMs());
			}
			expect(delays).toEqual([2_500, 5_000, 10_000, 20_000]);
			expect(clientDiagnosticMessages()).toContain(
				`Disconnected from ${BROKER_URL} (1008: invalid protocol message); retrying in 20 s.`,
			);

			// A connection that stayed up long enough proves the device recovered.
			const healthy = latestSocket();
			healthy.open();
			await jest.advanceTimersByTimeAsync(10_000);
			healthy.serverClose(1008, 'device message rate limit exceeded');
			expect(await reconnectDelayMs()).toBe(2_500);
		} finally {
			client.stop();
		}
	});

	it('does not back off after closing a connection itself', async () => {
		jest.useFakeTimers();
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const delays: number[] = [];
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const socket = latestSocket();
				socket.open();
				// Unauthorized, so the client refuses and closes with 1008 itself.
				socket.receive(consoleClear(`unauthorized-${attempt}`));
				expect(socket.close).toHaveBeenCalledWith(
					1008,
					'internal tools authorization required',
				);
				delays.push(await reconnectDelayMs());
			}
			expect(delays).toEqual([2_500, 2_500, 2_500]);
		} finally {
			client.stop();
		}
	});
});

describe('desktop entry point', () => {
	it('gives a headless host its helpers without the plugins barrel', () => {
		expect(
			simulatorUdidFromPath(
				'/Users/dev/Library/Developer/CoreSimulator/Devices/0A1B2C3D-4E5F-6789-ABCD-EF0123456789/data/Documents',
			),
		).toBe('0A1B2C3D-4E5F-6789-ABCD-EF0123456789');
		expect(
			limitDesktopProjection([1, 2, 3], {
				maxItems: 2,
				maxBytes: 1_024,
				keepNewest: true,
			}),
		).toEqual({ items: [2, 3], omitted: 1 });
	});
});

describe('desktop client activation', () => {
	const originalNodeEnv = process.env.NODE_ENV;
	const originalDisabled = process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED;

	afterEach(() => {
		process.env.NODE_ENV = originalNodeEnv;
		process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED = originalDisabled;
	});

	it('never dials a broker from a preview build', () => {
		// Internal tools are enabled for preview too, but a tester's device has no
		// broker and no hostUri, so discovery would sweep loopback forever.
		process.env.NODE_ENV = 'development';

		expect(shouldStartDesktopClient({ isDevelopmentBuild: false })).toBe(false);
	});

	it('starts for a development build and honours the kill switch', () => {
		process.env.NODE_ENV = 'development';
		process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED = undefined;
		expect(shouldStartDesktopClient({ isDevelopmentBuild: true })).toBe(true);

		process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED = 'true';
		expect(shouldStartDesktopClient({ isDevelopmentBuild: true })).toBe(false);
	});

	it('stays inert under jest so suites never open sockets', () => {
		expect(process.env.NODE_ENV).toBe('test');
		expect(shouldStartDesktopClient({ isDevelopmentBuild: true })).toBe(false);
	});
});
