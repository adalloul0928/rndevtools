import type { DesktopDeviceAction } from '@pumpd/devtools/desktop-protocol';
import {
	DesktopActionAdmissionController,
	DesktopActionReplayCache,
	pumpdDesktopBrokerCandidates,
	shouldStartPumpdDesktopClient,
	startPumpdDesktopClient,
} from '@/features/dev-menu/desktop/desktop-client';
import {
	capturePumpdDesktopTools,
	runPumpdDesktopAction,
} from '@/features/dev-menu/desktop/desktop-snapshot';
import { isDevelopmentVariant } from '@/lib/app-variant';
import {
	disableInternalToolsAuthorization,
	setInternalToolsAuthorization,
} from '@/services/devtools/internal-tools-authorization';

jest.mock('@/features/dev-menu/desktop/desktop-snapshot', () => ({
	capturePumpdDesktopTools: jest.fn(() => ({})),
	createPumpdDesktopDeviceInfo: jest.fn(() => ({ id: 'device-1' })),
	runPumpdDesktopAction: jest.fn(),
}));

const mockRunPumpdDesktopAction = jest.mocked(runPumpdDesktopAction);
const mockCapturePumpdDesktopTools = jest.mocked(capturePumpdDesktopTools);

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];

	readyState = 0;
	bufferedAmount = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	send = jest.fn();
	close = jest.fn(() => {
		this.readyState = 3;
		this.onclose?.();
	});

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	receive(value: unknown): void {
		this.onmessage?.({ data: JSON.stringify(value) });
	}
}

async function flushPromises(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('desktop devtools broker discovery', () => {
	it('requires encryption and authentication for explicit remote endpoints', () => {
		expect(
			pumpdDesktopBrokerCandidates({
				explicitUrl: 'ws://192.168.1.20:49000',
				hostUri: '10.0.0.3:8081',
				platform: 'android',
			})
		).toEqual([]);
		expect(
			pumpdDesktopBrokerCandidates({
				explicitUrl: 'ws://192.168.1.20:49000?token=pairing-secret-123',
			})
		).toEqual([]);
		expect(
			pumpdDesktopBrokerCandidates({
				explicitUrl: 'wss://192.168.1.20:49000',
			})
		).toEqual([]);
		expect(
			pumpdDesktopBrokerCandidates({
				explicitUrl: 'ws://10.0.2.2:49000',
			})
		).toEqual([]);
	});

	it('rejects an explicit URL that is not a WebSocket transport', () => {
		expect(
			pumpdDesktopBrokerCandidates({
				explicitUrl: 'https://192.168.1.20:49000/device',
			})
		).toEqual([]);
		expect(
			pumpdDesktopBrokerCandidates({
				explicitUrl: 'ws://user:password@192.168.1.20:49000/device',
			})
		).toEqual([]);
		expect(
			pumpdDesktopBrokerCandidates({
				explicitUrl: 'ws://192.168.1.20:49000/device#fragment',
			})
		).toEqual([]);
		expect(
			pumpdDesktopBrokerCandidates({
				explicitUrl: 'ws://192.168.1.20:49000/other',
			})
		).toEqual([]);
		expect(
			pumpdDesktopBrokerCandidates({
				explicitUrl: 'ws://192.168.1.20:49000/device?password=private',
			})
		).toEqual([]);
		expect(
			pumpdDesktopBrokerCandidates({
				explicitUrl: `ws://localhost:49000/device?token=${'x'.repeat(513)}`,
			})
		).toEqual([]);
	});

	it('omits the Android host alias on a physical device', () => {
		expect(
			pumpdDesktopBrokerCandidates({
				hostUri: '192.168.1.20:8081',
				platform: 'android',
				isEmulator: false,
				port: 47932,
				portAttempts: 1,
			})
		).toEqual(['ws://127.0.0.1:47932/device', 'ws://localhost:47932/device']);
	});

	it('keeps automatic discovery on local and emulator-safe addresses', () => {
		expect(
			pumpdDesktopBrokerCandidates({
				hostUri: '192.168.1.20:8081',
				platform: 'android',
				isEmulator: true,
				port: 47932,
				portAttempts: 1,
			})
		).toEqual([
			'ws://10.0.2.2:47932/device',
			'ws://127.0.0.1:47932/device',
			'ws://localhost:47932/device',
		]);

		expect(
			pumpdDesktopBrokerCandidates({
				hostUri: 'localhost:8081',
				platform: 'ios',
				portAttempts: 1,
			})
		).toEqual(['ws://localhost:47931/device', 'ws://127.0.0.1:47931/device']);
	});

	it('matches the desktop broker port fallback range', () => {
		expect(
			pumpdDesktopBrokerCandidates({
				hostUri: undefined,
				platform: 'ios',
				port: 47931,
				portAttempts: 2,
			})
		).toEqual([
			'ws://127.0.0.1:47931/device',
			'ws://localhost:47931/device',
			'ws://127.0.0.1:47932/device',
			'ws://localhost:47932/device',
		]);
	});

	it('preserves a token in an explicit broker URL', () => {
		expect(
			pumpdDesktopBrokerCandidates({
				explicitUrl: 'wss://192.168.1.20:49000?token=pairing-secret-123',
			})
		).toEqual(['wss://192.168.1.20:49000/device?token=pairing-secret-123']);
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

describe('desktop action authorization', () => {
	const runtime = globalThis as typeof globalThis & {
		WebSocket: typeof WebSocket;
	};
	const originalWebSocket = runtime.WebSocket;

	beforeEach(() => {
		FakeWebSocket.instances = [];
		runtime.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		mockRunPumpdDesktopAction.mockReset();
		mockCapturePumpdDesktopTools.mockReset();
		mockCapturePumpdDesktopTools.mockReturnValue({} as never);
	});

	afterEach(() => {
		disableInternalToolsAuthorization();
		runtime.WebSocket = originalWebSocket;
	});

	it('rechecks the authorized owner before queued actions execute', async () => {
		let finishFirstAction: (() => void) | undefined;
		mockRunPumpdDesktopAction.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishFirstAction = resolve;
				})
		);
		setInternalToolsAuthorization({ enabled: true, ownerId: 'owner-a' });
		const client = startPumpdDesktopClient(['ws://localhost:47931/device']);

		try {
			const socket = FakeWebSocket.instances[0];
			expect(socket).toBeDefined();
			socket?.open();
			socket?.receive({
				type: 'action',
				action: {
					actionId: 'first',
					deviceId: 'device-1',
					tool: 'console',
					command: 'clear',
					payload: {},
				},
			});
			await flushPromises();
			expect(mockRunPumpdDesktopAction).toHaveBeenCalledTimes(1);

			socket?.receive({
				type: 'action',
				action: {
					actionId: 'second',
					deviceId: 'device-1',
					tool: 'console',
					command: 'clear',
					payload: {},
				},
			});
			setInternalToolsAuthorization({ enabled: true, ownerId: 'owner-b' });
			finishFirstAction?.();
			await flushPromises();

			expect(mockRunPumpdDesktopAction).toHaveBeenCalledTimes(1);
			const results = (socket?.send.mock.calls ?? [])
				.map(
					([message]) => JSON.parse(String(message)) as Record<string, unknown>
				)
				.filter((message) => message.type === 'action-result');
			expect(results).toContainEqual(
				expect.objectContaining({
					actionId: 'second',
					ok: false,
					error: expect.stringContaining('authorization changed'),
				})
			);
		} finally {
			client.stop();
		}
	});

	it('refuses to send a snapshot above the aggregate wire budget', () => {
		mockCapturePumpdDesktopTools.mockReturnValueOnce({
			diagnostics: [{ message: 'x'.repeat(8 * 1024 * 1024) }],
		} as never);
		const client = startPumpdDesktopClient(['ws://localhost:47931/device']);

		try {
			const socket = FakeWebSocket.instances[0];
			expect(socket).toBeDefined();
			socket?.open();
			const sentTypes = (socket?.send.mock.calls ?? []).map(
				([message]) => (JSON.parse(String(message)) as { type?: string }).type
			);
			expect(sentTypes).toEqual(['hello']);
		} finally {
			client.stop();
		}
	});
});

jest.mock('@/lib/app-variant', () => ({
	...jest.requireActual('@/lib/app-variant'),
	isDevelopmentVariant: jest.fn(() => true),
}));

const mockIsDevelopmentVariant = jest.mocked(isDevelopmentVariant);

describe('desktop client activation', () => {
	const originalNodeEnv = process.env.NODE_ENV;
	const originalDisabled = process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED;

	afterEach(() => {
		process.env.NODE_ENV = originalNodeEnv;
		process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED = originalDisabled;
		mockIsDevelopmentVariant.mockReturnValue(true);
	});

	it('never dials a broker from a preview build', () => {
		// Internal tools are enabled for preview too, but a tester's device has no
		// broker and no hostUri, so discovery would sweep loopback forever.
		process.env.NODE_ENV = 'development';
		mockIsDevelopmentVariant.mockReturnValue(false);

		expect(shouldStartPumpdDesktopClient()).toBe(false);
	});

	it('starts for a development build and honours the kill switch', () => {
		process.env.NODE_ENV = 'development';
		process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED = undefined;
		expect(shouldStartPumpdDesktopClient()).toBe(true);

		process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED = 'true';
		expect(shouldStartPumpdDesktopClient()).toBe(false);
	});

	it('stays inert under jest so suites never open sockets', () => {
		expect(process.env.NODE_ENV).toBe('test');
		expect(shouldStartPumpdDesktopClient()).toBe(false);
	});
});
