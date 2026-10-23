import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
	AgentCliCommand,
	AgentCliResponse,
	AgentUnverifiedCause,
} from '../shared/agent-cli-protocol';
import type { AgentOperation, AgentState } from '../shared/agent-protocol';
import { createDemoDevice } from '../shared/demo-data';
import {
	type DeviceRequester,
	decideDeviceAccess,
	resolveDeviceHolds,
} from '../shared/device-hold';
import {
	DEFAULT_LANE_ENVIRONMENTS,
	type Lane,
	type LaneOperation,
	type LaneOperationReceipt,
	type LaneState,
} from '../shared/lane-protocol';
import type {
	DesktopAction,
	DesktopState,
	DeviceSession,
} from '../shared/protocol';
import type {
	SimulatorAction,
	SimulatorState,
} from '../shared/simulator-protocol';
import { simulatorStateSchema } from '../shared/simulator-protocol';
import {
	SLIMMING_CONFIRMATIONS,
	type SlimmingAction,
	type SlimmingState,
	slimmingStateSchema,
} from '../shared/slimming-protocol';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
} from '../shared/supabase-demo-data';
import {
	type SupabaseAgentOperation,
	type SupabaseAgentResult,
	type SupabaseAgentStack,
	type SupabaseDoctorInfo,
	type SupabaseState,
	supabaseAgentRecovery,
} from '../shared/supabase-protocol';
import {
	AgentCliError,
	type AgentCliHandlerContext,
	AgentCliService,
} from './agent-cli-service';
import {
	type AgentCommandRouterDependencies,
	type AgentSupabasePort,
	createAgentCommandRouter,
} from './agent-command-router';
import { AgentService } from './agent-service';
import { NativeHostResponseError } from './native-host-client';
import type {
	SupabaseAgentContext,
	SupabaseReleaseResult,
} from './supabase/service-ports';

const UDID = '11111111-2222-3333-4444-555555555555';
const OTHER_UDID = 'BBBBBBBB-0000-4000-8000-000000000002';
const now = 1_800_000_000_000;

function desktopState(): DesktopState {
	const demo = createDemoDevice(now);
	return {
		protocolVersion: 2,
		broker: {
			status: 'listening',
			host: '127.0.0.1',
			port: 47_931,
			access: 'loopback',
			urls: ['ws://127.0.0.1:47931/device'],
		},
		devices: [
			{
				...demo,
				info: { ...demo.info, simulatorUdid: UDID },
			},
		],
		diagnostics: [],
	};
}

function simulatorState(): SimulatorState {
	return simulatorStateSchema.parse({
		revision: 1,
		updatedAt: now,
		capability: {
			status: 'available',
			platform: 'darwin',
			licenseStatus: 'accepted',
			hostArchitecture: 'arm64',
			runtimeAvailability: { total: 1, available: 1 },
			features: {
				deviceManagement: true,
				apps: true,
				deepLinks: true,
				location: true,
				push: true,
				privacy: true,
				ui: true,
				statusBar: true,
				keychain: true,
				screenshot: true,
				video: true,
			},
		},
		runtimes: [],
		deviceTypes: [],
		devices: [
			{
				udid: UDID,
				name: 'Agent Lane',
				state: 'booted',
				runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
				isAvailable: true,
			},
		],
		appsByDevice: { [UDID]: [] },
		diskByDevice: {},
		jobs: [],
		captures: [],
		metrics: { status: 'available', byDevice: {} },
		native: {
			status: 'available',
			permissionInspection: true,
			permissionPrompting: false,
			permissions: [],
		},
	});
}

function slimmingState(): SlimmingState {
	return slimmingStateSchema.parse({
		revision: 1,
		updatedAt: now,
		setting: { experimentalMutationsEnabled: false },
		helper: { status: 'available', readOnlyAvailable: true },
		categories: [],
		profiles: [],
		simulators: [],
		statusBySimulator: {},
		previewBySimulator: {},
		doctorBySimulator: {},
		jobs: [],
		checkpointBySimulator: {},
		operationsBySimulator: {},
	});
}

function fixture() {
	let desktop = desktopState();
	let simulator = simulatorState();
	let slimming = slimmingState();
	const dispatched: DesktopAction[] = [];
	const simulatorActions: SimulatorAction[] = [];
	const cancelledSimulatorJobs: string[] = [];
	const slimmingActions: SlimmingAction[] = [];
	const dependencies = {
		broker: {
			getState: () => desktop,
			dispatchAction: async (action: DesktopAction) => {
				dispatched.push(action);
				return { actionId: action.actionId, ok: true };
			},
		},
		simulator: {
			getState: () => simulator,
			refresh: async () => simulator,
			runAction: (action: SimulatorAction) => {
				simulatorActions.push(action);
				return {
					actionId: action.actionId,
					accepted: false,
					error: 'not exercised',
				};
			},
			cancelJob: (jobId: string) => {
				cancelledSimulatorJobs.push(jobId);
				return false;
			},
			subscribe: () => () => undefined,
		},
		slimming: {
			getState: () => slimming,
			refresh: async () => slimming,
			runAction: (action: SlimmingAction) => {
				slimmingActions.push(action);
				return {
					actionId: action.actionId,
					accepted: false,
					error: 'not exercised',
				};
			},
			cancelJob: () => false,
			subscribe: () => () => undefined,
		},
	};
	const handler = createAgentCommandRouter(dependencies);
	return {
		dependencies,
		handler,
		cancelledSimulatorJobs,
		dispatched,
		simulatorActions,
		slimmingActions,
		setDesktop: (value: DesktopState) => {
			desktop = value;
		},
		setSimulator: (value: SimulatorState) => {
			simulator = value;
		},
		setSlimming: (value: SlimmingState) => {
			slimming = value;
		},
	};
}

/** A request that claims no session: anonymous, which is not the operator. */
const context: AgentCliHandlerContext = {
	requestId: 'cli-0123456789abcdef0123456789abcdef',
	signal: new AbortController().signal,
	identity: { status: 'anonymous' },
};

/**
 * A request the desktop verified as coming from `agent`'s own process. The
 * desktop verifies only a Claude Code session it discovered with a process
 * under which the sender runs, and the id an MCP server makes up for itself
 * (`mcp-*`) is never one, so a fixture that claimed it verified would claim
 * what cannot happen. Other kinds are allowed here only so the router's access
 * rules can be exercised between two holders of different kinds.
 */
function from(
	agent: { kind: 'claude' | 'codex' | 'other'; sessionId: string },
	overrides: Partial<AgentCliHandlerContext> = {}
): AgentCliHandlerContext {
	if (agent.sessionId.startsWith('mcp-')) {
		throw new Error(`${agent.sessionId} is a shared MCP id: never verified.`);
	}
	return {
		...context,
		agent,
		identity: { status: 'verified', agent, basis: 'process' },
		...overrides,
	};
}

/** A request that names a session the desktop could not verify, for `cause`. */
function unverified(
	cause: AgentUnverifiedCause = 'no-session',
	overrides: Partial<AgentCliHandlerContext> = {}
): AgentCliHandlerContext {
	return {
		...context,
		identity: {
			status: 'unverified',
			cause,
			reason: `The sender was not proven (${cause}).`,
		},
		...overrides,
	};
}

/**
 * What the router answers a claim the desktop could not verify, by cause:
 * whether to retry, and what to do. The message is the identifier's reason,
 * passed through.
 */
const UNVERIFIED_REFUSALS = [
	{
		cause: 'no-proof',
		retryable: true,
		recovery:
			'Retry; if it keeps failing, update the tool with "rndevtools setup" and run it from inside the agent session.',
	},
	{ cause: 'no-process-table', retryable: true, recovery: 'Retry.' },
	{
		cause: 'no-session',
		retryable: false,
		recovery:
			'Ask the user to act in RN Devtools. A request that names no session may use free Simulators (for the CLI, run it without CODEX_THREAD_ID and RNDEVTOOLS_AGENT_SESSION_ID set).',
	},
] as const satisfies readonly {
	cause: AgentUnverifiedCause;
	retryable: boolean;
	recovery: string;
}[];

/** What a request that names no session is told by a command that needs one. */
const NO_AGENT_SESSION_RECOVERY =
	'This command needs a running Claude Code session; Codex and other agents cannot hold devices yet.';

/** The demo session, advertising the connected-app waits or not. */
function desktopStateWithWaits(advertised = true): DesktopState {
	const state = desktopState();
	return {
		...state,
		devices: state.devices.map((device): DeviceSession => {
			const others = device.info.capabilities.filter(
				(capability) => !capability.startsWith('components.wait')
			);
			return {
				...device,
				info: {
					...device.info,
					capabilities: advertised
						? [
								...others,
								'components.waitForElement',
								'components.waitForScreenChange',
							]
						: others,
				},
			};
		}),
	};
}

type Holder = { kind: 'claude' | 'codex' | 'other'; sessionId: string };

/**
 * Whom `owner`'s lane lets onto every device: itself and the operator. An
 * anonymous request is neither.
 */
function heldBy(owner: Holder) {
	return (udid: string, requester: DeviceRequester) =>
		requester === 'operator' ||
		(typeof requester !== 'string' &&
			requester.kind === owner.kind &&
			requester.sessionId === owner.sessionId)
			? ({ allowed: true } as const)
			: ({
					allowed: false,
					reason: `Simulator ${udid} is held by ${owner.kind} session ${owner.sessionId} through lane lane-1.`,
					hold: {
						simulatorUdid: udid,
						via: 'lane' as const,
						laneId: 'lane-1',
						holder: owner,
						holderLive: true,
					},
				} as const);
}

/** An agents port that only answers who may touch a device. */
function holdsOnlyAgents(owner: Holder) {
	return {
		getState: (): AgentState => {
			throw new Error('unused');
		},
		refresh: async (): Promise<AgentState> => {
			throw new Error('unused');
		},
		runOperation: async (): Promise<AgentState> => {
			throw new Error('unused');
		},
		touch: () => undefined,
		access: heldBy(owner),
	};
}

/** A simulator port whose recordings run until they are cancelled. */
function recordingSimulator() {
	let state = simulatorState();
	const listeners = new Set<(value: SimulatorState) => void>();
	const cancelled: string[] = [];
	const publish = (jobs: SimulatorState['jobs']) => {
		state = simulatorStateSchema.parse({ ...state, jobs });
		for (const listener of listeners) listener(state);
	};
	const port = {
		getState: () => state,
		refresh: async () => state,
		runAction: (action: SimulatorAction) => {
			const jobId = `simulator-recording-${state.jobs.length + 1}`;
			publish([
				...state.jobs,
				{
					id: jobId,
					actionId: action.actionId,
					kind: action.kind,
					...(action.kind === 'capture.video'
						? { deviceUdid: action.udid }
						: {}),
					status: 'running',
					progressSequence: 1,
					phase: 'executing',
					createdAt: now,
					startedAt: now,
					message: 'Recording.',
				},
			]);
			return { actionId: action.actionId, accepted: true, jobId };
		},
		cancelJob: (jobId: string) => {
			if (
				!state.jobs.some((job) => job.id === jobId && job.status === 'running')
			) {
				return false;
			}
			cancelled.push(jobId);
			queueMicrotask(() =>
				publish(
					state.jobs.map((job) =>
						job.id === jobId
							? {
									...job,
									status: 'cancelled',
									progressSequence: 2,
									phase: 'cancelled',
									finishedAt: now + 1,
									message: 'Recording stopped.',
								}
							: job
					)
				)
			);
			return true;
		},
		subscribe: (listener: (value: SimulatorState) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return { port, cancelled };
}

describe('agent command router', () => {
	it('projects local doctor and simulator state without host paths', async () => {
		const { handler } = fixture();
		const doctor = await handler({ kind: 'doctor' }, context);
		expect(doctor).toMatchObject({
			connectedDevices: 1,
			connectedSessions: [
				{
					deviceId: 'rndevtools-demo-ios',
					status: 'simulated',
					simulatorUdid: UDID,
				},
			],
			simulator: { status: 'available', platform: 'darwin' },
			slimming: { status: 'available', readOnlyAvailable: true },
		});
		expect(JSON.stringify(doctor)).not.toContain('/Users/');

		const fleet = await handler(
			{ kind: 'simulators', includeUnavailable: false },
			context
		);
		expect(fleet).toMatchObject({
			devices: [{ udid: UDID, name: 'Agent Lane' }],
		});
	});

	it('makes protocol-v1-style sessions discoverable by exact deviceId', async () => {
		const { handler, setDesktop } = fixture();
		const state = desktopState();
		const session = state.devices[0] as NonNullable<
			(typeof state.devices)[number]
		>;
		setDesktop({
			...state,
			devices: [
				{
					...session,
					info: { ...session.info, simulatorUdid: undefined },
				},
			],
		});

		const doctor = await handler({ kind: 'doctor' }, context);
		expect(doctor).toMatchObject({
			connectedSessions: [
				{
					deviceId: 'rndevtools-demo-ios',
					status: 'simulated',
				},
			],
		});
		expect(JSON.stringify(doctor)).not.toContain('simulatorUdid');

		await expect(
			handler(
				{ kind: 'screen', target: { deviceId: 'rndevtools-demo-ios' } },
				context
			)
		).resolves.toMatchObject({ device: { id: 'rndevtools-demo-ios' } });
	});

	it('resolves the exact Simulator session for semantic inspection', async () => {
		const { handler } = fixture();
		const screen = await handler(
			{ kind: 'screen', target: { udid: UDID } },
			context
		);
		expect(screen).toMatchObject({
			device: { simulatorUdid: UDID },
			status: 'simulated',
		});
		const elements = await handler(
			{ kind: 'elements', target: { udid: UDID }, query: 'button', limit: 10 },
			context
		);
		expect(elements).toHaveProperty('screenHash');
	});

	it('dispatches only already-validated semantic actions to the matching device', async () => {
		const { handler, dispatched } = fixture();
		await handler(
			{
				kind: 'act',
				target: { udid: UDID },
				action: {
					tool: 'components',
					command: 'waitForElement',
					payload: { id: 'sign-in', timeoutMs: 1_000 },
				},
			},
			context
		);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]).toMatchObject({
			deviceId: 'rndevtools-demo-ios',
			tool: 'components',
			command: 'waitForElement',
		});
	});

	it('honors long CLI waits through bounded connected-app slices', async () => {
		const { dependencies, setDesktop } = fixture();
		setDesktop(desktopStateWithWaits());
		const timeouts: number[] = [];
		let failures = 2;
		dependencies.broker.dispatchAction = async (action: DesktopAction) => {
			if (action.tool === 'components' && 'timeoutMs' in action.payload) {
				timeouts.push(Number(action.payload.timeoutMs));
			}
			if (failures > 0) {
				failures -= 1;
				return {
					actionId: action.actionId,
					ok: false,
					error: 'Wait slice elapsed.',
				};
			}
			return { actionId: action.actionId, ok: true };
		};
		const handler = createAgentCommandRouter(dependencies);
		await expect(
			handler(
				{
					kind: 'wait',
					target: { udid: UDID },
					condition: { kind: 'element', elementId: 'button' },
					timeoutMs: 60_000,
				},
				context
			)
		).resolves.toMatchObject({ ok: true });
		expect(timeouts).toEqual([5_000, 5_000, 5_000]);
	});

	it('spaces connected wait attempts with a timer, so failures answered at once never starve the event loop', async () => {
		const { dependencies, setDesktop } = fixture();
		setDesktop(desktopStateWithWaits());
		let attempts = 0;
		// The broker answers this without I/O, as it does while the app reloads.
		dependencies.broker.dispatchAction = async (action: DesktopAction) => {
			attempts += 1;
			return {
				actionId: action.actionId,
				ok: false,
				error: 'Device is offline.',
			};
		};
		const handler = createAgentCommandRouter(dependencies);
		const request = new AbortController();
		let timerFired = false;
		setTimeout(() => {
			timerFired = true;
		}, 50);
		setTimeout(() => request.abort(), 120);
		await expect(
			handler(
				{
					kind: 'wait',
					target: { udid: UDID },
					condition: { kind: 'element', elementId: 'button' },
					timeoutMs: 1_000,
				},
				{ ...context, signal: request.signal }
			)
		).rejects.toMatchObject({ code: 'cancelled' });
		expect(timerFired).toBe(true);
		expect(attempts).toBe(1);
	});

	it('ends a connected wait at once when the app does not advertise it or its session is gone', async () => {
		const { dependencies, dispatched, setDesktop } = fixture();
		const wait = {
			kind: 'wait' as const,
			target: { udid: UDID },
			condition: { kind: 'screen-change' as const, screenHash: 'screen-1' },
			timeoutMs: 30_000,
		};
		setDesktop(desktopStateWithWaits(false));
		await expect(
			createAgentCommandRouter(dependencies)(wait, context)
		).rejects.toMatchObject({
			code: 'capability_missing',
			retryable: false,
			message: expect.stringContaining('components.waitForScreenChange'),
		});
		expect(dispatched).toEqual([]);

		const state = desktopStateWithWaits();
		setDesktop(state);
		let attempts = 0;
		dependencies.broker.dispatchAction = async (action: DesktopAction) => {
			attempts += 1;
			setDesktop({ ...state, devices: [] });
			return { actionId: action.actionId, ok: false, error: 'Wait elapsed.' };
		};
		await expect(
			createAgentCommandRouter(dependencies)(wait, context)
		).rejects.toMatchObject({ code: 'target_not_found' });
		expect(attempts).toBe(1);
	});

	it('ends a wait with too little time left for a slice on its last failure, not a contract error', async () => {
		const { dependencies, setDesktop } = fixture();
		setDesktop(desktopStateWithWaits());
		const timeouts: number[] = [];
		dependencies.broker.dispatchAction = async (action: DesktopAction) => {
			timeouts.push(Number(action.payload.timeoutMs));
			return {
				actionId: action.actionId,
				ok: false,
				error: 'Another action is already pending for this device.',
			};
		};
		await expect(
			createAgentCommandRouter(dependencies)(
				{
					kind: 'wait',
					target: { udid: UDID },
					condition: { kind: 'element', elementId: 'button' },
					timeoutMs: 100,
				},
				context
			)
		).rejects.toMatchObject({
			code: 'action_failed',
			message: 'Another action is already pending for this device.',
		});
		expect(timeouts.length).toBeGreaterThan(0);
		expect(timeouts.every((timeoutMs) => timeoutMs >= 50)).toBe(true);
	});

	it('sets and clears only the app-scoped network profile through safe actions', async () => {
		const { handler, dispatched } = fixture();
		await handler(
			{
				kind: 'network',
				target: { udid: UDID },
				operation: 'set',
				profileId: 'lte',
			},
			context
		);
		await handler(
			{ kind: 'network', target: { udid: UDID }, operation: 'clear' },
			context
		);
		expect(dispatched).toHaveLength(2);
		expect(dispatched[0]).toMatchObject({
			tool: 'network',
			command: 'setProfile',
			payload: { profileId: 'lte' },
		});
		expect(dispatched[1]).toMatchObject({
			tool: 'network',
			command: 'clearProfile',
			payload: {},
		});
	});

	it('returns the verified file path with a completed capture when the port can resolve it', async () => {
		const job = {
			id: 'simulator-shot',
			actionId: 'agent-cli-0123456789abcdef0123456789abcdef-1',
			kind: 'capture.screenshot',
			deviceUdid: UDID,
			status: 'complete',
			progressSequence: 2,
			phase: 'complete',
			createdAt: now,
			startedAt: now,
			finishedAt: now + 1,
			message: 'Complete.',
			captureId: 'capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
		};
		const capture = {
			id: 'capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
			deviceUdid: UDID,
			kind: 'screenshot',
			status: 'complete',
			createdAt: now,
			name: 'shot',
			mimeType: 'image/png',
			bytes: 7,
		};
		const state = simulatorStateSchema.parse({
			...simulatorState(),
			jobs: [job],
			captures: [capture],
		});
		const resolved: string[] = [];
		const port = (withPath: boolean) => ({
			getState: () => state,
			refresh: async () => state,
			runAction: (action: SimulatorAction) => ({
				actionId: action.actionId,
				accepted: true,
				jobId: 'simulator-shot',
			}),
			cancelJob: () => false,
			subscribe: () => () => undefined,
			...(withPath
				? {
						verifiedCapturePath: async (captureId: string) => {
							resolved.push(captureId);
							return '/captures/capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.png';
						},
					}
				: {}),
		});
		const { dependencies } = fixture();
		const withPath = createAgentCommandRouter({
			...dependencies,
			simulator: port(true),
		});
		await expect(
			withPath({ kind: 'capture', udid: UDID, format: 'png' }, context)
		).resolves.toMatchObject({
			capture: { id: 'capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' },
			path: '/captures/capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.png',
		});
		expect(resolved).toEqual(['capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d']);

		const withoutPath = createAgentCommandRouter({
			...dependencies,
			simulator: port(false),
		});
		const result = (await withoutPath(
			{ kind: 'capture', udid: UDID, format: 'png' },
			context
		)) as Record<string, unknown>;
		expect(result).toMatchObject({
			capture: { id: 'capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' },
		});
		expect(result).not.toHaveProperty('path');
	});

	it('refuses to stop cross-target, non-video, or terminal jobs', async () => {
		const { cancelledSimulatorJobs, handler, setSimulator } = fixture();
		const state = simulatorState();
		setSimulator(
			simulatorStateSchema.parse({
				...state,
				jobs: [
					{
						id: 'simulator-non-video',
						actionId: 'capture-image',
						kind: 'capture.screenshot',
						deviceUdid: UDID,
						status: 'running',
						progressSequence: 1,
						phase: 'executing',
						createdAt: now,
						startedAt: now,
						message: 'Capturing.',
					},
					{
						id: 'simulator-cross-target',
						actionId: 'capture-video-other',
						kind: 'capture.video',
						deviceUdid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
						status: 'running',
						progressSequence: 1,
						phase: 'executing',
						createdAt: now,
						startedAt: now,
						message: 'Recording.',
					},
					{
						id: 'simulator-terminal-video',
						actionId: 'capture-video-complete',
						kind: 'capture.video',
						deviceUdid: UDID,
						status: 'complete',
						progressSequence: 2,
						phase: 'complete',
						createdAt: now,
						startedAt: now,
						finishedAt: now + 1,
						message: 'Complete.',
					},
				],
			})
		);

		for (const jobId of [
			'simulator-non-video',
			'simulator-cross-target',
			'simulator-terminal-video',
		]) {
			await expect(
				handler(
					{
						kind: 'record',
						operation: 'stop',
						udid: UDID,
						codec: 'h264',
						jobId,
					},
					context
				)
			).rejects.toMatchObject({ code: 'invalid_command' });
		}
		expect(cancelledSimulatorJobs).toEqual([]);
	});

	it('lets only the holder cancel jobs or stop a recording on a held device', async () => {
		const { cancelledSimulatorJobs, dependencies, setSimulator, setSlimming } =
			fixture();
		const owner = { kind: 'claude' as const, sessionId: 'owner' };
		const running = {
			progressSequence: 1,
			createdAt: now,
			startedAt: now,
			status: 'running' as const,
		};
		setSimulator(
			simulatorStateSchema.parse({
				...simulatorState(),
				jobs: [
					{
						...running,
						id: 'simulator-lane-boot',
						actionId: 'lane-boot',
						kind: 'device.boot',
						deviceUdid: UDID,
						phase: 'executing',
						message: 'Booting.',
					},
					{
						...running,
						id: 'simulator-recording',
						actionId: 'lane-recording',
						kind: 'capture.video',
						deviceUdid: UDID,
						phase: 'executing',
						message: 'Recording.',
					},
				],
			})
		);
		setSlimming(
			slimmingStateSchema.parse({
				...slimmingState(),
				jobs: [
					{
						...running,
						id: 'slimming-lane-apply',
						actionId: 'lane-apply',
						kind: 'profile.apply',
						phase: 'running',
						message: 'Applying.',
						currentIndex: 0,
						total: 1,
						targets: [
							{ simulatorUdid: UDID, status: 'running', message: 'Applying.' },
						],
					},
				],
			})
		);
		const handler = createAgentCommandRouter({
			...dependencies,
			agents: holdsOnlyAgents(owner),
		});
		const asStranger = from({ kind: 'codex', sessionId: 'stranger' });
		for (const jobId of ['simulator-lane-boot', 'slimming-lane-apply']) {
			await expect(
				handler({ kind: 'jobs', operation: 'cancel', jobId }, asStranger)
			).rejects.toMatchObject({ code: 'device_held' });
		}
		const stopRecording = {
			kind: 'record' as const,
			operation: 'stop' as const,
			udid: UDID,
			codec: 'h264' as const,
		};
		await expect(handler(stopRecording, asStranger)).rejects.toMatchObject({
			code: 'device_held',
		});
		// A request that claims no session is nobody's, and one that names a
		// session the desktop could not verify gets nothing at all.
		for (const jobId of ['simulator-lane-boot', 'slimming-lane-apply']) {
			const cancel = {
				kind: 'jobs' as const,
				operation: 'cancel' as const,
				jobId,
			};
			await expect(handler(cancel, context)).rejects.toMatchObject({
				code: 'device_held',
			});
			await expect(handler(cancel, unverified())).rejects.toMatchObject({
				code: 'agent_identity_unverified',
			});
		}
		await expect(handler(stopRecording, context)).rejects.toMatchObject({
			code: 'device_held',
		});
		await expect(handler(stopRecording, unverified())).rejects.toMatchObject({
			code: 'agent_identity_unverified',
		});
		expect(cancelledSimulatorJobs).toEqual([]);
		// Listing and reading jobs stay open to everyone.
		for (const caller of [asStranger, context, unverified()]) {
			await expect(
				handler(
					{ kind: 'jobs', operation: 'get', jobId: 'simulator-lane-boot' },
					caller
				)
			).resolves.toMatchObject({ id: 'simulator-lane-boot' });
		}

		await expect(
			handler(
				{ kind: 'jobs', operation: 'cancel', jobId: 'simulator-lane-boot' },
				from(owner)
			)
		).resolves.toEqual({ cancelled: false });
		// The fixture's cancel reports the recording already gone.
		await expect(handler(stopRecording, from(owner))).rejects.toMatchObject({
			code: 'invalid_command',
		});
		expect(cancelledSimulatorJobs).toEqual([
			'simulator-lane-boot',
			'simulator-recording',
		]);
	});

	it('lets a session stop or cancel a recording it started after another session took the device, and no one else', async () => {
		const root = await mkdtemp(
			path.join(os.tmpdir(), 'rndevtools-router-recordings-')
		);
		const recorder = { kind: 'codex' as const, sessionId: 'recorder' };
		const owner = { kind: 'claude' as const, sessionId: 'owner' };
		const stranger = { kind: 'claude' as const, sessionId: 'stranger' };
		const agents = new AgentService({
			directory: root,
			lanes: () => [],
			discover: async () => ({
				sessions: [recorder, owner, stranger].map((session) => ({
					...session,
					title: session.sessionId,
					cwd: '/Users/dev/app',
				})),
				claude: 'ok',
				codex: 'ok',
			}),
			pollIntervalMs: 60_000,
			now: () => now,
		});
		try {
			await agents.start();
			const { port: simulator, cancelled } = recordingSimulator();
			const { dependencies } = fixture();
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator,
				agents,
			});
			const by = (agent: Holder) => from(agent);
			const start = {
				kind: 'record' as const,
				operation: 'start' as const,
				udid: UDID,
				codec: 'h264' as const,
			};

			// Recording needs no hold, so it starts on the free device; then the
			// owner claims the device while it runs.
			const first = (await handler(start, by(recorder))) as { jobId: string };
			await handler({ kind: 'claim', udid: UDID }, by(owner));
			const stopFirst = {
				...start,
				operation: 'stop' as const,
				jobId: first.jobId,
			};
			// The hold still keeps every other session off the owner's device.
			await expect(handler(stopFirst, by(stranger))).rejects.toMatchObject({
				code: 'device_held',
			});
			await expect(
				handler(
					{ kind: 'jobs', operation: 'cancel', jobId: first.jobId },
					by(stranger)
				)
			).rejects.toMatchObject({ code: 'device_held' });
			expect(cancelled).toEqual([]);

			await expect(handler(stopFirst, by(recorder))).resolves.toMatchObject({
				job: { id: first.jobId, status: 'cancelled' },
			});
			// A recording only watches, so one on the held device is fine too,
			// and its starter can cancel it.
			const second = (await handler(start, by(recorder))) as {
				jobId: string;
			};
			await expect(
				handler(
					{ kind: 'jobs', operation: 'cancel', jobId: second.jobId },
					by(recorder)
				)
			).resolves.toEqual({ cancelled: true });
			expect(cancelled).toEqual([first.jobId, second.jobId]);
		} finally {
			await agents.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	it('stops the caller’s own recording first when record stop names no job', async () => {
		const { port: simulator, cancelled } = recordingSimulator();
		const { dependencies } = fixture();
		const owner = { kind: 'claude' as const, sessionId: 'owner' };
		const recorder = { kind: 'codex' as const, sessionId: 'recorder' };
		const handler = createAgentCommandRouter({
			...dependencies,
			simulator,
			agents: holdsOnlyAgents(owner),
		});
		const by = (agent: Holder) => from(agent);
		const record = {
			kind: 'record' as const,
			udid: UDID,
			codec: 'h264' as const,
		};
		await handler({ ...record, operation: 'start' }, by(owner));
		const mine = (await handler(
			{ ...record, operation: 'start' },
			by(recorder)
		)) as { jobId: string };
		await expect(
			handler({ ...record, operation: 'stop' }, by(recorder))
		).resolves.toMatchObject({ job: { id: mine.jobId } });
		// With none of its own left, the one still going is the holder's.
		await expect(
			handler({ ...record, operation: 'stop' }, by(recorder))
		).rejects.toMatchObject({ code: 'device_held' });
		expect(cancelled).toEqual([mine.jobId]);
	});

	it('canonicalizes lowercase Simulator targets before local and recipe dispatch', async () => {
		const { dependencies, simulatorActions, slimmingActions } = fixture();
		const recipeTargets: string[][] = [];
		const handler = createAgentCommandRouter({
			...dependencies,
			recipes: {
				list: () => [],
				get: () => undefined,
				run: async (_recipeId, udids) => {
					recipeTargets.push([...udids]);
					return { accepted: false, needsApproval: true };
				},
				cancel: () => false,
				status: () => undefined,
			},
		});

		await expect(
			handler(
				{ kind: 'capture', udid: UDID.toLowerCase(), format: 'png' },
				context
			)
		).rejects.toMatchObject({ code: 'action_rejected' });
		await expect(
			handler(
				{
					kind: 'slimming',
					operation: 'preview',
					udids: [UDID.toLowerCase()],
					profileId: 'rndevtools-development',
				},
				context
			)
		).rejects.toMatchObject({ code: 'action_rejected' });
		await handler(
			{
				kind: 'recipe',
				operation: 'run',
				recipeId: 'recipe-smoke',
				udids: [UDID.toLowerCase()],
			},
			context
		);

		expect(simulatorActions[0]).toMatchObject({ udid: UDID });
		expect(slimmingActions[0]).toMatchObject({ simulatorUdids: [UDID] });
		expect(recipeTargets).toEqual([[UDID]]);
	});

	it('fails an unknown job wait immediately', async () => {
		const { handler } = fixture();
		await expect(
			handler(
				{
					kind: 'wait',
					condition: { kind: 'job', jobId: 'missing-job' },
					timeoutMs: 60_000,
				},
				context
			)
		).rejects.toMatchObject({ code: 'target_not_found' });
	});

	it('fails closed when a UDID ambiguously maps to two live sessions', async () => {
		const { handler, setDesktop } = fixture();
		const state = desktopState();
		setDesktop({
			...state,
			devices: [
				state.devices[0] as NonNullable<(typeof state.devices)[number]>,
				{
					...(state.devices[0] as NonNullable<(typeof state.devices)[number]>),
					info: {
						...(state.devices[0] as NonNullable<(typeof state.devices)[number]>)
							.info,
						id: 'second-session',
					},
				},
			],
		});
		await expect(
			handler({ kind: 'screen', target: { udid: UDID } }, context)
		).rejects.toMatchObject({ code: 'ambiguous_target' });
	});

	it('does not expose mutating Slimming operations through the router', async () => {
		const { handler, slimmingActions } = fixture();
		const status = await handler(
			{ kind: 'slimming', operation: 'status' },
			context
		);
		expect(status).toMatchObject({
			setting: { experimentalMutationsEnabled: false },
		});
		expect(slimmingActions).toHaveLength(0);
	});

	it('keeps class-backed simulator service subscriptions bound while awaiting jobs', async () => {
		class BoundSlimmingPort {
			readonly listeners = new Set<(state: SlimmingState) => void>();
			state = slimmingState();

			getState(): SlimmingState {
				return this.state;
			}

			async refresh(): Promise<SlimmingState> {
				return this.state;
			}

			runAction(action: SlimmingAction) {
				const jobId = 'slimming-bound-job';
				this.state = slimmingStateSchema.parse({
					...this.state,
					jobs: [
						{
							id: jobId,
							actionId: action.actionId,
							kind: action.kind,
							status: 'running',
							progressSequence: 1,
							phase: 'running',
							message: 'Running doctor.',
							createdAt: now,
							startedAt: now,
							currentIndex: 0,
							total: 1,
							targets: [
								{
									simulatorUdid: UDID,
									status: 'running',
									message: 'Running doctor.',
								},
							],
						},
					],
				});
				queueMicrotask(() => {
					const running = this.state.jobs[0];
					this.state = slimmingStateSchema.parse({
						...this.state,
						jobs: [
							{
								...running,
								status: 'complete',
								progressSequence: 2,
								phase: 'complete',
								message: 'Doctor completed.',
								finishedAt: now + 1,
								currentIndex: 1,
								targets: [
									{
										simulatorUdid: UDID,
										status: 'complete',
										message: 'Doctor completed.',
									},
								],
							},
						],
					});
					for (const listener of this.listeners) listener(this.state);
				});
				return { actionId: action.actionId, accepted: true, jobId };
			}

			cancelJob(): boolean {
				return false;
			}

			subscribe(listener: (state: SlimmingState) => void): () => void {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
		}

		const boundSlimming = new BoundSlimmingPort();
		const handler = createAgentCommandRouter({
			broker: {
				getState: desktopState,
				dispatchAction: async (action) => ({
					actionId: action.actionId,
					ok: true,
				}),
			},
			simulator: {
				getState: simulatorState,
				refresh: async () => simulatorState(),
				runAction: (action) => ({
					actionId: action.actionId,
					accepted: false,
					error: 'not used',
				}),
				cancelJob: () => false,
				subscribe: () => () => undefined,
			},
			slimming: boundSlimming,
		});
		const result = await handler(
			{ kind: 'slimming', operation: 'doctor', udids: [UDID] },
			context
		);
		expect(result).toMatchObject({ job: { status: 'complete' } });
		expect(boundSlimming.listeners.size).toBe(0);
	});

	it('routes slimming apply, undo, and restore with the confirmation literal and the requesting session', async () => {
		const { dependencies, slimmingActions } = fixture();
		const me = { kind: 'codex' as const, sessionId: 'thread-7' };
		const handler = createAgentCommandRouter({
			...dependencies,
			slimming: {
				...dependencies.slimming,
				runAction: (action: SlimmingAction) => {
					slimmingActions.push(action);
					return {
						actionId: action.actionId,
						accepted: false,
						error: 'helper unavailable in this test',
					};
				},
			},
		});
		for (const [operation, kind, confirmation] of [
			['apply', 'profile.apply', SLIMMING_CONFIRMATIONS.apply],
			['undo', 'profile.undo', SLIMMING_CONFIRMATIONS.undo],
			['restore', 'profile.restore', SLIMMING_CONFIRMATIONS.restore],
		] as const) {
			await expect(
				handler(
					{
						kind: 'slimming',
						operation,
						udids: [UDID.toLowerCase()],
						...(operation === 'apply'
							? { profileId: 'rndevtools-development' }
							: {}),
					},
					from(me)
				)
			).rejects.toMatchObject({ code: 'action_rejected' });
			expect(slimmingActions.at(-1)).toMatchObject({
				kind,
				confirmation,
				simulatorUdids: [UDID],
				requester: me,
				...(operation === 'apply'
					? { profileId: 'rndevtools-development' }
					: {}),
			});
		}
		// A request that names no session carries no requester. The router has
		// already held it to free devices, which is all it reaches.
		await expect(
			handler({ kind: 'slimming', operation: 'undo', udids: [UDID] }, context)
		).rejects.toMatchObject({ code: 'action_rejected' });
		expect(slimmingActions.at(-1)).not.toHaveProperty('requester');
	});

	it('refuses slimming mutations on a device another session holds before reaching the service', async () => {
		const { dependencies, slimmingActions } = fixture();
		const handler = createAgentCommandRouter({
			...dependencies,
			agents: {
				getState: () => {
					throw new Error('unused');
				},
				refresh: async () => {
					throw new Error('unused');
				},
				runOperation: async () => {
					throw new Error('unused');
				},
				touch: () => undefined,
				access: (udid, requester) =>
					requester === 'operator'
						? { allowed: true }
						: {
								allowed: false,
								reason: `Simulator ${udid} is held by claude session owner through lane lane-1.`,
								hold: {
									simulatorUdid: udid,
									via: 'lane',
									laneId: 'lane-1',
									holder: { kind: 'claude', sessionId: 'owner' },
									holderLive: true,
								},
							},
			},
		});
		await expect(
			handler(
				{
					kind: 'slimming',
					operation: 'apply',
					udids: [UDID],
					profileId: 'rndevtools-development',
				},
				from({ kind: 'codex', sessionId: 'stranger' })
			)
		).rejects.toMatchObject({ code: 'device_held' });
		// A request that claims no session is nobody's, and one that names a
		// session the desktop could not verify gets nothing at all.
		const apply = {
			kind: 'slimming' as const,
			operation: 'apply' as const,
			udids: [UDID],
			profileId: 'rndevtools-development',
		};
		await expect(handler(apply, context)).rejects.toMatchObject({
			code: 'device_held',
		});
		await expect(handler(apply, unverified())).rejects.toMatchObject({
			code: 'agent_identity_unverified',
		});
		expect(slimmingActions).toEqual([]);
		// Read-only operations are never gated on ownership.
		await expect(
			handler(
				{
					kind: 'slimming',
					operation: 'preview',
					udids: [UDID],
					profileId: 'rndevtools-development',
				},
				from({ kind: 'codex', sessionId: 'stranger' })
			)
		).rejects.toMatchObject({ code: 'action_rejected' });
		expect(slimmingActions).toHaveLength(1);
	});

	it('reports the absent recipe provider with a typed recovery path', async () => {
		const { handler } = fixture();
		await expect(
			handler({ kind: 'recipe', operation: 'list' }, context)
		).rejects.toEqual(
			expect.objectContaining<Partial<AgentCliError>>({
				code: 'unavailable',
				recovery: expect.stringContaining('Automation'),
			})
		);
	});

	it('routes recipe commands through the approval-aware local provider', async () => {
		const { dependencies } = fixture();
		const recipes = {
			list: async () => [{ id: 'recipe-smoke', revision: 2 }],
			get: async (recipeId: string) => ({ id: recipeId, revision: 2 }),
			run: async (recipeId: string, udids: readonly string[]) => ({
				recipeId,
				targetUdids: udids,
				accepted: false,
				needsApproval: true,
			}),
			cancel: async (runId: string) => ({ runId, cancelled: true }),
			status: async (runId?: string) => ({
				runId: runId ?? null,
				status: 'complete',
			}),
		};
		const handler = createAgentCommandRouter({ ...dependencies, recipes });

		await expect(
			handler({ kind: 'recipe', operation: 'list' }, context)
		).resolves.toEqual([{ id: 'recipe-smoke', revision: 2 }]);
		await expect(
			handler(
				{
					kind: 'recipe',
					operation: 'run',
					recipeId: 'recipe-smoke',
					udids: [UDID],
				},
				context
			)
		).resolves.toMatchObject({ accepted: false, needsApproval: true });
		await expect(
			handler(
				{ kind: 'recipe', operation: 'status', runId: 'recipe-run-smoke' },
				context
			)
		).resolves.toEqual({ runId: 'recipe-run-smoke', status: 'complete' });
	});

	it('refuses a recipe run on a device another session holds before the recipe starts', async () => {
		const { dependencies } = fixture();
		const owner = { kind: 'claude' as const, sessionId: 'owner' };
		const runs: string[][] = [];
		const handler = createAgentCommandRouter({
			...dependencies,
			agents: holdsOnlyAgents(owner),
			recipes: {
				list: () => [],
				get: () => undefined,
				run: async (_recipeId, udids) => {
					runs.push([...udids]);
					return { accepted: true };
				},
				cancel: () => false,
				status: () => undefined,
			},
		});
		const run = {
			kind: 'recipe' as const,
			operation: 'run' as const,
			recipeId: 'recipe-smoke',
			udids: [UDID.toLowerCase()],
		};
		await expect(
			handler(run, from({ kind: 'codex', sessionId: 'stranger' }))
		).rejects.toMatchObject({
			code: 'device_held',
			message: expect.stringContaining('owner'),
		});
		expect(runs).toEqual([]);
		await handler(run, from(owner));
		// A request that claims no session is nobody's, not the operator's, and
		// one that names a session the desktop could not verify gets nothing.
		await expect(handler(run, context)).rejects.toMatchObject({
			code: 'device_held',
			message: expect.stringContaining('owner'),
		});
		await expect(handler(run, unverified())).rejects.toMatchObject({
			code: 'agent_identity_unverified',
		});
		expect(runs).toEqual([[UDID]]);
	});

	describe('native plan and install', () => {
		/** Simulator port whose app.list/app.install jobs complete and update appsByDevice. */
		function simulatorWithApps(initial: string[]) {
			let apps = [...initial];
			const listeners = new Set<(state: SimulatorState) => void>();
			let state = simulatorState();
			const actions: Array<{
				action: SimulatorAction;
				context: { selectedPath?: string } | undefined;
			}> = [];
			const port = {
				getState: () => state,
				refresh: async () => state,
				runAction: (
					action: SimulatorAction,
					actionContext?: { selectedPath?: string }
				) => {
					actions.push({ action, context: actionContext });
					const jobId = `job-${actions.length}`;
					queueMicrotask(() => {
						if (action.kind === 'app.install')
							apps = [...apps, 'com.example.app'];
						state = simulatorStateSchema.parse({
							...state,
							appsByDevice: {
								[UDID]: apps.map((bundleIdentifier) => ({
									bundleIdentifier,
									displayName: bundleIdentifier,
									isSystem: false,
								})),
							},
							jobs: [
								{
									id: jobId,
									actionId: action.actionId,
									kind: action.kind,
									status: 'complete',
									progressSequence: 1,
									phase: 'complete',
									message: 'done',
									createdAt: now,
									finishedAt: now + 1,
									deviceUdid: UDID,
								},
							],
						});
						for (const listener of listeners) listener(state);
					});
					return { actionId: action.actionId, accepted: true, jobId };
				},
				cancelJob: () => false,
				subscribe: (listener: (state: SimulatorState) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			};
			return { port, actions };
		}
		const plan = (cache: 'hit' | 'miss' | 'no-provider') => async () => ({
			projectRoot: '/Users/dev/app',
			platform: 'ios' as const,
			configuration: 'Debug',
			fingerprintHash: 'f'.repeat(40),
			sourceCount: 12,
			...(cache === 'no-provider'
				? {}
				: {
						provider: {
							plugin: '@rndevtools/react-native/build-cache',
							cacheEntry: '/Users/dev/Library/Caches/rndevtools/native/x',
						},
					}),
			cache,
			...(cache === 'hit'
				? {
						artifactPath:
							'/Users/dev/Library/Caches/rndevtools/native/x/ExampleApp.app',
					}
				: {}),
			bundleIdentifier: 'com.example.app',
			scheme: 'exampleapp',
		});

		it('reports the absent planner with a typed recovery path', async () => {
			const { dependencies } = fixture();
			await expect(
				createAgentCommandRouter(dependencies)(
					{
						kind: 'native',
						operation: 'plan',
						configuration: 'Debug',
						worktreePath: '/Users/dev/app',
					},
					context
				)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({ code: 'unavailable' })
			);
		});

		it('plans without a device: fingerprint, cache state, and a build recommendation', async () => {
			const { dependencies } = fixture();
			const { port, actions } = simulatorWithApps([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('miss'),
			});
			const result = (await handler(
				{
					kind: 'native',
					operation: 'plan',
					configuration: 'Debug',
					worktreePath: '/Users/dev/app',
				},
				context
			)) as Record<string, unknown>;
			expect(result).toMatchObject({
				fingerprintHash: 'f'.repeat(40),
				cache: 'miss',
				bundleIdentifier: 'com.example.app',
			});
			expect(result).not.toHaveProperty('installed');
			expect(String(result.recommendation)).toMatch(/^build: /);
			expect(String(result.recommendation)).toMatch(
				/expo run:ios --no-bundler/
			);
			// Expo CLI starts its own Metro for an explicit Debug configuration,
			// even with --no-bundler, so the Debug advice leaves the flag out.
			expect(String(result.recommendation)).not.toMatch(/--configuration/);
			expect(actions).toHaveLength(0);
		});

		it('names a configuration other than Debug in the build advice', async () => {
			const { dependencies } = fixture();
			const { port } = simulatorWithApps([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: async () => ({
					...(await plan('miss')()),
					configuration: 'Release',
				}),
			});
			const result = (await handler(
				{
					kind: 'native',
					operation: 'plan',
					configuration: 'Release',
					worktreePath: '/Users/dev/app',
				},
				context
			)) as Record<string, unknown>;
			expect(String(result.recommendation)).toMatch(
				/expo run:ios --configuration Release --no-bundler/
			);
		});

		it('plans with a device and reports installed state from the Simulator app list', async () => {
			const { dependencies } = fixture();
			const { port } = simulatorWithApps(['com.example.app']);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('hit'),
			});
			const result = (await handler(
				{
					kind: 'native',
					operation: 'plan',
					configuration: 'Debug',
					worktreePath: '/Users/dev/app',
					udid: UDID,
				},
				context
			)) as Record<string, unknown>;
			expect(result).toMatchObject({
				cache: 'hit',
				installed: true,
				simulatorUdid: UDID,
			});
			expect(String(result.recommendation)).toMatch(/^installed: /);
		});

		it('recommends install on a cache hit that is not yet on the device', async () => {
			const { dependencies } = fixture();
			const { port } = simulatorWithApps([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('hit'),
			});
			const result = (await handler(
				{
					kind: 'native',
					operation: 'plan',
					configuration: 'Debug',
					worktreePath: '/Users/dev/app',
					udid: UDID,
				},
				context
			)) as Record<string, unknown>;
			expect(result).toMatchObject({ cache: 'hit', installed: false });
			expect(String(result.recommendation)).toMatch(/^install: /);
		});

		it('installs the cached artifact through app.install with the artifact as the selected path', async () => {
			const { dependencies } = fixture();
			const { port, actions } = simulatorWithApps([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('hit'),
			});
			const result = (await handler(
				{
					kind: 'native',
					operation: 'install',
					configuration: 'Debug',
					worktreePath: '/Users/dev/app',
					udid: UDID,
				},
				context
			)) as Record<string, unknown>;
			expect(result).toMatchObject({
				action: 'installed-from-cache',
				installed: true,
			});
			const install = actions.find(
				({ action }) => action.kind === 'app.install'
			);
			expect(install?.context).toEqual({
				selectedPath:
					'/Users/dev/Library/Caches/rndevtools/native/x/ExampleApp.app',
			});
		});

		it('refuses to install on a miss and names the build command', async () => {
			const { dependencies } = fixture();
			const { port, actions } = simulatorWithApps([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('miss'),
			});
			await expect(
				handler(
					{
						kind: 'native',
						operation: 'install',
						configuration: 'Debug',
						worktreePath: '/Users/dev/app',
						udid: UDID,
					},
					context
				)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({
					code: 'cache_miss',
					recovery: expect.stringContaining(`--device ${UDID}`),
				})
			);
			expect(actions.some(({ action }) => action.kind === 'app.install')).toBe(
				false
			);
		});

		it('does nothing when the bundle is already installed', async () => {
			const { dependencies } = fixture();
			const { port, actions } = simulatorWithApps(['com.example.app']);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('miss'),
			});
			const result = await handler(
				{
					kind: 'native',
					operation: 'install',
					configuration: 'Debug',
					worktreePath: '/Users/dev/app',
					udid: UDID,
				},
				context
			);
			expect(result).toMatchObject({ action: 'already-installed' });
			expect(actions.some(({ action }) => action.kind === 'app.install')).toBe(
				false
			);
		});

		it('refuses to install on a device another session holds', async () => {
			const { dependencies } = fixture();
			const owner = { kind: 'claude' as const, sessionId: 'owner' };
			const { port, actions } = simulatorWithApps([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('hit'),
				agents: holdsOnlyAgents(owner),
			});
			const install = {
				kind: 'native' as const,
				operation: 'install' as const,
				configuration: 'Debug' as const,
				worktreePath: '/Users/dev/app',
				udid: UDID,
			};
			await expect(
				handler(install, from({ kind: 'codex', sessionId: 'stranger' }))
			).rejects.toMatchObject({ code: 'device_held' });
			// A request that claims no session is nobody's, and one that names a
			// session the desktop could not verify gets nothing at all.
			await expect(handler(install, context)).rejects.toMatchObject({
				code: 'device_held',
			});
			await expect(handler(install, unverified())).rejects.toMatchObject({
				code: 'agent_identity_unverified',
			});
			expect(actions.some(({ action }) => action.kind === 'app.install')).toBe(
				false
			);
			await expect(handler(install, from(owner))).resolves.toMatchObject({
				action: 'installed-from-cache',
			});
		});
	});

	describe('agents, claims, and touches', () => {
		function agentsPort() {
			const touches: Array<{
				agent: { kind: string; sessionId: string };
				udid: string;
			}> = [];
			const operations: AgentOperation[] = [];
			const state: AgentState = {
				revision: 1,
				updatedAt: now,
				sessions: [
					{
						kind: 'claude',
						sessionId: 'claude-1',
						title: 'checkout',
						cwd: '/Users/dev/app',
						pid: 7,
					},
				],
				byDevice: {},
				claims: [],
				holds: {},
				discovery: { claude: 'ok', codex: 'unavailable' },
			};
			const port = {
				getState: () => state,
				refresh: async () => state,
				runOperation: async (operation: AgentOperation) => {
					operations.push(operation);
					if (operation.kind === 'agent.claim') {
						state.claims = [
							{
								simulatorUdid: operation.simulatorUdid,
								kind: operation.agent.kind,
								sessionId: operation.agent.sessionId,
								...(operation.note ? { note: operation.note } : {}),
								claimedAt: now,
							},
						];
						state.byDevice = {
							[operation.simulatorUdid]: [
								{
									kind: operation.agent.kind,
									sessionId: operation.agent.sessionId,
									title: 'checkout',
									via: 'claim',
									lastSeenAt: now,
									live: true,
								},
							],
						};
					}
					if (operation.kind === 'agent.release') {
						const { agent } = operation;
						state.claims = state.claims.filter(
							(claim) =>
								claim.simulatorUdid !== operation.simulatorUdid ||
								(agent !== undefined &&
									`${claim.kind}:${claim.sessionId}` !==
										`${agent.kind}:${agent.sessionId}`)
						);
						state.byDevice = {};
					}
					return state;
				},
				touch: (agent: { kind: string; sessionId: string }, udid: string) => {
					touches.push({ agent, udid });
				},
			};
			return { port, touches, operations };
		}
		const session = { kind: 'claude' as const, sessionId: 'claude-1' };

		it('lists sessions and per-device attachments', async () => {
			const { dependencies } = fixture();
			const { port } = agentsPort();
			const result = (await createAgentCommandRouter({
				...dependencies,
				agents: port,
			})({ kind: 'agents' }, from(session))) as Record<string, unknown>;
			expect(result).toMatchObject({
				sessions: [expect.objectContaining({ sessionId: 'claude-1' })],
				devices: [],
				you: session,
				discovery: { claude: 'ok', codex: 'unavailable' },
			});
		});

		it('claims and releases only as the session the CLI is running inside', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
			});
			await expect(
				handler({ kind: 'claim', udid: UDID }, context)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({
					code: 'no_agent_session',
				})
			);
			const claimed = (await handler(
				{ kind: 'claim', udid: UDID.toLowerCase(), note: 'checkout flow' },
				from(session)
			)) as Record<string, unknown>;
			expect(operations[0]).toEqual({
				kind: 'agent.claim',
				simulatorUdid: UDID,
				agent: session,
				note: 'checkout flow',
			});
			expect(claimed).toMatchObject({ udid: UDID, you: session });
			expect((claimed.agents as unknown[]).length).toBe(1);
			await handler({ kind: 'release', udid: UDID }, from(session));
			expect(operations[1]).toEqual({
				kind: 'agent.release',
				simulatorUdid: UDID,
				agent: session,
			});
		});

		it('refuses a claim on a device another session holds', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const owner = { kind: 'codex' as const, sessionId: 'owner' };
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: { ...port, access: heldBy(owner) },
			});
			await expect(
				handler({ kind: 'claim', udid: UDID }, from(session))
			).rejects.toMatchObject({
				code: 'device_held',
				message: expect.stringContaining('owner'),
			});
			expect(operations).toEqual([]);
			await handler({ kind: 'claim', udid: UDID }, from(owner));
			expect(operations).toEqual([
				{ kind: 'agent.claim', simulatorUdid: UDID, agent: owner },
			]);
		});

		it('gives a free device to only one of two sessions claiming it at once', async () => {
			const root = await mkdtemp(
				path.join(os.tmpdir(), 'rndevtools-router-claims-')
			);
			const agents = new AgentService({
				directory: root,
				lanes: () => [],
				discover: async () => ({ sessions: [], claude: 'ok', codex: 'ok' }),
				pollIntervalMs: 60_000,
				now: () => now,
			});
			try {
				await agents.start();
				const { dependencies } = fixture();
				const handler = createAgentCommandRouter({ ...dependencies, agents });
				const results = await Promise.allSettled([
					handler({ kind: 'claim', udid: UDID }, from(session)),
					handler(
						{ kind: 'claim', udid: UDID },
						from({ kind: 'codex', sessionId: 'codex-2' })
					),
				]);
				expect(results.map((result) => result.status)).toEqual([
					'fulfilled',
					'rejected',
				]);
				expect(results[1]).toMatchObject({
					reason: { code: 'device_held' },
				});
				expect(
					agents.getState().claims.map((claim) => claim.sessionId)
				).toEqual(['claude-1']);
			} finally {
				await agents.stop();
				await rm(root, { recursive: true, force: true });
			}
		});

		it('release --all stops the lanes and drops the claims of the calling session only', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const me = { kind: 'claude' as const, sessionId: 'claude-1' };
			const other = { kind: 'codex' as const, sessionId: 'codex-2' };
			port
				.getState()
				.claims.push(
					{ simulatorUdid: UDID, ...me, claimedAt: now },
					{ simulatorUdid: OTHER_UDID, ...other, claimedAt: now }
				);
			const laneOperations: LaneOperation[] = [];
			const lanes = {
				getState: () => ({
					revision: 1,
					updatedAt: now,
					environments: [...DEFAULT_LANE_ENVIRONMENTS],
					lanes: [
						{
							id: 'lane-11111111-2222-4333-8444-555555555555',
							worktreePath: '/Users/dev/mine',
							branch: 'mine',
							simulatorUdid: UDID,
							environment: 'development' as const,
							port: 8_100,
							metro: 'ready' as const,
							logPath: '/Users/dev/mine.log',
							startedAt: now,
							agent: { ...me, lastSeenAt: now },
						},
						{
							id: 'lane-22222222-2222-4333-8444-555555555555',
							worktreePath: '/Users/dev/theirs',
							branch: 'theirs',
							simulatorUdid: OTHER_UDID,
							environment: 'development' as const,
							port: 8_101,
							metro: 'ready' as const,
							logPath: '/Users/dev/theirs.log',
							startedAt: now,
							agent: { ...other, lastSeenAt: now },
						},
					],
					worktrees: [],
					repositories: [],
					deviceRequests: [],
				}),
				refresh: async () => lanes.getState(),
				runOperation: async (operation: LaneOperation) => {
					laneOperations.push(operation);
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						state: lanes.getState(),
					};
				},
			};
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
				lanes,
			});
			const result = (await handler(
				{ kind: 'release', all: true },
				from(me)
			)) as {
				stoppedLanes: string[];
				releasedClaims: string[];
				errors: string[];
			};
			expect(result).toEqual({
				you: me,
				stoppedLanes: ['lane-11111111-2222-4333-8444-555555555555'],
				pendingLanes: [],
				releasedClaims: [UDID],
				errors: [],
			});
			expect(laneOperations).toEqual([
				expect.objectContaining({
					kind: 'lane.stop',
					laneId: 'lane-11111111-2222-4333-8444-555555555555',
				}),
			]);
			expect(operations).toEqual([
				{ kind: 'agent.release', simulatorUdid: UDID, agent: me },
			]);
			await expect(
				handler({ kind: 'release', all: true }, context)
			).rejects.toMatchObject({ code: 'no_agent_session' });
		});

		function releaseLane(
			n: number,
			worktreePath: string,
			agent: { kind: 'claude' | 'codex' | 'other'; sessionId: string }
		): Lane {
			return {
				id: `lane-${String(n).repeat(8)}-2222-4333-8444-555555555555`,
				worktreePath,
				branch: `feature-${n}`,
				simulatorUdid: `AAAAAAAA-0000-4000-8000-00000000000${n}`,
				environment: 'development',
				port: 8_100 + n,
				metro: 'ready',
				logPath: `${worktreePath}/lane.log`,
				startedAt: now,
				agent: { ...agent, lastSeenAt: now },
			};
		}

		/** A lane port whose stops remove the lane once `stop` settles. */
		function releaseLanes(
			initial: Lane[],
			stop: (
				laneId: string
			) => Promise<Partial<LaneOperationReceipt>> = async () => ({})
		) {
			let current = initial;
			const stops: Array<{ laneId: string; signal: AbortSignal }> = [];
			const state = (): LaneState => ({
				revision: 1,
				updatedAt: now,
				environments: [...DEFAULT_LANE_ENVIRONMENTS],
				lanes: current,
				worktrees: [],
				repositories: [],
				deviceRequests: [],
			});
			const port = {
				getState: state,
				refresh: async () => state(),
				runOperation: async (
					operation: LaneOperation,
					signal: AbortSignal
				): Promise<LaneOperationReceipt> => {
					if (operation.kind !== 'lane.stop') {
						throw new Error(`Unexpected ${operation.kind}.`);
					}
					stops.push({ laneId: operation.laneId, signal });
					const outcome = await stop(operation.laneId);
					if (outcome.completed !== false) {
						current = current.filter((lane) => lane.id !== operation.laneId);
					}
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						...outcome,
					};
				},
			};
			return { port, stops };
		}

		it('release --all reports failed stops as errors and slow ones as pending, within 2 s and detached from the request', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const me = { kind: 'claude' as const, sessionId: 'claude-1' };
			port
				.getState()
				.claims.push({ simulatorUdid: UDID, ...me, claimedAt: now });
			const failed = releaseLane(1, '/Users/dev/app-a', me);
			const slow = releaseLane(2, '/Users/dev/app-b', me);
			const quick = releaseLane(3, '/Users/dev/app-c', me);
			let slowFinished = false;
			const { port: lanes, stops } = releaseLanes(
				[failed, slow, quick],
				async (laneId) => {
					if (laneId === failed.id) {
						return {
							completed: false,
							error: 'Metro on port 8101 did not stop.',
						};
					}
					if (laneId === slow.id) {
						await new Promise((resolve) => setTimeout(resolve, 5_000));
						slowFinished = true;
					}
					return {};
				}
			);
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
				lanes,
			});
			const request = new AbortController();
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			try {
				let result: unknown;
				const released = handler(
					{ kind: 'release', all: true },
					from(me, { signal: request.signal })
				).then((value) => {
					result = value;
				});
				// The session-end client hangs up; the stops carry on regardless.
				request.abort();
				await vi.advanceTimersByTimeAsync(1_999);
				expect(result).toEqual({
					you: me,
					stoppedLanes: [quick.id],
					pendingLanes: [slow.id],
					releasedClaims: [UDID],
					errors: [`lane ${failed.id}: Metro on port 8101 did not stop.`],
				});
				expect(stops.map((stop) => [stop.laneId, stop.signal.aborted])).toEqual(
					[
						[failed.id, false],
						[slow.id, false],
						[quick.id, false],
					]
				);
				expect(slowFinished).toBe(false);
				await vi.advanceTimersByTimeAsync(5_000);
				expect(slowFinished).toBe(true);
				expect(lanes.getState().lanes.map((lane) => lane.id)).toEqual([
					failed.id,
				]);
				await released;
			} finally {
				vi.useRealTimers();
			}
			expect(operations).toEqual([
				{ kind: 'agent.release', simulatorUdid: UDID, agent: me },
			]);
		});

		it('release --all also drops the lanes and claims an older desktop recorded for a shared MCP id, but only where the session worked', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const me = { kind: 'claude' as const, sessionId: 'claude-1' };
			// What an older desktop recorded for an MCP server that named no
			// session. Nothing verifies such an id now, so no request holds as it
			// and the directory is all that ties these to the session that worked
			// there.
			const shared = {
				kind: 'claude' as const,
				sessionId: 'mcp-claude-code',
			};
			const inside = releaseLane(1, '/Users/dev/app-a', shared);
			const elsewhere = releaseLane(2, '/Users/dev/app-b', shared);
			const otherKind = releaseLane(3, '/Users/dev/app-a', {
				kind: 'codex',
				sessionId: 'mcp-codex-mcp-client',
			});
			const own = releaseLane(4, '/Users/dev/app-c', me);
			const otherSession = releaseLane(5, '/Users/dev/app-a', {
				kind: 'claude',
				sessionId: 'claude-2',
			});
			const bareUdid = 'AAAAAAAA-0000-4000-8000-000000000006';
			const ownUdid = 'AAAAAAAA-0000-4000-8000-000000000007';
			port.getState().claims.push(
				// On the device of the shared lane the session works in.
				{ simulatorUdid: inside.simulatorUdid, ...shared, claimedAt: now },
				// No lane, so no directory to match: left to the hold clock.
				{ simulatorUdid: bareUdid, ...shared, claimedAt: now },
				{ simulatorUdid: ownUdid, ...me, claimedAt: now }
			);
			const { port: lanes } = releaseLanes([
				inside,
				elsewhere,
				otherKind,
				own,
				otherSession,
			]);
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
				lanes,
			});

			// The session-end hook reports the session's own id and where it worked.
			await expect(
				handler(
					{
						kind: 'release',
						all: true,
						sessionCwd: '/Users/dev/app-a/src/../src/',
					},
					from(me)
				)
			).resolves.toEqual({
				you: me,
				stoppedLanes: [inside.id, own.id],
				pendingLanes: [],
				releasedClaims: [inside.simulatorUdid, ownUdid],
				errors: [],
			});
			expect(operations).toEqual([
				{
					kind: 'agent.release',
					simulatorUdid: inside.simulatorUdid,
					agent: shared,
				},
				{ kind: 'agent.release', simulatorUdid: ownUdid, agent: me },
			]);

			await expect(
				handler(
					{ kind: 'release', all: true, sessionCwd: '/Users/dev/app-b' },
					from(me)
				)
			).resolves.toMatchObject({ stoppedLanes: [elsewhere.id] });
			expect(lanes.getState().lanes.map((lane) => lane.id)).toEqual([
				otherKind.id,
				otherSession.id,
			]);
			expect(
				port.getState().claims.map((claim) => claim.simulatorUdid)
			).toEqual([bareUdid]);
		});

		it('release --all from a monorepo checkout root releases the shared id’s app lanes in it', async () => {
			const { dependencies } = fixture();
			const { port } = agentsPort();
			const me = { kind: 'claude' as const, sessionId: 'claude-1' };
			const shared = {
				kind: 'claude' as const,
				sessionId: 'mcp-claude-code',
			};
			const app: Lane = {
				...releaseLane(1, '/Users/dev/repo', shared),
				appPath: '/Users/dev/repo/examples/expo-demo',
			};
			port.getState().claims.push({
				simulatorUdid: app.simulatorUdid,
				...shared,
				claimedAt: now,
			});
			const { port: lanes } = releaseLanes([app]);
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
				lanes,
			});
			await expect(
				handler(
					{ kind: 'release', all: true, sessionCwd: '/Users/dev/repo' },
					from(me)
				)
			).resolves.toMatchObject({
				stoppedLanes: [app.id],
				releasedClaims: [app.simulatorUdid],
				errors: [],
			});
		});

		it('release --all from inside one app of a checkout leaves the shared id’s other app lanes running', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const mobileSession = {
				kind: 'claude' as const,
				sessionId: 'claude-mobile',
			};
			const shared = {
				kind: 'claude' as const,
				sessionId: 'mcp-claude-code',
			};
			const mobile: Lane = {
				...releaseLane(1, '/Users/dev/mono', shared),
				appPath: '/Users/dev/mono/apps/mobile',
			};
			const admin: Lane = {
				...releaseLane(2, '/Users/dev/mono', shared),
				appPath: '/Users/dev/mono/apps/admin',
			};
			port
				.getState()
				.claims.push(
					{ simulatorUdid: mobile.simulatorUdid, ...shared, claimedAt: now },
					{ simulatorUdid: admin.simulatorUdid, ...shared, claimedAt: now }
				);
			const { port: lanes } = releaseLanes([mobile, admin]);
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
				lanes,
			});
			const endIn = (sessionCwd: string) =>
				handler(
					{ kind: 'release', all: true, sessionCwd },
					from(mobileSession)
				);

			// The mobile session's end leaves the admin session's lane alone.
			await expect(endIn('/Users/dev/mono/apps/mobile/src')).resolves.toEqual({
				you: mobileSession,
				stoppedLanes: [mobile.id],
				pendingLanes: [],
				releasedClaims: [mobile.simulatorUdid],
				errors: [],
			});
			// A session above the checkout worked in none of its lanes.
			await expect(endIn('/Users/dev')).resolves.toMatchObject({
				stoppedLanes: [],
				releasedClaims: [],
			});
			expect(lanes.getState().lanes.map((lane) => lane.id)).toEqual([admin.id]);
			// One at the checkout's root worked above every app lane in it.
			await expect(endIn('/Users/dev/mono')).resolves.toMatchObject({
				stoppedLanes: [admin.id],
				releasedClaims: [admin.simulatorUdid],
			});
			expect(operations).toEqual([
				{
					kind: 'agent.release',
					simulatorUdid: mobile.simulatorUdid,
					agent: shared,
				},
				{
					kind: 'agent.release',
					simulatorUdid: admin.simulatorUdid,
					agent: shared,
				},
			]);
		});

		it('records a touch for every device-targeted command that carried a session, after it succeeds', async () => {
			const { dependencies } = fixture();
			const { port, touches } = agentsPort();
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
			});
			// Simulator-targeted by UDID.
			await handler({ kind: 'screen', target: { udid: UDID } }, from(session));
			// Connected-app target resolves to the Simulator the session reported.
			await handler(
				{ kind: 'screen', target: { deviceId: 'rndevtools-demo-ios' } },
				from(session)
			);
			// Fleet-wide commands and failed commands do not touch.
			await handler(
				{ kind: 'simulators', includeUnavailable: false },
				from(session)
			);
			await expect(
				handler(
					{
						kind: 'screen',
						target: { udid: '00000000-0000-4000-8000-000000000000' },
					},
					from(session)
				)
			).rejects.toBeTruthy();
			// No session, or one that was not verified, no touch.
			await handler({ kind: 'screen', target: { udid: UDID } }, context);
			await handler({ kind: 'screen', target: { udid: UDID } }, unverified());
			expect(touches).toEqual([
				{ agent: session, udid: UDID },
				{ agent: session, udid: UDID },
			]);
		});

		it('lists agents for every caller, and names you only for a verified session', async () => {
			const { dependencies } = fixture();
			const { port } = agentsPort();
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
			});
			for (const caller of [context, unverified()]) {
				const listed = await handler({ kind: 'agents' }, caller);
				expect(listed).toMatchObject({
					sessions: [expect.objectContaining({ sessionId: 'claude-1' })],
				});
				expect(listed).not.toHaveProperty('you');
			}
			await expect(
				handler({ kind: 'agents' }, from(session))
			).resolves.toMatchObject({ you: session });
		});

		it('gives a claim the desktop could not verify no claim, release, or release --all, and tells it what can change that', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
			});
			for (const command of [
				{ kind: 'claim', udid: UDID },
				{ kind: 'release', udid: UDID },
				{ kind: 'release', all: true },
			] as const) {
				for (const { cause, retryable, recovery } of UNVERIFIED_REFUSALS) {
					await expect(
						handler(command, unverified(cause))
					).rejects.toMatchObject({
						code: 'agent_identity_unverified',
						message: `The sender was not proven (${cause}).`,
						retryable,
						recovery,
					});
				}
				// A request that claims nothing is told what a command that holds
				// devices needs, which is a Claude Code session and no other.
				await expect(handler(command, context)).rejects.toMatchObject({
					code: 'no_agent_session',
					retryable: false,
					recovery: NO_AGENT_SESSION_RECOVERY,
				});
			}
			expect(operations).toEqual([]);
		});

		it('refuses a session-end release once the session can no longer be placed, and leaves its claim to the hold clock', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const me = { kind: 'claude' as const, sessionId: 'claude-1' };
			port
				.getState()
				.claims.push({ simulatorUdid: UDID, ...me, claimedAt: now });
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
			});
			// A hook that arrives long after its session left the registry: the
			// desktop remembers a session for a minute, and this is later.
			const lateHook = {
				...context,
				identity: {
					status: 'unverified',
					cause: 'no-session',
					reason: 'Session is no longer discoverable.',
				},
			} satisfies AgentCliHandlerContext;
			await expect(
				handler(
					{ kind: 'release', all: true, sessionCwd: '/Users/dev/app' },
					lateHook
				)
			).rejects.toMatchObject({
				code: 'agent_identity_unverified',
				message: 'Session is no longer discoverable.',
				retryable: false,
			});
			expect(operations).toEqual([]);
			expect(port.getState().claims).toHaveLength(1);
		});
	});

	describe('native input', () => {
		it('delivers input to a booted Simulator through the port and records a touch', async () => {
			const { dependencies } = fixture();
			const sent: unknown[] = [];
			const touches: string[] = [];
			const handler = createAgentCommandRouter({
				...dependencies,
				simulatorInput: async (input) => {
					sent.push(input);
					return {
						udid: input.udid,
						kind: input.kind,
						messages: 2,
						elapsedMilliseconds: 150,
					};
				},
				agents: {
					getState: () => ({
						revision: 0,
						updatedAt: 0,
						sessions: [],
						byDevice: {},
						claims: [],
						holds: {},
						discovery: { claude: 'ok', codex: 'ok' },
					}),
					refresh: async () => ({
						revision: 0,
						updatedAt: 0,
						sessions: [],
						byDevice: {},
						claims: [],
						holds: {},
						discovery: { claude: 'ok', codex: 'ok' },
					}),
					runOperation: async () => {
						throw new Error('unused');
					},
					touch: (_agent, udid) => {
						touches.push(udid);
					},
				},
			});
			const result = await handler(
				{
					kind: 'input',
					input: {
						kind: 'tap',
						udid: UDID.toLowerCase(),
						x: 0.5,
						y: 0.5,
						holdMilliseconds: 40,
					},
				},
				from({ kind: 'claude', sessionId: 'claude-1' })
			);
			expect(result).toMatchObject({ kind: 'tap', messages: 2 });
			// The UDID is canonicalised from the inventory before it reaches the host.
			expect(sent).toEqual([
				{ kind: 'tap', udid: UDID, x: 0.5, y: 0.5, holdMilliseconds: 40 },
			]);
			expect(touches).toEqual([UDID]);
		});

		it('refuses input to an unknown or shut-down Simulator with typed errors', async () => {
			const { dependencies } = fixture();
			const handler = createAgentCommandRouter({
				...dependencies,
				simulatorInput: async () => {
					throw new Error('must not be called');
				},
			});
			await expect(
				handler(
					{
						kind: 'input',
						input: {
							kind: 'button',
							udid: '00000000-0000-4000-8000-000000000000',
							button: 'home',
						},
					},
					context
				)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({
					code: 'target_not_found',
				})
			);
			const shutdown = {
				...dependencies,
				simulator: {
					...dependencies.simulator,
					refresh: async () =>
						simulatorStateSchema.parse({
							...simulatorState(),
							devices: simulatorState().devices.map((d) => ({
								...d,
								state: 'shutdown',
							})),
						}),
				},
			};
			await expect(
				createAgentCommandRouter({
					...shutdown,
					simulatorInput: async () => {
						throw new Error('no');
					},
				})(
					{
						kind: 'input',
						input: { kind: 'button', udid: UDID, button: 'home' },
					},
					context
				)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({
					code: 'simulator_not_booted',
				})
			);
		});

		it('maps a host failure to a typed, retryable error and reports a missing port', async () => {
			const { dependencies } = fixture();
			await expect(
				createAgentCommandRouter(dependencies)(
					{
						kind: 'input',
						input: { kind: 'button', udid: UDID, button: 'home' },
					},
					context
				)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({ code: 'unavailable' })
			);
			const failing = createAgentCommandRouter({
				...dependencies,
				simulatorInput: async () => {
					throw new NativeHostResponseError(
						'simulator_input_unavailable',
						'SimulatorKit missing',
						false
					);
				},
			});
			await expect(
				failing(
					{
						kind: 'input',
						input: { kind: 'button', udid: UDID, button: 'home' },
					},
					context
				)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({
					code: 'simulator_input_unavailable',
					retryable: true,
					recovery: expect.stringContaining('Xcode'),
				})
			);
		});
	});

	it('reports absent lane support with a typed recovery path', async () => {
		const { handler } = fixture();
		await expect(
			handler({ kind: 'lane', operation: 'ls' }, context)
		).rejects.toEqual(
			expect.objectContaining<Partial<AgentCliError>>({
				code: 'unavailable',
				recovery: expect.stringContaining('Update RN Devtools'),
			})
		);
	});

	it('refuses lane up, lane down, lane launch, and input on a device another agent holds, to a request that claims no session too', async () => {
		const { dependencies } = fixture();
		const owner = { kind: 'claude' as const, sessionId: 'owner-session' };
		const stranger = { kind: 'codex' as const, sessionId: 'stranger-thread' };
		const lane: Lane = {
			id: 'lane-11111111-2222-4333-8444-555555555555',
			worktreePath: '/Users/dev/app-feature',
			branch: 'feature',
			simulatorUdid: UDID,
			environment: 'development',
			port: 8_100,
			metro: 'ready',
			logPath: '/Users/dev/lane.log',
			startedAt: now,
			agent: { ...owner, lastSeenAt: now },
		};
		const state: LaneState = {
			revision: 1,
			updatedAt: now,
			environments: [...DEFAULT_LANE_ENVIRONMENTS],
			lanes: [lane],
			worktrees: [],
			repositories: [],
			deviceRequests: [],
		};
		const operations: LaneOperation[] = [];
		const inputs: unknown[] = [];
		const access = (udid: string, requester: DeviceRequester) =>
			requester === 'operator' ||
			(typeof requester !== 'string' && requester.sessionId === owner.sessionId)
				? ({ allowed: true } as const)
				: ({
						allowed: false,
						reason: `Simulator ${udid} is held by claude session owner-session through lane ${lane.id}.`,
						hold: {
							simulatorUdid: udid,
							via: 'lane' as const,
							laneId: lane.id,
							holder: owner,
							holderLive: true,
						},
					} as const);
		const handler = createAgentCommandRouter({
			...dependencies,
			lanes: {
				getState: () => state,
				refresh: async () => state,
				runOperation: async (operation: LaneOperation) => {
					operations.push(operation);
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						lane,
						state,
					};
				},
			},
			simulatorInput: async (input) => {
				inputs.push(input);
				return {
					udid: input.udid,
					kind: input.kind,
					messages: 2,
					elapsedMilliseconds: 10,
				};
			},
			agents: {
				getState: () => {
					throw new Error('unused');
				},
				refresh: async () => {
					throw new Error('unused');
				},
				runOperation: async () => {
					throw new Error('unused');
				},
				touch: () => undefined,
				access,
			},
		});
		const asStranger = from(stranger);
		const asOwner = from(owner);

		await expect(
			handler(
				{
					kind: 'lane',
					operation: 'up',
					worktreePath: '/Users/dev/app-other',
					udid: UDID.toLowerCase(),
				},
				asStranger
			)
		).rejects.toMatchObject({
			code: 'device_held',
			retryable: true,
			message: expect.stringContaining('owner-session'),
		});
		await expect(
			handler({ kind: 'lane', operation: 'down', laneId: lane.id }, asStranger)
		).rejects.toMatchObject({ code: 'device_held' });
		// A launch would make the stranger the lane's agent, so it is refused too.
		await expect(
			handler(
				{ kind: 'lane', operation: 'launch', laneId: lane.id, url: 'checkout' },
				asStranger
			)
		).rejects.toMatchObject({ code: 'device_held' });
		await expect(
			handler(
				{
					kind: 'input',
					input: { kind: 'button', udid: UDID, button: 'home' },
				},
				asStranger
			)
		).rejects.toMatchObject({ code: 'device_held' });
		expect(operations).toEqual([]);
		expect(inputs).toEqual([]);

		// A request that claims no session is nobody's, not the operator's: it
		// is refused on the held device whatever it asks, a lane up that names
		// the device included.
		for (const command of [
			{
				kind: 'lane',
				operation: 'up',
				worktreePath: '/Users/dev/app-other',
				udid: UDID.toLowerCase(),
			},
			{ kind: 'lane', operation: 'down', laneId: lane.id },
			{ kind: 'lane', operation: 'launch', laneId: lane.id },
			{ kind: 'input', input: { kind: 'button', udid: UDID, button: 'home' } },
		] as const) {
			await expect(handler(command, context)).rejects.toMatchObject({
				code: 'device_held',
				retryable: true,
				message: expect.stringContaining('owner-session'),
			});
		}
		expect(operations).toEqual([]);
		expect(inputs).toEqual([]);

		// The holder gets through.
		await handler(
			{ kind: 'lane', operation: 'launch', laneId: lane.id },
			asOwner
		);
		await handler(
			{ kind: 'lane', operation: 'down', laneId: lane.id },
			asOwner
		);
		await handler(
			{ kind: 'input', input: { kind: 'button', udid: UDID, button: 'home' } },
			asOwner
		);
		expect(operations.map((operation) => operation.kind)).toEqual([
			'lane.launch',
			'lane.stop',
		]);
		expect(operations[0]).toMatchObject({ agent: owner });
		expect(inputs).toHaveLength(1);
	});

	it('records the verified session on lane up and launch, so the session holds its own lane', async () => {
		const { dependencies } = fixture();
		const session = {
			kind: 'claude' as const,
			sessionId: 'claude-session-1',
		};
		const laneId = 'lane-11111111-2222-4333-8444-555555555555';
		let current: Lane[] = [];
		const operations: LaneOperation[] = [];
		const state = (): LaneState => ({
			revision: 1,
			updatedAt: now,
			environments: [...DEFAULT_LANE_ENVIRONMENTS],
			lanes: current,
			worktrees: [],
			repositories: [],
			deviceRequests: [],
		});
		const unused = () => {
			throw new Error('unused');
		};
		const handler = createAgentCommandRouter({
			...dependencies,
			lanes: {
				getState: state,
				refresh: async () => state(),
				runOperation: async (operation: LaneOperation) => {
					operations.push(operation);
					if (operation.kind === 'lane.start') {
						current = [
							{
								id: laneId,
								worktreePath: operation.worktreePath,
								branch: 'feature',
								simulatorUdid: UDID,
								environment: 'development',
								port: 8_100,
								metro: 'ready',
								logPath: '/Users/dev/lane.log',
								startedAt: now,
								...(operation.agent
									? { agent: { ...operation.agent, lastSeenAt: now } }
									: {}),
							},
						];
					}
					if (operation.kind === 'lane.stop') current = [];
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						...(current[0] ? { lane: current[0] } : {}),
					};
				},
			},
			agents: {
				getState: unused,
				refresh: unused,
				runOperation: unused,
				touch: () => undefined,
				// The real hold rules over this lane state, with no live sessions.
				access: (udid, requester) =>
					decideDeviceAccess(
						resolveDeviceHolds({
							lanes: current,
							claims: [],
							liveSessionKeys: new Set(),
							missingSince: new Map(),
							now,
						}).get(udid.toUpperCase()),
						requester,
						now
					),
			},
			simulatorInput: async (input) => ({
				udid: input.udid,
				kind: input.kind,
				messages: 1,
				elapsedMilliseconds: 1,
			}),
		});
		const asSession = from(session);

		await handler(
			{ kind: 'lane', operation: 'up', worktreePath: '/Users/dev/app' },
			asSession
		);
		expect(operations[0]).toMatchObject({ kind: 'lane.start', agent: session });
		expect(current[0]?.agent).toMatchObject(session);
		await handler({ kind: 'lane', operation: 'launch', laneId }, asSession);
		expect(operations[1]).toMatchObject({
			kind: 'lane.launch',
			agent: session,
		});
		await expect(
			handler(
				{
					kind: 'input',
					input: { kind: 'button', udid: UDID, button: 'home' },
				},
				asSession
			)
		).resolves.toMatchObject({ kind: 'button' });
		const other = { kind: 'claude' as const, sessionId: 'claude-session-2' };
		await expect(
			handler({ kind: 'lane', operation: 'launch', laneId }, from(other))
		).rejects.toMatchObject({ code: 'device_held' });
		await handler({ kind: 'lane', operation: 'down', laneId }, asSession);

		// The lane's holder is the connection's verified identity, whoever the
		// request says it is: a lane command takes no agent of its own.
		await handler(
			{ kind: 'lane', operation: 'up', worktreePath: '/Users/dev/app' },
			from(other)
		);
		expect(operations.map((operation) => operation.kind)).toEqual([
			'lane.start',
			'lane.launch',
			'lane.stop',
			'lane.start',
		]);
		expect(operations[3]).toMatchObject({ agent: other });
	});

	it('lets lane up omit the udid: the lane service picks a device, and a parked request comes back with next steps', async () => {
		const { dependencies } = fixture();
		const stranger = { kind: 'codex' as const, sessionId: 'stranger-thread' };
		const deviceRequest = {
			id: 'device-request-1',
			status: 'pending' as const,
			requestedAt: now,
			updatedAt: now,
			message:
				'All 2 available Simulators are in use: 2 by lanes, 0 claimed by other sessions.',
			worktreePath: '/Users/dev/app-feature',
			branch: 'feature',
			environment: 'development',
			launch: true,
			agent: stranger,
		};
		const state: LaneState = {
			revision: 1,
			updatedAt: now,
			environments: [...DEFAULT_LANE_ENVIRONMENTS],
			lanes: [],
			worktrees: [],
			repositories: [],
			deviceRequests: [deviceRequest],
		};
		const operations: LaneOperation[] = [];
		let accessChecks = 0;
		const handler = createAgentCommandRouter({
			...dependencies,
			agents: {
				getState: () => {
					throw new Error('unused');
				},
				refresh: async () => {
					throw new Error('unused');
				},
				runOperation: async () => {
					throw new Error('unused');
				},
				touch: () => undefined,
				access: () => {
					accessChecks += 1;
					return { allowed: true };
				},
			},
			lanes: {
				getState: () => state,
				refresh: async () => state,
				runOperation: async (operation: LaneOperation) => {
					operations.push(operation);
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						deviceRequest,
						state,
					};
				},
			},
		});

		const result = (await handler(
			{ kind: 'lane', operation: 'up', worktreePath: '/Users/dev/app-feature' },
			from(stranger)
		)) as { completed: boolean; deviceRequest?: unknown; next?: string };
		// No device named and no lane for the app yet, so nothing to check
		// ownership against.
		expect(accessChecks).toBe(0);
		expect(operations[0]).toMatchObject({
			kind: 'lane.start',
			worktreePath: '/Users/dev/app-feature',
		});
		expect(operations[0]).not.toHaveProperty('simulatorUdid');
		expect(result.completed).toBe(true);
		expect(result.deviceRequest).toMatchObject({
			id: 'device-request-1',
			status: 'pending',
		});
		expect(result.next).toMatch(/Poll lane --operation ls/);
		expect(result.next).toContain('device-request-1');

		// `ls` carries the requests so the agent can follow the outcome.
		await expect(
			handler({ kind: 'lane', operation: 'ls' }, context)
		).resolves.toMatchObject({ deviceRequests: [deviceRequest] });
	});

	it("checks the device of the app's existing lane on a lane up without a udid", async () => {
		const { dependencies } = fixture();
		const owner = { kind: 'claude' as const, sessionId: 'owner-session' };
		const stranger = { kind: 'codex' as const, sessionId: 'stranger-thread' };
		// One app of a monorepo worktree has a lane; the worktree root is another app.
		const lane: Lane = {
			id: 'lane-11111111-2222-4333-8444-555555555555',
			worktreePath: '/Users/dev/mono',
			appPath: '/Users/dev/mono/apps/mobile',
			branch: 'feature',
			simulatorUdid: UDID,
			environment: 'development',
			port: 8_100,
			metro: 'ready',
			logPath: '/Users/dev/lane.log',
			startedAt: now,
			agent: { ...owner, lastSeenAt: now },
		};
		const state: LaneState = {
			revision: 1,
			updatedAt: now,
			environments: [...DEFAULT_LANE_ENVIRONMENTS],
			lanes: [lane],
			worktrees: [],
			repositories: [],
			deviceRequests: [],
		};
		const operations: LaneOperation[] = [];
		const checked: string[] = [];
		const handler = createAgentCommandRouter({
			...dependencies,
			agents: {
				...holdsOnlyAgents(owner),
				access: (udid, requester) => {
					checked.push(udid);
					return heldBy(owner)(udid, requester);
				},
			},
			lanes: {
				getState: () => state,
				refresh: async () => state,
				runOperation: async (operation: LaneOperation) => {
					operations.push(operation);
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						lane,
						state,
					};
				},
			},
		});
		const up = (worktreePath: string) =>
			({ kind: 'lane', operation: 'up', worktreePath }) as const;

		// The lane service would resume the owner's lane, restarting its Metro,
		// so the stranger gets the typed refusal and its recovery rather than a
		// failed lane. The path matches however the lane service resolves it.
		await expect(
			handler(up('/Users/dev/mono/apps/mobile/'), from(stranger))
		).rejects.toMatchObject({
			code: 'device_held',
			retryable: true,
			message: expect.stringContaining('owner-session'),
			recovery: expect.stringContaining('find a free device'),
		});
		expect(checked).toEqual([UDID]);
		expect(operations).toEqual([]);

		// The holder resumes it. A request that claims no session is nobody's, so
		// the lane is not its to resume either.
		await handler(up('/Users/dev/mono/apps/mobile'), from(owner));
		await expect(
			handler(up('/Users/dev/mono/apps/mobile'), context)
		).rejects.toMatchObject({ code: 'device_held' });
		expect(checked).toEqual([UDID, UDID, UDID]);

		// Another app in the worktree has no lane of its own, so there is no
		// device to check, for a session or for a request with no identity: the
		// lane service picks a free one.
		await handler(up('/Users/dev/mono'), from(stranger));
		await handler(up('/Users/dev/mono'), context);
		expect(checked).toEqual([UDID, UDID, UDID]);
		expect(operations).toMatchObject([
			{
				kind: 'lane.start',
				worktreePath: '/Users/dev/mono/apps/mobile',
				agent: owner,
			},
			{ kind: 'lane.start', worktreePath: '/Users/dev/mono', agent: stranger },
			{ kind: 'lane.start', worktreePath: '/Users/dev/mono' },
		]);
		// An anonymous start has no holder to record: its lane is the operator's.
		expect(operations[2]).not.toHaveProperty('agent');
		// The router never names the device; the lane service resumes the lane
		// wherever it runs.
		for (const operation of operations) {
			expect(operation).not.toHaveProperty('simulatorUdid');
		}
	});

	it('routes lane up/launch/down/log through the lane service and resolves worktree targets', async () => {
		const { dependencies } = fixture();
		const lane: Lane = {
			id: 'lane-11111111-2222-4333-8444-555555555555',
			worktreePath: '/Users/dev/app-feature',
			branch: 'feature',
			simulatorUdid: UDID,
			environment: 'development',
			port: 8_100,
			metroPid: 42,
			metro: 'ready',
			logPath: '/Users/dev/lane.log',
			scheme: 'exampleapp',
			startedAt: now,
		};
		let state: LaneState = {
			revision: 1,
			updatedAt: now,
			environments: [...DEFAULT_LANE_ENVIRONMENTS],
			lanes: [],
			worktrees: [],
			repositories: [],
			deviceRequests: [],
		};
		const operations: LaneOperation[] = [];
		const runOptions: unknown[] = [];
		const lanes = {
			getState: () => state,
			refresh: async () => state,
			runOperation: async (
				operation: LaneOperation,
				_signal?: AbortSignal,
				options?: unknown
			) => {
				operations.push(operation);
				runOptions.push(options);
				if (operation.kind === 'lane.start') {
					state = { ...state, lanes: [lane] };
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						lane,
						state,
					};
				}
				if (operation.kind === 'lane.log') {
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						lane,
						log: 'metro ready',
					};
				}
				if (operation.kind === 'lane.stop') {
					state = { ...state, lanes: [] };
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						state,
					};
				}
				return {
					actionId: operation.actionId,
					kind: operation.kind,
					completed: true,
					lane,
					state,
				};
			},
		};
		const handler = createAgentCommandRouter({ ...dependencies, lanes });

		const up = (await handler(
			{
				kind: 'lane',
				operation: 'up',
				worktreePath: '/Users/dev/app-feature',
				udid: UDID,
				slimProfileId: 'rndevtools-development',
			},
			from({ kind: 'claude', sessionId: 'session-1' })
		)) as { lane: Lane; completed: boolean };
		expect(up.completed).toBe(true);
		expect(up.lane.port).toBe(8_100);
		expect(operations[0]).toMatchObject({
			kind: 'lane.start',
			environment: 'development',
			launch: true,
			slimProfileId: 'rndevtools-development',
			agent: { kind: 'claude', sessionId: 'session-1' },
		});
		expect(operations[0]).not.toHaveProperty('state');
		// The unattended CLI may request slimming but can never approve it.
		expect(runOptions[0]).toBeUndefined();

		await expect(
			handler({ kind: 'lane', operation: 'ls' }, context)
		).resolves.toMatchObject({ lanes: [lane] });

		await handler(
			{
				kind: 'lane',
				operation: 'launch',
				worktreePath: '/Users/dev/app-feature',
				url: 'checkout',
			},
			context
		);
		expect(operations[1]).toMatchObject({
			kind: 'lane.launch',
			laneId: lane.id,
			url: 'checkout',
		});

		const log = (await handler(
			{ kind: 'lane', operation: 'log', laneId: lane.id },
			context
		)) as { log: string };
		expect(log.log).toBe('metro ready');

		await expect(
			handler({ kind: 'lane', operation: 'down', laneId: lane.id }, context)
		).resolves.toMatchObject({ completed: true, laneId: lane.id });
		await expect(
			handler({ kind: 'lane', operation: 'down', laneId: lane.id }, context)
		).rejects.toEqual(
			expect.objectContaining<Partial<AgentCliError>>({
				code: 'lane_not_found',
			})
		);
	});

	it('surfaces a failed lane receipt as a retryable typed error', async () => {
		const { dependencies } = fixture();
		const lanes = {
			getState: () => ({
				revision: 1,
				updatedAt: now,
				environments: [...DEFAULT_LANE_ENVIRONMENTS],
				lanes: [],
				worktrees: [],
				repositories: [],
				deviceRequests: [],
			}),
			refresh: async () => ({
				revision: 1,
				updatedAt: now,
				environments: [...DEFAULT_LANE_ENVIRONMENTS],
				lanes: [],
				worktrees: [],
				repositories: [],
				deviceRequests: [],
			}),
			runOperation: async (operation: LaneOperation) => ({
				actionId: operation.actionId,
				kind: operation.kind,
				completed: false,
				error: 'Metro port 8100 is already in use.',
			}),
		};
		const handler = createAgentCommandRouter({ ...dependencies, lanes });
		await expect(
			handler(
				{
					kind: 'lane',
					operation: 'up',
					worktreePath: '/Users/dev/app',
					udid: UDID,
					preferredPort: 8_100,
				},
				context
			)
		).rejects.toEqual(
			expect.objectContaining<Partial<AgentCliError>>({
				code: 'lane_failed',
				message: 'Metro port 8100 is already in use.',
				retryable: true,
			})
		);
	});

	describe('local Supabase', () => {
		const STACK_ID = SUPABASE_DEMO_IDS.featCheckout;
		const WORKTREE = '/Users/dev/example-app-wt/feat-checkout';
		const claude = { kind: 'claude' as const, sessionId: 'claude-1' };
		const STACK: SupabaseAgentStack = {
			id: STACK_ID,
			status: 'ready',
			origin: 'managed',
			mode: 'managed',
			runtime: 'native',
			exposure: 'loopback',
			branchContext: 'refs/heads/feat-checkout',
			worktreePath: WORKTREE,
			projectRoot: WORKTREE,
			apiPort: 21_734,
			dbPort: 21_735,
			laneIds: [],
			holders: [{ holder: 'session', agent: claude, live: true }],
			yours: true,
			cli: { version: '2.121.0', gate: 'verified', run: 'pnpm exec supabase' },
		};
		// Placeholder values in the shapes the contract allows; not real keys.
		const ENV = {
			API_URL: 'http://127.0.0.1:21734',
			REST_URL: 'http://127.0.0.1:21734/rest/v1',
			PUBLISHABLE_KEY: 'sb_publishable_EXAMPLEKEY000',
			ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.ZXhhbXBsZQ',
		};
		const DOCTOR: SupabaseDoctorInfo = {
			enabled: true,
			capability: 'ready',
			platform: { supported: true, arch: 'arm64', macosVersion: '15.1' },
			repositories: [
				{
					label: '~/code/example-app',
					mode: 'managed',
					cli: { version: '2.121.0', gate: 'verified' },
				},
				{
					label: '~/code/example-admin',
					mode: 'observed',
					cli: { version: '2.122.0', gate: 'unsupported' },
				},
			],
			running: 2,
			cap: 12,
			sysv: { used: 6, limit: 32 },
			containerEngine: { docker: 'absent', podman: 'absent' },
			stats: {
				starts: 4,
				failures: 1,
				failuresByCode: { cli_mismatch: 1 },
				p50Ms: 4_500,
				p95Ms: 6_300,
			},
			warnings: [],
		};

		function resultFor(operation: SupabaseAgentOperation): SupabaseAgentResult {
			switch (operation.operation) {
				case 'up':
					return {
						operation: 'up',
						stack: STACK,
						appEnv: [
							'EXPO_PUBLIC_SUPABASE_URL',
							'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
						],
						metro: 'no-lane',
						cli: {
							run: 'pnpm exec supabase',
							workdir: WORKTREE,
							version: '2.121.0',
						},
						next: 'Run `pnpm exec supabase migration up --local` from the worktree.',
						warnings: ['shared-default-keys'],
					};
				case 'down':
					return {
						operation: 'down',
						stackId: STACK_ID,
						released: true,
						stopping: true,
						keptBy: [],
						next: 'It stops in 60 s unless someone holds it again.',
					};
				case 'ls':
					return { operation: 'ls', stacks: [STACK] };
				case 'status':
					return {
						operation: 'status',
						stack: STACK,
						services: [
							{ service: 'database', state: 'running', health: 'healthy' },
						],
						checkedAt: now,
					};
				case 'env':
					return { operation: 'env', stackId: STACK_ID, env: ENV };
				case 'reset':
					return {
						operation: 'reset',
						stackId: STACK_ID,
						status: 'complete',
						seed: operation.seed,
						next: 'The local database was reset.',
					};
				case 'log':
					return {
						operation: 'log',
						stackId: STACK_ID,
						records: [],
						truncated: false,
					};
				case 'destroy':
					return {
						operation: 'destroy',
						stackId: STACK_ID,
						requestId: SUPABASE_DEMO_IDS.requestOldUi,
						status: 'pending',
						expiresAt: now + 600_000,
						next: 'The user decides in RN Devtools.',
					};
			}
		}

		function supabaseFake(state = createSupabaseDemoState({ now })) {
			const calls: Array<{
				operation: SupabaseAgentOperation;
				context: SupabaseAgentContext;
				signal: AbortSignal;
			}> = [];
			const releases: Array<Parameters<AgentSupabasePort['releaseHolder']>[0]> =
				[];
			const waits: Array<{ jobId: string; timeoutMs: number }> = [];
			const fake = {
				state: state as SupabaseState,
				answer: async (operation: SupabaseAgentOperation): Promise<unknown> =>
					resultFor(operation),
				release: async (): Promise<SupabaseReleaseResult> => ({
					releasedStackIds: [],
					pendingStops: [],
				}),
				doctor: (): SupabaseDoctorInfo => DOCTOR,
			};
			const port: AgentSupabasePort = {
				getState: () => fake.state,
				runAgentOperation: async (operation, context, signal) => {
					calls.push({ operation, context, signal });
					return (await fake.answer(operation)) as SupabaseAgentResult;
				},
				releaseHolder: (input) => {
					releases.push(input);
					return fake.release();
				},
				job: (jobId) => fake.state.jobs.find((job) => job.id === jobId),
				waitForJob: async (jobId, timeoutMs) => {
					waits.push({ jobId, timeoutMs });
					return fake.state.jobs.find((job) => job.id === jobId);
				},
				doctor: () => fake.doctor(),
			};
			return { port, fake, calls, releases, waits };
		}

		function agentsWith(sessions: AgentState['sessions']) {
			const state: AgentState = {
				revision: 1,
				updatedAt: now,
				sessions,
				byDevice: {},
				claims: [],
				holds: {},
				discovery: { claude: 'ok', codex: 'ok' },
			};
			return {
				getState: () => state,
				refresh: async () => state,
				runOperation: async () => state,
				touch: () => undefined,
			};
		}

		it('reports absent local Supabase with a typed recovery path', async () => {
			const { handler } = fixture();
			const jobId = SUPABASE_DEMO_IDS.jobFixAuth;
			for (const command of [
				{ kind: 'supabase', operation: 'ls' },
				{ kind: 'wait', condition: { kind: 'job', jobId }, timeoutMs: 1_000 },
				{ kind: 'jobs', operation: 'get', jobId },
			] as const) {
				await expect(handler(command, context)).rejects.toMatchObject({
					code: 'unavailable',
					recovery: 'Update RN Devtools and retry.',
				});
			}
			expect(await handler({ kind: 'doctor' }, context)).not.toHaveProperty(
				'supabase'
			);
		});

		it('runs the contract operation with the envelope identity and returns the checked result', async () => {
			const { dependencies } = fixture();
			const { port, calls } = supabaseFake();
			const handler = createAgentCommandRouter({
				...dependencies,
				supabase: port,
				agents: agentsWith([
					{
						kind: 'claude',
						sessionId: 'claude-1',
						title: 'checkout',
						cwd: `${WORKTREE}/apps/mobile`,
					},
					{
						kind: 'codex',
						sessionId: 'thread-9',
						title: 'payments',
						cwd: '/Users/dev/example-app-wt/feat-payments',
					},
				]),
			});
			const signal = new AbortController().signal;
			const up = {
				operation: 'up',
				target: { worktreePath: WORKTREE },
				waitMs: 30_000,
			} as const;
			await expect(
				handler(
					{ kind: 'supabase', operation: 'up', worktreePath: WORKTREE },
					from(claude, { signal })
				)
			).resolves.toEqual(resultFor(up));
			expect(calls[0]).toEqual({
				operation: up,
				context: {
					requestId: context.requestId,
					synthetic: false,
					holder: claude,
					sessionCwd: `${WORKTREE}/apps/mobile`,
				},
				signal,
			});

			// The contract's defaults (seed on, 200 lines); a stack id prefix
			// passes through for the service to resolve.
			await handler(
				{
					kind: 'supabase',
					operation: 'reset',
					stackId: STACK_ID.slice(0, 8),
					note: 'Start over.',
				},
				from(claude)
			);
			await handler(
				{
					kind: 'supabase',
					operation: 'log',
					worktreePath: WORKTREE,
					services: ['gateway'],
					since: '10m',
				},
				from(claude)
			);
			expect(calls.slice(1).map((call) => call.operation)).toEqual([
				{
					operation: 'reset',
					target: { stackId: STACK_ID.slice(0, 8) },
					seed: true,
					// Kept for the request card when another session holds it.
					note: 'Start over.',
				},
				{
					operation: 'log',
					target: { worktreePath: WORKTREE },
					tail: 200,
					services: ['gateway'],
					since: '10m',
				},
			]);

			// A verified session that discovery has not listed (it started since the
			// last poll) is still the holder; its directory is just not known yet.
			const unlisted = {
				kind: 'claude' as const,
				sessionId: 'claude-unlisted',
			};
			await handler(
				{ kind: 'supabase', operation: 'down', worktreePath: WORKTREE },
				from(unlisted)
			);
			expect(calls[3]?.context).toEqual({
				requestId: context.requestId,
				synthetic: false,
				holder: unlisted,
			});
			// No session on the request: an anonymous caller, which has no holder.
			await expect(
				handler({ kind: 'supabase', operation: 'ls' }, context)
			).resolves.toEqual({ operation: 'ls', stacks: [STACK] });
			expect(calls[4]?.context).toEqual({
				requestId: context.requestId,
				synthetic: false,
			});
		});

		it('refuses up, down, reset, and destroy to a claim the desktop could not verify, and runs the reads as an anonymous caller', async () => {
			const { dependencies } = fixture();
			const { port, calls } = supabaseFake();
			const handler = createAgentCommandRouter({
				...dependencies,
				supabase: port,
			});
			// These act for a holder, and a claim that is not proven is nobody's.
			for (const operation of ['up', 'down', 'reset', 'destroy'] as const) {
				for (const { cause, retryable, recovery } of UNVERIFIED_REFUSALS) {
					await expect(
						handler(
							{ kind: 'supabase', operation, worktreePath: WORKTREE },
							unverified(cause)
						)
					).rejects.toMatchObject({
						code: 'agent_identity_unverified',
						message: `The sender was not proven (${cause}).`,
						retryable,
						recovery,
					});
				}
			}
			expect(calls).toEqual([]);

			// The reads name no holder, so they run for it as for any request that
			// claims nothing.
			for (const fields of [
				{ operation: 'ls' },
				{ operation: 'status', worktreePath: WORKTREE },
				{ operation: 'env', worktreePath: WORKTREE },
				{ operation: 'log', worktreePath: WORKTREE },
			] as const) {
				await handler({ kind: 'supabase', ...fields }, unverified());
			}
			expect(calls.map((call) => call.context)).toEqual(
				Array.from({ length: 4 }, () => ({
					requestId: context.requestId,
					synthetic: false,
				}))
			);

			// A request that claims nothing runs them all, as no one.
			await handler(
				{ kind: 'supabase', operation: 'up', worktreePath: WORKTREE },
				context
			);
			expect(calls.at(-1)?.context).toEqual({
				requestId: context.requestId,
				synthetic: false,
			});
		});

		it('refuses while local Supabase is off, unsupported, or unreadable, and never suggests Docker', async () => {
			const { dependencies } = fixture();
			const { port, fake, calls } = supabaseFake(
				createSupabaseDemoState({ now, variant: 'off' })
			);
			const handler = createAgentCommandRouter({
				...dependencies,
				supabase: port,
			});
			const up = {
				kind: 'supabase',
				operation: 'up',
				worktreePath: WORKTREE,
			} as const;
			const off = await handler(up, from(claude)).catch(
				(error: unknown) => error as AgentCliError
			);
			expect(off).toMatchObject({
				code: 'supabase_disabled',
				retryable: false,
			});
			const recovery = (off as AgentCliError).recovery;
			expect(recovery).toMatch(
				/^Ask the user to turn on local Supabase in RN Devtools › Supabase/
			);
			expect(recovery).toMatch(/`supabase start --runtime native`/);
			expect(recovery).not.toMatch(/docker/i);

			fake.state = createSupabaseDemoState({ now, variant: 'unsupported' });
			await expect(handler(up, context)).rejects.toMatchObject({
				code: 'supabase_unsupported',
				message: 'Native Supabase needs Apple silicon and macOS 14 or later.',
				recovery: supabaseAgentRecovery('supabase_unsupported'),
			});

			const demo = createSupabaseDemoState({ now });
			fake.state = {
				...demo,
				feature: { ...demo.feature, policyHealth: 'quarantined' },
			};
			await expect(handler(up, context)).rejects.toMatchObject({
				code: 'supabase_disabled',
				message: expect.stringContaining('could not read'),
			});
			expect(calls).toEqual([]);
		});

		it('maps service failures to typed errors whose recovery names the next call', async () => {
			const { dependencies } = fixture();
			const { port, fake } = supabaseFake();
			const handler = createAgentCommandRouter({
				...dependencies,
				supabase: port,
			});
			const failure = async (thrown: unknown, signal = context.signal) => {
				fake.answer = async () => {
					throw thrown;
				};
				return await handler(
					{ kind: 'supabase', operation: 'up', worktreePath: WORKTREE },
					from(claude, { signal })
				).then(
					() => {
						throw new Error('Expected the operation to fail.');
					},
					(error: unknown) => error as AgentCliError
				);
			};

			// Typed errors keep their own recovery, or get the contract's.
			const own = new AgentCliError({
				code: 'supabase_held',
				message: 'Codex 5d1b8f40 holds this stack.',
				recovery: 'Ask the user to release it.',
			});
			expect(await failure(own)).toBe(own);
			expect(
				await failure(
					new AgentCliError({
						code: 'supabase_held',
						message: 'Codex 5d1b8f40 holds this stack.',
					})
				)
			).toMatchObject({
				code: 'supabase_held',
				recovery: supabaseAgentRecovery('supabase_held'),
			});
			// Plain errors with an agent code, and the worktree's runner.
			expect(
				await failure(
					Object.assign(new Error('12 of 12 stacks are running.'), {
						code: 'supabase_capacity',
					})
				)
			).toMatchObject({
				code: 'supabase_capacity',
				message: '12 of 12 stacks are running.',
				retryable: true,
				recovery: supabaseAgentRecovery('supabase_capacity'),
			});
			expect(
				await failure({
					code: 'cli_unverified',
					message: 'Supabase CLI 2.122.0 is not verified.',
					runner: 'pnpm exec supabase',
				})
			).toMatchObject({
				code: 'cli_unverified',
				retryable: false,
				recovery: supabaseAgentRecovery('cli_unverified', 'pnpm exec supabase'),
			});
			// Off always reads the same, naming the runner when the service does.
			expect(
				await failure(
					new AgentCliError({
						code: 'supabase_disabled',
						message: 'Local Supabase is off.',
						recovery: supabaseAgentRecovery('supabase_disabled'),
					})
				)
			).toMatchObject({
				code: 'supabase_disabled',
				recovery: expect.stringMatching(/^Ask the user to turn on/),
			});
			const runnerOff = await failure({
				code: 'supabase_disabled',
				message: 'Local Supabase is off.',
				runner: 'pnpm exec supabase',
			});
			expect(runnerOff.recovery).toContain(
				'`pnpm exec supabase start --runtime native`'
			);
			expect(
				(await failure({ code: 'cli_unverified', runner: '`rm -rf ~`' }))
					.recovery
			).toBe(supabaseAgentRecovery('cli_unverified'));
			// Renderer-shaped failures map onto agent codes without operator copy.
			expect(
				await failure({
					code: 'unknown_target',
					title: 'Unknown stack',
					message: 'No stack matches 64616c83.',
					recovery: 'Refresh the list.',
					retry: 'none',
					details: {},
				})
			).toMatchObject({
				code: 'not_found',
				retryable: false,
				recovery: supabaseAgentRecovery('not_found'),
			});
			// Anything else is redacted, bounded, and worth one retry.
			const internal = await failure(
				new TypeError('cannot parse SECRET_KEY=sb_secret_EXAMPLE000 here')
			);
			expect(internal).toMatchObject({
				code: 'supabase_failed',
				retryable: true,
				recovery: supabaseAgentRecovery('supabase_failed'),
			});
			expect(internal.message).not.toContain('sb_secret_');
			// A request the client abandoned reads as cancelled.
			const abandoned = new AbortController();
			abandoned.abort();
			expect(
				await failure(new Error('The operation was aborted.'), abandoned.signal)
			).toMatchObject({ code: 'cancelled' });
		});

		it('withholds results that break the agent contract or carry key material outside env', async () => {
			const { dependencies } = fixture();
			const { port, fake } = supabaseFake();
			const handler = createAgentCommandRouter({
				...dependencies,
				supabase: port,
			});
			const up = {
				kind: 'supabase',
				operation: 'up',
				worktreePath: WORKTREE,
			} as const;
			const upResult = resultFor({
				operation: 'up',
				target: { worktreePath: WORKTREE },
				waitMs: 30_000,
			});
			for (const answer of [
				{ ...upResult, stack: { ...STACK, apiUrl: ENV.API_URL } },
				{
					...upResult,
					next: 'Connect with postgresql://postgres:postgres@127.0.0.1:21735/postgres.',
				},
				{ ...upResult, next: `Send apikey ${ENV.ANON_KEY}.` },
				{ ...upResult, next: `Use ${ENV.PUBLISHABLE_KEY} in the app.` },
				// Another operation's result, or none at all.
				resultFor({ operation: 'env', target: { worktreePath: WORKTREE } }),
				undefined,
			]) {
				fake.answer = async () => answer;
				await expect(handler(up, context)).rejects.toMatchObject({
					code: 'supabase_failed',
					message: expect.stringContaining('withheld'),
					retryable: true,
				});
			}

			// env is the one result that carries the public URL and keys.
			fake.answer = async (operation) => resultFor(operation);
			await expect(
				handler(
					{ kind: 'supabase', operation: 'env', worktreePath: WORKTREE },
					context
				)
			).resolves.toEqual({ operation: 'env', stackId: STACK_ID, env: ENV });

			// Service log lines are redacted once more on the way out.
			const entry = {
				type: 'entry',
				timestamp: '2026-10-17T05:00:00.000Z',
				source: 'history',
				service: 'gateway',
				instanceId: 'gateway',
				stream: 'stdout',
				line: `GET /rest/v1/notes?apikey=${ENV.PUBLISHABLE_KEY}&select=id 200 ${ENV.ANON_KEY}`,
			} as const;
			const marker = {
				type: 'marker',
				timestamp: entry.timestamp,
				source: 'history',
				service: 'gateway',
				instanceId: 'gateway',
				kind: 'launch',
			} as const;
			fake.answer = async () => ({
				operation: 'log',
				stackId: STACK_ID,
				records: [entry, marker],
				truncated: false,
			});
			const log = (await handler(
				{ kind: 'supabase', operation: 'log', worktreePath: WORKTREE },
				context
			)) as Extract<SupabaseAgentResult, { operation: 'log' }>;
			expect(log.records).toEqual([
				{
					...entry,
					line: 'GET /rest/v1/notes?apikey=[REDACTED]&select=id 200 [REDACTED JWT]',
				},
				marker,
			]);
		});

		it('release --all drops the session’s stack holds and reports them', async () => {
			const { dependencies } = fixture();
			const { port, fake, releases } = supabaseFake();
			fake.release = async () => ({
				releasedStackIds: [STACK_ID],
				pendingStops: [STACK_ID],
			});
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: agentsWith([]),
				supabase: port,
			});
			await expect(
				handler(
					{ kind: 'release', all: true, sessionCwd: `${WORKTREE}/src/../src/` },
					from(claude)
				)
			).resolves.toEqual({
				you: claude,
				stoppedLanes: [],
				pendingLanes: [],
				releasedClaims: [],
				releasedStacks: [STACK_ID],
				pendingStops: [STACK_ID],
				errors: [],
			});
			expect(releases).toEqual([
				{ holder: claude, sessionCwd: `${WORKTREE}/src` },
			]);

			// A failed release is reported, redacted, beside the rest.
			fake.release = async () => {
				throw new Error('registry write failed near sb_secret_EXAMPLE000');
			};
			const failed = (await handler(
				{ kind: 'release', all: true },
				from(claude)
			)) as { releasedStacks: string[]; errors: string[] };
			expect(failed.releasedStacks).toEqual([]);
			expect(failed.errors).toEqual([
				expect.stringMatching(/^supabase: registry write failed near /),
			]);
			expect(failed.errors.join(' ')).not.toContain('sb_secret_');
			expect(releases[1]).toEqual({ holder: claude });
		});

		it('release --all answers within 2 s while the stack release still runs', async () => {
			const { dependencies } = fixture();
			const { port, fake } = supabaseFake();
			let finished = false;
			fake.release = async () => {
				await new Promise((resolve) => setTimeout(resolve, 5_000));
				finished = true;
				return { releasedStackIds: [STACK_ID], pendingStops: [] };
			};
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: agentsWith([]),
				supabase: port,
			});
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			try {
				let result: unknown;
				const released = handler(
					{ kind: 'release', all: true },
					from(claude)
				).then((value) => {
					result = value;
				});
				await vi.advanceTimersByTimeAsync(1_999);
				expect(result).toEqual({
					you: claude,
					stoppedLanes: [],
					pendingLanes: [],
					releasedClaims: [],
					releasedStacks: [],
					pendingStops: [],
					errors: [
						'supabase: dropping the stack holds took longer than 1.5 s and continues in the background.',
					],
				});
				expect(finished).toBe(false);
				await vi.advanceTimersByTimeAsync(5_000);
				expect(finished).toBe(true);
				await released;
			} finally {
				vi.useRealTimers();
			}
		});

		it('follows Supabase jobs through wait and jobs, and reports lost ones', async () => {
			const { dependencies } = fixture();
			const { port, fake, waits } = supabaseFake();
			const handler = createAgentCommandRouter({
				...dependencies,
				supabase: port,
			});
			const jobId = SUPABASE_DEMO_IDS.jobFixAuth;
			const job = fake.state.jobs[0];
			await expect(
				handler(
					{
						kind: 'wait',
						condition: { kind: 'job', jobId },
						timeoutMs: 45_000,
					},
					context
				)
			).resolves.toEqual(job);
			expect(waits).toEqual([{ jobId, timeoutMs: 45_000 }]);
			await expect(
				handler({ kind: 'jobs', operation: 'list' }, context)
			).resolves.toEqual([{ source: 'supabase', ...job }]);
			await expect(
				handler({ kind: 'jobs', operation: 'get', jobId }, context)
			).resolves.toEqual({ source: 'supabase', ...job });
			await expect(
				handler({ kind: 'jobs', operation: 'cancel', jobId }, context)
			).resolves.toMatchObject({
				cancelled: false,
				next: expect.stringContaining('RN Devtools › Supabase'),
			});

			const lost = {
				code: 'job_lost',
				retryable: true,
				recovery: supabaseAgentRecovery('job_lost'),
			};
			const unknown = 'supabase-job-00000000-0000-4000-8000-000000000000';
			await expect(
				handler(
					{
						kind: 'wait',
						condition: { kind: 'job', jobId: unknown },
						timeoutMs: 1_000,
					},
					context
				)
			).rejects.toMatchObject(lost);
			await expect(
				handler({ kind: 'jobs', operation: 'get', jobId: unknown }, context)
			).rejects.toMatchObject(lost);
			fake.state = {
				...fake.state,
				jobs: fake.state.jobs.map((candidate) => ({
					...candidate,
					status: 'lost' as const,
				})),
			};
			await expect(
				handler(
					{ kind: 'wait', condition: { kind: 'job', jobId }, timeoutMs: 1_000 },
					context
				)
			).rejects.toMatchObject(lost);
		});

		it('lists each session’s stack holds in agents and reports Supabase in doctor', async () => {
			const { dependencies } = fixture();
			const { port, fake } = supabaseFake();
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: agentsWith([]),
				supabase: port,
			});
			const ids = SUPABASE_DEMO_IDS;
			const agents = (await handler({ kind: 'agents' }, context)) as {
				supabaseHolds: unknown[];
			};
			// Lane holds without an agent and the operator's pin are nobody's session.
			expect(agents.supabaseHolds).toEqual([
				{
					stackId: ids.featCheckout,
					branch: 'feat-checkout',
					via: 'lane',
					laneId: ids.laneCheckout,
					holder: { kind: 'claude', sessionId: ids.claudeCheckout },
					holderLive: true,
				},
				{
					stackId: ids.featCheckout,
					branch: 'feat-checkout',
					via: 'session',
					holder: { kind: 'codex', sessionId: ids.codexAbandoned },
					holderLive: false,
					abandonedSince: now - 3 * 60_000,
					releaseAt: now + 7 * 60_000,
				},
				{
					stackId: ids.featPayments,
					branch: 'feat-payments',
					via: 'worktree',
					holder: { kind: 'codex', sessionId: ids.codexSynthetic },
					holderLive: true,
				},
			]);

			await expect(handler({ kind: 'doctor' }, context)).resolves.toMatchObject(
				{ supabase: DOCTOR }
			);
			// A doctor section that cannot be read, or breaks its bounds, never
			// fails doctor itself.
			fake.doctor = () => {
				throw new Error('The policy store is busy.');
			};
			await expect(handler({ kind: 'doctor' }, context)).resolves.toMatchObject(
				{ supabase: { capability: 'unavailable', error: expect.any(String) } }
			);
			fake.doctor = () => ({
				...DOCTOR,
				warnings: Array.from({ length: 17 }, () => 'Too many warnings.'),
			});
			await expect(handler({ kind: 'doctor' }, context)).resolves.toMatchObject(
				{ supabase: { capability: 'unavailable' } }
			);
		});

		it('forwards lane up’s backend policy and says what to do while the stack starts', async () => {
			const { dependencies } = fixture();
			const lane: Lane = {
				id: 'lane-11111111-2222-4333-8444-555555555555',
				worktreePath: WORKTREE,
				branch: 'feat-checkout',
				simulatorUdid: UDID,
				environment: 'development',
				port: 8_100,
				metro: 'ready',
				logPath: '/Users/dev/lane.log',
				startedAt: now,
			};
			const state: LaneState = {
				revision: 1,
				updatedAt: now,
				environments: [...DEFAULT_LANE_ENVIRONMENTS],
				lanes: [],
				worktrees: [],
				repositories: [],
				deviceRequests: [],
			};
			const operations: LaneOperation[] = [];
			let backend: LaneOperationReceipt['backend'];
			let completed = true;
			const handler = createAgentCommandRouter({
				...dependencies,
				lanes: {
					getState: () => state,
					refresh: async () => state,
					runOperation: async (operation: LaneOperation) => {
						operations.push(operation);
						return {
							actionId: operation.actionId,
							kind: operation.kind,
							completed,
							...(completed
								? { lane }
								: {
										error: "The lane requires this worktree's local Supabase.",
									}),
							...(backend ? { backend } : {}),
						};
					},
				},
			});
			const up = {
				kind: 'lane',
				operation: 'up',
				worktreePath: WORKTREE,
			} as const;

			await expect(handler(up, context)).resolves.not.toHaveProperty('next');
			expect(operations[0]).not.toHaveProperty('backend');

			const jobId = SUPABASE_DEMO_IDS.jobFixAuth;
			backend = {
				policy: 'auto',
				status: 'starting',
				appEnvNames: [],
				warnings: [],
				jobId,
				launch: 'deferred',
			};
			const starting = (await handler({ ...up, backend: 'auto' }, context)) as {
				backend?: unknown;
				next?: string;
			};
			expect(operations[1]).toMatchObject({
				kind: 'lane.start',
				backend: 'auto',
			});
			expect(starting.backend).toEqual(backend);
			expect(starting.next).toBe(
				`This worktree's local Supabase is still starting; the dev client launches once it is ready. Follow it with wait --condition job --job-id ${jobId}.`
			);

			backend = {
				policy: 'required',
				status: 'refused',
				reason: 'ports-pinned',
				appEnvNames: [],
				warnings: [],
				reasonText: 'supabase/config.toml pins api.port.',
			};
			completed = false;
			await expect(
				handler({ ...up, backend: 'required' }, context)
			).rejects.toMatchObject({
				code: 'lane_failed',
				message: "The lane requires this worktree's local Supabase.",
				retryable: true,
				recovery: expect.stringContaining('backend auto'),
			});
			expect(operations[2]).toMatchObject({ backend: 'required' });
		});
	});

	describe('request identity', () => {
		const holder = { kind: 'claude' as const, sessionId: 'holder-session' };
		const laneId = 'lane-11111111-2222-4333-8444-555555555555';
		const heldLane: Lane = {
			id: laneId,
			worktreePath: '/Users/dev/app',
			branch: 'feature',
			simulatorUdid: UDID,
			environment: 'development',
			port: 8_100,
			metro: 'ready',
			logPath: '/Users/dev/lane.log',
			startedAt: now,
			agent: { ...holder, lastSeenAt: now },
		};

		/** A lane service, a native input port and an agents port that record what they are asked. */
		function services(lanesInState: Lane[]) {
			const operations: LaneOperation[] = [];
			const inputs: unknown[] = [];
			const agentOperations: AgentOperation[] = [];
			const state: LaneState = {
				revision: 1,
				updatedAt: now,
				environments: [...DEFAULT_LANE_ENVIRONMENTS],
				lanes: lanesInState,
				worktrees: [],
				repositories: [],
				deviceRequests: [],
			};
			const lanes = {
				getState: () => state,
				refresh: async () => state,
				runOperation: async (operation: LaneOperation) => {
					operations.push(operation);
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						state,
					};
				},
			};
			const simulatorInput: NonNullable<
				AgentCommandRouterDependencies['simulatorInput']
			> = async (input) => {
				inputs.push(input);
				return {
					udid: input.udid,
					kind: input.kind,
					messages: 1,
					elapsedMilliseconds: 1,
				};
			};
			const agents = {
				...holdsOnlyAgents(holder),
				runOperation: async (
					operation: AgentOperation
				): Promise<AgentState> => {
					agentOperations.push(operation);
					throw new Error('unreachable: the router must refuse first');
				},
			};
			return {
				lanes,
				simulatorInput,
				agents,
				operations,
				inputs,
				agentOperations,
			};
		}

		it('refuses every command that holds or drives a device to a claim the desktop could not verify, before any service is reached', async () => {
			const { dependencies } = fixture();
			const world = services([heldLane]);
			const handler = createAgentCommandRouter({
				...dependencies,
				lanes: world.lanes,
				simulatorInput: world.simulatorInput,
				agents: world.agents,
			});
			for (const command of [
				// The named device, a device found through the app's own lane, and no
				// device at all (a lane up with nothing to check still starts a hold).
				{
					kind: 'lane',
					operation: 'up',
					worktreePath: '/Users/dev/other',
					udid: UDID,
				},
				{ kind: 'lane', operation: 'up', worktreePath: '/Users/dev/app' },
				{ kind: 'lane', operation: 'up', worktreePath: '/Users/dev/other' },
				{ kind: 'lane', operation: 'launch', laneId },
				{ kind: 'lane', operation: 'down', laneId },
				{
					kind: 'input',
					input: { kind: 'button', udid: UDID, button: 'home' },
				},
				{ kind: 'claim', udid: UDID },
				{ kind: 'release', udid: UDID },
				{ kind: 'release', all: true },
			] as const) {
				// Whatever the cause, and each cause says what to do about it.
				for (const { cause, retryable, recovery } of UNVERIFIED_REFUSALS) {
					await expect(
						handler(command, unverified(cause))
					).rejects.toMatchObject({
						code: 'agent_identity_unverified',
						message: `The sender was not proven (${cause}).`,
						retryable,
						recovery,
					});
				}
			}
			expect(world.operations).toEqual([]);
			expect(world.inputs).toEqual([]);
			expect(world.agentOperations).toEqual([]);

			// Reads work for every identity.
			for (const caller of [unverified(), context]) {
				await expect(
					handler({ kind: 'lane', operation: 'ls' }, caller)
				).resolves.toMatchObject({ lanes: [heldLane] });
				await expect(
					handler({ kind: 'lane', operation: 'log', laneId }, caller)
				).resolves.toBeTruthy();
			}
		});

		it('refuses a lane up on a claimed device to a request that claims no session, and leaves the claim with its holder', async () => {
			const root = await mkdtemp(
				path.join(os.tmpdir(), 'rndevtools-router-identity-')
			);
			const agents = new AgentService({
				directory: root,
				lanes: () => [],
				discover: async () => ({
					sessions: [{ ...holder, title: 'holder', cwd: '/Users/dev/app' }],
					claude: 'ok',
					codex: 'ok',
				}),
				pollIntervalMs: 60_000,
				now: () => now,
			});
			try {
				await agents.start();
				const { dependencies } = fixture();
				const world = services([]);
				const handler = createAgentCommandRouter({
					...dependencies,
					agents,
					lanes: world.lanes,
				});
				await handler({ kind: 'claim', udid: UDID }, from(holder));

				// What a CLI with no session variables sends: the device is not
				// its to take, whoever's claim is on it.
				await expect(
					handler(
						{
							kind: 'lane',
							operation: 'up',
							worktreePath: '/Users/dev/app',
							udid: UDID.toLowerCase(),
						},
						context
					)
				).rejects.toMatchObject({
					code: 'device_held',
					retryable: true,
					message: expect.stringMatching(
						/claude session holder-session.*free Simulators only\.$/
					),
				});
				expect(world.operations).toEqual([]);
				expect(agents.holds().get(UDID)).toMatchObject({
					via: 'claim',
					holder,
				});

				// It may still use a free device, and then holds nothing.
				await handler(
					{
						kind: 'lane',
						operation: 'up',
						worktreePath: '/Users/dev/app',
						udid: OTHER_UDID,
					},
					context
				);
				expect(world.operations).toHaveLength(1);
				expect(world.operations[0]).not.toHaveProperty('agent');
			} finally {
				await agents.stop();
				await rm(root, { recursive: true, force: true });
			}
		});

		it('tells the lane service when a start comes from a request that claims no session, so it checks the device as nobody in its turn', async () => {
			const { dependencies } = fixture();
			const world = services([]);
			const seen: unknown[] = [];
			const handler = createAgentCommandRouter({
				...dependencies,
				lanes: {
					...world.lanes,
					runOperation: async (operation, _signal, options) => {
						seen.push(options);
						return world.lanes.runOperation(operation);
					},
				},
			});
			const up = {
				kind: 'lane',
				operation: 'up',
				worktreePath: '/Users/dev/app',
			} as const;
			await handler(up, context);
			// A verified session carries its own agent on the operation instead.
			await handler(up, from(holder));
			expect(seen).toEqual([{ requester: 'anonymous' }, undefined]);
			expect(world.operations[0]).not.toHaveProperty('agent');
			expect(world.operations[1]).toMatchObject({ agent: holder });
		});

		it('takes the lane holder from the connection, whatever a lane command says', async () => {
			const { dependencies } = fixture();
			const world = services([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				lanes: world.lanes,
				agents: world.agents,
			});
			// The protocol schema refuses an agent on a lane command, and so does
			// the type. A command that carries one anyway, as an old CLI wrote it,
			// is not read: this one names the holder to take the holder's device.
			const smuggled: Extract<AgentCliCommand, { kind: 'lane' }> = {
				kind: 'lane',
				operation: 'up',
				worktreePath: '/Users/dev/app',
				udid: UDID,
				// @ts-expect-error A lane command takes no agent; who is asking comes from the connection.
				agent: holder,
			};
			await expect(handler(smuggled, context)).rejects.toMatchObject({
				code: 'device_held',
			});
			await expect(
				handler(smuggled, from({ kind: 'codex', sessionId: 'stranger' }))
			).rejects.toMatchObject({ code: 'device_held' });
			expect(world.operations).toEqual([]);

			// The device is free for a session that is not the holder, and the lane
			// is then that session's, not the command's.
			const free = createAgentCommandRouter({
				...dependencies,
				lanes: world.lanes,
			});
			await free(smuggled, from({ kind: 'codex', sessionId: 'stranger' }));
			expect(world.operations[0]).toMatchObject({
				kind: 'lane.start',
				agent: { kind: 'codex', sessionId: 'stranger' },
			});
		});

		describe('from a request over the socket to the real identifier', () => {
			const live = { kind: 'claude' as const, sessionId: 'claude-live' };
			const neighbour = { kind: 'claude' as const, sessionId: 'claude-next' };
			const thread = { kind: 'codex' as const, sessionId: 'codex-thread' };

			/**
			 * Claude Code (pid 100) runs the live session and has an MCP server
			 * (111) and a hook shell (112) under it. Another session runs as 200,
			 * and 301 is a terminal that belongs to none.
			 */
			const processTable = [
				{ pid: 1, ppid: 0 },
				{ pid: 100, ppid: 1 },
				{ pid: 110, ppid: 100 },
				{ pid: 111, ppid: 110 },
				{ pid: 112, ppid: 100 },
				{ pid: 200, ppid: 1 },
				{ pid: 300, ppid: 1 },
				{ pid: 301, ppid: 300 },
			].map((process) => ({
				...process,
				startedAt: 'Fri Oct 23 08:00:00 2026',
			}));

			async function identityDesk() {
				const root = await mkdtemp(path.join(os.tmpdir(), 'rdt-id-'));
				let sessions: AgentState['sessions'] = [
					{ ...live, title: 'live', cwd: '/Users/dev/app', pid: 100 },
					{ ...neighbour, title: 'next', cwd: '/Users/dev/other', pid: 200 },
					{ ...thread, title: 'thread' },
				];
				let table: typeof processTable | Error = processTable;
				const agents = new AgentService({
					directory: path.join(root, 'agents'),
					lanes: () => [],
					discover: async () => ({ sessions, claude: 'ok', codex: 'ok' }),
					processTable: async () => {
						if (table instanceof Error) throw table;
						return table;
					},
					pollIntervalMs: 60_000,
					now: () => now,
				});
				await agents.start();
				const { dependencies } = fixture();
				const socketPath = path.join(root, 'sock', 'rndevtools.sock');
				const service = new AgentCliService({
					socketPath,
					platform: 'darwin',
					// The socket proof is lsof's, and agent-peer.test.ts owns it.
					verifyPeer: async () => true,
					identify: (input) => agents.identify(input),
					handler: createAgentCommandRouter({ ...dependencies, agents }),
				});
				await service.start();
				return {
					agents,
					setSessions: (value: AgentState['sessions']) => {
						sessions = value;
					},
					setTable: (value: typeof table) => {
						table = value;
					},
					/** One request as the Go CLI sends it, answered as it gets it. */
					send: (
						command: Record<string, unknown>,
						extra: { agent?: Holder; pid?: number }
					) =>
						new Promise<AgentCliResponse>((resolve, reject) => {
							const socket = connect(socketPath);
							const chunks: Buffer[] = [];
							socket.once('error', reject);
							socket.on('data', (chunk: Buffer) => chunks.push(chunk));
							socket.once('end', () =>
								resolve(
									JSON.parse(
										Buffer.concat(chunks).toString('utf8')
									) as AgentCliResponse
								)
							);
							socket.once('connect', () =>
								socket.end(
									`${JSON.stringify({
										protocol: 'rndevtools/1',
										id: 'cli-identity',
										command,
										...(extra.agent ? { agent: extra.agent } : {}),
										...(extra.pid ? { peer: { pid: extra.pid } } : {}),
									})}\n`
								)
							);
						}),
					close: async () => {
						await service.stop();
						await agents.stop();
						await rm(root, { recursive: true, force: true });
					},
				};
			}

			it('serves an MCP server that predates a /clear as the session it runs under, reads and holds alike', async () => {
				const { agents, send, close } = await identityDesk();
				try {
					// The id the session had before the /clear, and the shared id an MCP
					// server makes up when it has no session variable at all.
					for (const claimed of [
						{ kind: 'claude' as const, sessionId: 'claude-before-clear' },
						{ kind: 'claude' as const, sessionId: 'mcp-claude-code' },
					]) {
						for (const command of [
							{ kind: 'agents' },
							{ kind: 'simulators', includeUnavailable: false },
						]) {
							expect(
								await send(command, { agent: claimed, pid: 111 })
							).toMatchObject({ ok: true });
						}
						await expect(
							send({ kind: 'claim', udid: UDID }, { agent: claimed, pid: 111 })
						).resolves.toMatchObject({ ok: true, result: { you: live } });
						expect(agents.getState().claims).toMatchObject([live]);
						await send(
							{ kind: 'release', udid: UDID },
							{ agent: live, pid: 111 }
						);
					}
				} finally {
					await close();
				}
			});

			it('tells each other caller what went wrong and what to do', async () => {
				const { send, setTable, close } = await identityDesk();
				try {
					// A Codex thread, which shares one process, can read: only holding
					// and driving a device need a session the desktop can place.
					expect(
						await send({ kind: 'agents' }, { agent: thread, pid: 301 })
					).toMatchObject({ ok: true });

					// A live session that the sending process does not run under is
					// refused outright, even for a read.
					const mismatch = {
						code: 'agent_identity_mismatch',
						message:
							'The request names a session other than the one the sending process runs under.',
						retryable: false,
						recovery:
							'Run the tool from inside your own agent session; an MCP server that predates a /clear is fixed by reconnecting it.',
					};
					for (const command of [
						{ kind: 'agents' },
						{ kind: 'claim', udid: UDID },
					]) {
						expect(
							await send(command, { agent: neighbour, pid: 111 })
						).toHaveProperty('error', mismatch);
					}

					// The same thread cannot hold, and is told that nothing it can do from
					// the request changes that.
					const claim = { kind: 'claim', udid: UDID };
					expect(await send(claim, { agent: thread, pid: 301 })).toHaveProperty(
						'error',
						{
							code: 'agent_identity_unverified',
							message:
								'This caller cannot be tied to a running Claude Code session, so it cannot hold or drive Simulators. Reads still work.',
							retryable: false,
							recovery:
								'Ask the user to act in RN Devtools. A request that names no session may use free Simulators (for the CLI, run it without CODEX_THREAD_ID and RNDEVTOOLS_AGENT_SESSION_ID set).',
						}
					);

					// A CLI that names no process, or a process list that cannot be read:
					// a failed check, which a retry can pass.
					expect(await send(claim, { agent: live })).toHaveProperty('error', {
						code: 'agent_identity_unverified',
						message:
							'RN Devtools could not confirm which process sent the request (an older rndevtools command-line tool does not name its process, or the check timed out).',
						retryable: true,
						recovery:
							'Retry; if it keeps failing, update the tool with "rndevtools setup" and run it from inside the agent session.',
					});
					setTable(new Error('ps is not available'));
					expect(await send(claim, { agent: live, pid: 111 })).toHaveProperty(
						'error',
						{
							code: 'agent_identity_unverified',
							message:
								'RN Devtools could not read the process list to find the session.',
							retryable: true,
							recovery: 'Retry.',
						}
					);
				} finally {
					await close();
				}
			});

			it('releases a session’s claim from its session-end hook after Claude Code deleted its registry file', async () => {
				const { agents, send, setSessions, close } = await identityDesk();
				try {
					await send({ kind: 'claim', udid: UDID }, { agent: live, pid: 111 });
					expect(agents.getState().claims).toHaveLength(1);
					// Claude Code deletes the file, then runs the hook; the desktop's poll
					// in between finds the session gone.
					setSessions([]);
					await agents.refresh();
					expect(agents.getState().sessions).toEqual([]);
					await expect(
						send(
							{ kind: 'release', all: true, sessionCwd: '/Users/dev/app' },
							{ agent: live, pid: 112 }
						)
					).resolves.toMatchObject({
						ok: true,
						result: { you: live, releasedClaims: [UDID] },
					});
					expect(agents.getState().claims).toEqual([]);
				} finally {
					await close();
				}
			});
		});
	});
});
