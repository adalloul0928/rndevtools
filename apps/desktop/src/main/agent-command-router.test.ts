import { describe, expect, it } from 'vitest';
import { createDemoDevice } from '../shared/demo-data';
import type { DesktopAction, DesktopState } from '../shared/protocol';
import type {
	SimulatorAction,
	SimulatorState,
} from '../shared/simulator-protocol';
import { simulatorStateSchema } from '../shared/simulator-protocol';
import type {
	SlimmingAction,
	SlimmingState,
} from '../shared/slimming-protocol';
import { slimmingStateSchema } from '../shared/slimming-protocol';
import type { AgentCliError } from './agent-cli-service';
import { createAgentCommandRouter } from './agent-command-router';

const UDID = '11111111-2222-3333-4444-555555555555';
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
});
