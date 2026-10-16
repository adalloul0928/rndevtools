import { describe, expect, it } from 'vitest';
import type { AgentOperation, AgentState } from '../shared/agent-protocol';
import { createDemoDevice } from '../shared/demo-data';
import {
	DEFAULT_LANE_ENVIRONMENTS,
	type Lane,
	type LaneOperation,
	type LaneState,
} from '../shared/lane-protocol';
import type { DesktopAction, DesktopState } from '../shared/protocol';
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
import type { AgentCliError } from './agent-cli-service';
import { createAgentCommandRouter } from './agent-command-router';
import { NativeHostResponseError } from './native-host-client';

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

const context = {
	requestId: 'cli-0123456789abcdef0123456789abcdef',
	signal: new AbortController().signal,
};

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
		const { dependencies } = fixture();
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
					{ ...context, agent: me }
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
		// Without a session, no requester rides along: the service treats the
		// request as the operator's.
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
					requester
						? {
								allowed: false,
								reason: `Simulator ${udid} is held by claude session owner through lane lane-1.`,
								hold: {
									simulatorUdid: udid,
									via: 'lane',
									laneId: 'lane-1',
									holder: { kind: 'claude', sessionId: 'owner' },
									holderLive: true,
								},
							}
						: { allowed: true },
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
				{ ...context, agent: { kind: 'codex', sessionId: 'stranger' } }
			)
		).rejects.toMatchObject({ code: 'device_held' });
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
				{ ...context, agent: { kind: 'codex', sessionId: 'stranger' } }
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
				/expo run:ios --configuration Debug --no-bundler/
			);
			expect(actions).toHaveLength(0);
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
						state.claims = [];
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
			})({ kind: 'agents' }, { ...context, agent: session })) as Record<
				string,
				unknown
			>;
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
				{ ...context, agent: session }
			)) as Record<string, unknown>;
			expect(operations[0]).toEqual({
				kind: 'agent.claim',
				simulatorUdid: UDID,
				agent: session,
				note: 'checkout flow',
			});
			expect(claimed).toMatchObject({ udid: UDID, you: session });
			expect((claimed.agents as unknown[]).length).toBe(1);
			await handler(
				{ kind: 'release', udid: UDID },
				{ ...context, agent: session }
			);
			expect(operations[1]).toEqual({
				kind: 'agent.release',
				simulatorUdid: UDID,
				agent: session,
			});
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
				}),
				refresh: async () => lanes.getState(),
				runOperation: async (operation: LaneOperation) => {
					laneOperations.push(operation);
					return { ...operation, completed: true, state: lanes.getState() };
				},
			};
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
				lanes,
			});
			const result = (await handler(
				{ kind: 'release', all: true },
				{ ...context, agent: me }
			)) as {
				stoppedLanes: string[];
				releasedClaims: string[];
				errors: string[];
			};
			expect(result).toEqual({
				you: me,
				stoppedLanes: ['lane-11111111-2222-4333-8444-555555555555'],
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

		it('records a touch for every device-targeted command that carried a session, after it succeeds', async () => {
			const { dependencies } = fixture();
			const { port, touches } = agentsPort();
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
			});
			// Simulator-targeted by UDID.
			await handler(
				{ kind: 'screen', target: { udid: UDID } },
				{ ...context, agent: session }
			);
			// Connected-app target resolves to the Simulator the session reported.
			await handler(
				{ kind: 'screen', target: { deviceId: 'rndevtools-demo-ios' } },
				{ ...context, agent: session }
			);
			// Fleet-wide commands and failed commands do not touch.
			await handler(
				{ kind: 'simulators', includeUnavailable: false },
				{ ...context, agent: session }
			);
			await expect(
				handler(
					{
						kind: 'screen',
						target: { udid: '00000000-0000-4000-8000-000000000000' },
					},
					{ ...context, agent: session }
				)
			).rejects.toBeTruthy();
			// No session, no touch.
			await handler({ kind: 'screen', target: { udid: UDID } }, context);
			expect(touches).toEqual([
				{ agent: session, udid: UDID },
				{ agent: session, udid: UDID },
			]);
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
				{ ...context, agent: { kind: 'claude', sessionId: 'claude-1' } }
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

	it('refuses lane up, lane down, and input on a device another agent holds', async () => {
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
		};
		const operations: LaneOperation[] = [];
		const inputs: unknown[] = [];
		const access = (
			udid: string,
			requester?: { kind: string; sessionId: string }
		) =>
			!requester || requester.sessionId === owner.sessionId
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
					return { ...operation, completed: true, lane, state };
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
		const asStranger = { ...context, agent: stranger };
		const asOwner = { ...context, agent: owner };

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

		// The holder, and the operator (no agent on the request), get through.
		await handler(
			{ kind: 'lane', operation: 'down', laneId: lane.id },
			asOwner
		);
		await handler(
			{ kind: 'lane', operation: 'down', laneId: lane.id },
			context
		);
		await handler(
			{ kind: 'input', input: { kind: 'button', udid: UDID, button: 'home' } },
			asOwner
		);
		expect(operations.map((operation) => operation.kind)).toEqual([
			'lane.stop',
			'lane.stop',
		]);
		expect(inputs).toHaveLength(1);
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
					return { ...operation, completed: true, lane, state };
				}
				if (operation.kind === 'lane.log') {
					return { ...operation, completed: true, lane, log: 'metro ready' };
				}
				if (operation.kind === 'lane.stop') {
					state = { ...state, lanes: [] };
					return { ...operation, completed: true, state };
				}
				return { ...operation, completed: true, lane, state };
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
				agent: { kind: 'claude', sessionId: 'session-1' },
			},
			context
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
			}),
			refresh: async () => ({
				revision: 1,
				updatedAt: now,
				environments: [...DEFAULT_LANE_ENVIRONMENTS],
				lanes: [],
				worktrees: [],
				repositories: [],
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
});
