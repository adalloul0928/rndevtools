import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lane } from '../shared/lane-protocol';
import type {
	SimulatorAction,
	SimulatorJob,
	SimulatorState,
} from '../shared/simulator-protocol';
import type {
	SlimmingAction,
	SlimmingJob,
	SlimmingState,
} from '../shared/slimming-protocol';
import type { MetroLaunchInput, MetroSupervisorPort } from './lane-metro';
import {
	LaneService,
	type LaneSimulatorPort,
	type LaneSlimmingPort,
} from './lane-service';
import { LaneStore } from './lane-store';
import type {
	DiscoveredWorktree,
	WorktreeInspectorPort,
} from './lane-worktree';
import type { SimulatorMutationLease } from './simulator-mutation-coordinator';
import { SimulatorMutationCoordinator } from './simulator-mutation-coordinator';

const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const OTHER_UDID = 'FFFFFFFF-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const REPO = '/Users/dev/app';
const WORKTREE = '/Users/dev/app-feature-a';

function simulatorState(
	devices: Array<{ udid: string; state: 'booted' | 'shutdown' }>,
	jobs: SimulatorJob[] = []
): SimulatorState {
	return {
		revision: 1,
		updatedAt: 1,
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
		devices: devices.map((device) => ({
			udid: device.udid,
			name: `Sim ${device.udid.slice(0, 4)}`,
			state: device.state,
			runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
			isAvailable: true,
		})),
		appsByDevice: {},
		diskByDevice: {},
		jobs,
		captures: [],
		metrics: { status: 'available', byDevice: {} },
		native: {
			status: 'available',
			permissionInspection: false,
			permissionPrompting: false,
			permissions: [],
		},
	} as unknown as SimulatorState;
}

class FakeSimulator implements LaneSimulatorPort {
	readonly actions: SimulatorAction[] = [];
	readonly listeners = new Set<(state: SimulatorState) => void>();
	state: SimulatorState;
	failNext: string | undefined;
	/** Bundle ids `app.list` reports as installed; undefined = everything. */
	installedApps: string[] | undefined;

	constructor(devices: Array<{ udid: string; state: 'booted' | 'shutdown' }>) {
		this.state = simulatorState(devices);
	}

	getState = () => this.state;
	refresh = async () => this.state;
	cancelJob = () => true;
	subscribe = (listener: (state: SimulatorState) => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	runAction = (action: SimulatorAction) => {
		this.actions.push(action);
		const jobId = `simulator-${this.actions.length}`;
		const failure = this.failNext;
		this.failNext = undefined;
		queueMicrotask(() => {
			const job = {
				id: jobId,
				actionId: action.actionId,
				kind: action.kind,
				status: failure ? 'failed' : 'complete',
				progressSequence: 1,
				phase: failure ? 'failed' : 'complete',
				createdAt: 1,
				finishedAt: 2,
				message: failure ?? 'done',
				deviceUdid: 'udid' in action ? action.udid : undefined,
			} as unknown as SimulatorJob;
			if (action.kind === 'device.boot' && !failure) {
				this.state = simulatorState(
					this.state.devices.map((device) => ({
						udid: device.udid,
						state: 'booted' as const,
					})),
					[job]
				);
			} else if (action.kind === 'app.list' && !failure) {
				const installed = this.installedApps ?? ['com.example.app'];
				this.state = {
					...this.state,
					jobs: [...this.state.jobs, job],
					appsByDevice: {
						...this.state.appsByDevice,
						[action.udid]: installed.map((bundleIdentifier) => ({
							bundleIdentifier,
							displayName: bundleIdentifier,
							isSystem: false,
						})),
					},
				};
			} else {
				this.state = { ...this.state, jobs: [...this.state.jobs, job] };
			}
			for (const listener of this.listeners) listener(this.state);
		});
		return { actionId: action.actionId, accepted: true, jobId };
	};
}

/**
 * Stand-in for the SimSlim service. It records every action and the lease it
 * arrived with, and lets a test decide whether the gate rejects the action
 * (`rejectWith`) or the job fails after it was accepted (`failWith`).
 */
class FakeSlimming implements LaneSlimmingPort {
	readonly actions: Array<{
		action: SlimmingAction;
		lease: SimulatorMutationLease | undefined;
	}> = [];
	readonly listeners = new Set<(state: SlimmingState) => void>();
	rejectWith: string | undefined;
	failWith: string | undefined;
	helperStatus: SlimmingState['helper']['status'] = 'available';
	refreshes = 0;
	state: SlimmingState = {
		revision: 1,
		updatedAt: 1,
		setting: { experimentalMutationsEnabled: true },
		helper: { status: 'available', readOnlyAvailable: true },
		categories: [],
		profiles: [
			{
				id: 'rndevtools-development',
				name: 'Development',
				description: 'Trims the usual suspects.',
				categoryIds: [],
				experimental: true,
			},
		],
		simulators: [],
		statusBySimulator: {},
		previewBySimulator: {},
		doctorBySimulator: {},
		jobs: [],
		checkpointBySimulator: {},
		operationsBySimulator: {},
	};

	getState = () => ({
		...this.state,
		helper: { ...this.state.helper, status: this.helperStatus },
	});
	refresh = async () => {
		this.refreshes += 1;
		return this.getState();
	};
	cancelJob = () => true;
	subscribe = (listener: (state: SlimmingState) => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	runAction = (
		action: SlimmingAction,
		lease?: SimulatorMutationLease
	): {
		actionId: string;
		accepted: boolean;
		jobId?: string;
		error?: string;
	} => {
		this.actions.push({ action, lease });
		if (this.rejectWith) {
			return {
				actionId: action.actionId,
				accepted: false,
				error: this.rejectWith,
			};
		}
		const jobId = `slimming-${this.actions.length}`;
		const failure = this.failWith;
		queueMicrotask(() => {
			const job = {
				id: jobId,
				actionId: action.actionId,
				kind: action.kind,
				status: failure ? 'failed' : 'complete',
				progressSequence: 1,
				phase: failure ? 'failed' : 'complete',
				message: failure ?? 'Profile applied and verified.',
				createdAt: 1,
				finishedAt: 2,
				currentIndex: 1,
				total: 1,
				profileId: 'profileId' in action ? action.profileId : undefined,
				targets: action.simulatorUdids.map((simulatorUdid) => ({
					simulatorUdid,
					status: failure ? 'failed' : 'complete',
					message: failure ?? 'done',
				})),
			} as unknown as SlimmingJob;
			this.state = { ...this.state, jobs: [...this.state.jobs, job] };
			for (const listener of this.listeners) listener(this.getState());
		});
		return { actionId: action.actionId, accepted: true, jobId };
	};
}

class FakeMetro implements MetroSupervisorPort {
	readonly started: MetroLaunchInput[] = [];
	readonly stopped: Array<{ pid: number; port: number }> = [];
	readonly busyPorts = new Set<number>();
	readonly healthyPorts = new Set<number>();
	readonly deadPids = new Set<number>();
	nextPid = 1_000;
	logs = new Map<string, string>();

	isPortFree = async (port: number) => !this.busyPorts.has(port);
	start = async (input: MetroLaunchInput) => {
		this.started.push(input);
		this.nextPid += 1;
		return this.nextPid;
	};
	isHealthy = async (port: number) => this.healthyPorts.has(port);
	isProcessRunning = (pid: number) => !this.deadPids.has(pid);
	stop = async (pid: number, port: number) => {
		this.stopped.push({ pid, port });
	};
	readLogTail = async (logPath: string) => this.logs.get(logPath) ?? '';
}

class FakeWorktrees implements WorktreeInspectorPort {
	worktrees: DiscoveredWorktree[] = [
		{ path: REPO, branch: 'main', repositoryRoot: REPO, dirty: false },
		{ path: WORKTREE, branch: 'feature/a', repositoryRoot: REPO, dirty: true },
	];
	identity: { scheme?: string; bundleIdentifier?: string } = {
		scheme: 'exampleapp',
		bundleIdentifier: 'com.example.app',
	};
	repositoryRoot = async (worktreePath: string) => {
		if (!worktreePath.startsWith('/Users/dev/app')) {
			throw new Error(`${worktreePath} is not inside a git repository.`);
		}
		return REPO;
	};
	listWorktrees = async () => this.worktrees;
	readExpoIdentity = async () => this.identity;
}

describe('LaneService', () => {
	let root: string;
	let store: LaneStore;
	let simulator: FakeSimulator;
	let metro: FakeMetro;
	let worktrees: FakeWorktrees;
	let slimming: FakeSlimming;
	let now: number;
	let service: LaneService;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-lane-service-'));
		store = new LaneStore(root);
		simulator = new FakeSimulator([
			{ udid: UDID, state: 'shutdown' },
			{ udid: OTHER_UDID, state: 'booted' },
		]);
		metro = new FakeMetro();
		worktrees = new FakeWorktrees();
		slimming = new FakeSlimming();
		now = 1_700_000_000_000;
		service = new LaneService({
			store,
			simulator,
			slimming,
			mutationCoordinator: new SimulatorMutationCoordinator(),
			metro,
			worktrees,
			now: () => now,
		});
		await service.start();
	});

	function healthyMetro() {
		metro.start = async (input) => {
			metro.started.push(input);
			metro.healthyPorts.add(input.port);
			return 4_242;
		};
	}

	function startWithSlim(options?: { slimApproved?: boolean }) {
		return service.runOperation(
			{
				actionId: `op-slim-${Math.random().toString(16).slice(2)}`,
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: true,
				slimProfileId: 'rndevtools-development',
			},
			undefined,
			options
		);
	}

	afterEach(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});

	it('boots the simulator, leases a port, starts Metro, and deep-links the dev client', async () => {
		// Metro becomes healthy as soon as it is started.
		metro.start = async (input) => {
			metro.started.push(input);
			metro.healthyPorts.add(input.port);
			return 4_242;
		};
		const receipt = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: true,
			agent: { kind: 'claude', sessionId: 'session-1' },
		});
		expect(receipt.completed).toBe(true);
		expect(receipt.lane).toMatchObject({
			worktreePath: WORKTREE,
			branch: 'feature/a',
			simulatorUdid: UDID,
			port: 8_100,
			metroPid: 4_242,
			metro: 'ready',
			scheme: 'exampleapp',
			bundleIdentifier: 'com.example.app',
			agent: { kind: 'claude', sessionId: 'session-1', lastSeenAt: now },
		});
		expect(simulator.actions.map((action) => action.kind)).toEqual([
			'device.boot',
			'app.list',
			'url.open',
		]);
		const launch = simulator.actions[2] as Extract<
			SimulatorAction,
			{ kind: 'url.open' }
		>;
		expect(launch.url).toBe(
			'exampleapp://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8100&disableOnboarding=1&disableAutoLaunch=1'
		);
		expect(metro.started[0]).toMatchObject({
			worktreePath: WORKTREE,
			port: 8_100,
			maxWorkers: 2,
		});
		expect(
			service.getState().worktrees.find((w) => w.path === WORKTREE)
		).toMatchObject({
			dirty: true,
			laneId: receipt.lane?.id,
		});
		expect(service.getState().repositories).toEqual([REPO]);
	});

	it('does not boot an already-booted simulator', async () => {
		metro.healthyPorts.add(8_100);
		await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: REPO,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: true,
		});
		expect(simulator.actions.map((action) => action.kind)).toEqual([
			'app.list',
			'url.open',
		]);
	});

	it('treats a repeated lane up for the same app and Simulator as a resume', async () => {
		metro.healthyPorts.add(8_100);
		const first = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(first.completed).toBe(true);
		const laneId = first.lane?.id;
		expect(metro.started).toHaveLength(1);

		// Metro still healthy: nothing restarts, the same lane comes back.
		const again = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID.toLowerCase(),
			environment: 'development',
			launch: false,
		});
		expect(again.completed).toBe(true);
		expect(again.lane?.id).toBe(laneId);
		expect(metro.started).toHaveLength(1);
		expect(service.getState().lanes).toHaveLength(1);

		// Metro died: resume starts a new one on the lane's own port.
		metro.healthyPorts.delete(8_100);
		metro.deadPids.add(first.lane?.metroPid ?? -1);
		const resumed = await service.runOperation({
			actionId: 'op-3',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(resumed.completed).toBe(true);
		expect(resumed.lane?.id).toBe(laneId);
		expect(metro.started).toHaveLength(2);
		expect(metro.started[1]).toMatchObject({
			port: 8_100,
			worktreePath: WORKTREE,
		});
		expect(resumed.lane?.metroPid).not.toBe(first.lane?.metroPid);
	});

	it('refuses to steal a worktree, a simulator, or a leased port', async () => {
		metro.healthyPorts.add(8_100);
		metro.healthyPorts.add(8_101);
		const first = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(first.completed).toBe(true);

		const sameWorktree = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		expect(sameWorktree).toMatchObject({ completed: false });
		expect(sameWorktree.error).toMatch(/already has lane/);

		const sameDevice = await service.runOperation({
			actionId: 'op-3',
			kind: 'lane.start',
			worktreePath: REPO,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(sameDevice.error).toMatch(/already assigned/);

		const second = await service.runOperation({
			actionId: 'op-4',
			kind: 'lane.start',
			worktreePath: REPO,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		expect(second.lane?.port).toBe(8_101);
		expect(metro.started).toHaveLength(2);
	});

	it('runs a monorepo app from its subdirectory while keying the lane on the containing worktree', async () => {
		healthyMetro();
		const receipt = await service.runOperation({
			actionId: 'op-mono',
			kind: 'lane.start',
			worktreePath: `${WORKTREE}/examples/demo`,
			simulatorUdid: UDID,
			environment: 'development',
			launch: true,
		});
		expect(receipt.completed).toBe(true);
		expect(receipt.lane).toMatchObject({
			worktreePath: WORKTREE,
			appPath: `${WORKTREE}/examples/demo`,
			branch: 'feature/a',
		});
		// Metro and the Expo config come from the app directory, not the root.
		expect(metro.started[0]?.worktreePath).toBe(`${WORKTREE}/examples/demo`);
		// A second app in the same worktree may have its own lane…
		const sibling = await service.runOperation({
			actionId: 'op-mono-2',
			kind: 'lane.start',
			worktreePath: `${WORKTREE}/examples/other`,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		expect(sibling.completed).toBe(true);
		// …but the same app may not have two.
		const duplicate = await service.runOperation({
			actionId: 'op-mono-3',
			kind: 'lane.start',
			worktreePath: `${WORKTREE}/examples/demo`,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		expect(duplicate.completed).toBe(false);
		expect(duplicate.error).toMatch(/examples\/demo already has lane/);
		// Stopping proves ownership by the leased port, not a path.
		await service.runOperation({
			actionId: 'op-mono-stop',
			kind: 'lane.stop',
			laneId: receipt.lane?.id ?? '',
		});
		expect(metro.stopped[0]).toEqual({ pid: 4_242, port: 8_100 });
	});

	it('rejects a path outside every worktree and an unknown environment', async () => {
		worktrees.repositoryRoot = async () => REPO;
		worktrees.worktrees = [
			{ path: REPO, branch: 'main', repositoryRoot: REPO, dirty: false },
		];
		const outside = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: '/Users/dev/app-feature-a',
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(outside.error).toMatch(/not inside a worktree of/);
		const environment = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.start',
			worktreePath: REPO,
			simulatorUdid: UDID,
			environment: 'nope',
			launch: false,
		});
		expect(environment.error).toMatch(/Unknown lane environment/);
		expect(metro.started).toHaveLength(0);
	});

	it('does not start Metro when the simulator fails to boot', async () => {
		simulator.failNext = 'CoreSimulator refused to boot.';
		const receipt = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(receipt.error).toBe('CoreSimulator refused to boot.');
		expect(metro.started).toHaveLength(0);
		expect(service.getState().lanes).toHaveLength(0);
	});

	it('reports a Metro that exited before becoming ready and keeps the lease for inspection', async () => {
		metro.start = async (input) => {
			metro.started.push(input);
			metro.deadPids.add(7);
			return 7;
		};
		const receipt = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: true,
		});
		expect(receipt.completed).toBe(false);
		expect(receipt.error).toMatch(/exited before it became ready/);
		expect(service.getState().lanes).toHaveLength(1);
		expect(simulator.actions.map((action) => action.kind)).toEqual([
			'device.boot',
		]);
	});

	it('times out a Metro that never answers /status', async () => {
		metro.start = async (input) => {
			metro.started.push(input);
			return 9;
		};
		const started = service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: true,
		});
		// Advance the injected clock past the deadline between polls.
		const advance = setInterval(() => {
			now += 5_000;
		}, 5);
		const receipt = await started;
		clearInterval(advance);
		expect(receipt.completed).toBe(false);
		expect(receipt.error).toMatch(/did not become ready/);
		expect(service.getState().lanes[0]?.metro).toBe('starting');
	});

	it('launches deep links through the lane scheme and refreshes agent attribution', async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		now += 1_000;
		const launched = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.launch',
			laneId: started.lane?.id as string,
			url: 'checkout/cart',
			agent: { kind: 'codex', sessionId: 'thread-9' },
		});
		expect(launched.completed).toBe(true);
		expect(launched.lane).toMatchObject({
			metro: 'ready',
			lastLaunchedAt: now,
			agent: { kind: 'codex', sessionId: 'thread-9', lastSeenAt: now },
		});
		const open = simulator.actions.at(-1) as Extract<
			SimulatorAction,
			{ kind: 'url.open' }
		>;
		expect(open.url).toBe('exampleapp://checkout/cart');
	});

	it('stops only the Metro the lane owns and releases the lease', async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		const laneId = started.lane?.id as string;
		const stopped = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.stop',
			laneId,
		});
		expect(stopped.completed).toBe(true);
		expect(metro.stopped).toEqual([{ pid: 1_001, port: 8_100 }]);
		expect(service.getState().lanes).toHaveLength(0);
		const again = await service.runOperation({
			actionId: 'op-3',
			kind: 'lane.stop',
			laneId,
		});
		expect(again.error).toMatch(/does not exist/);
	});

	it('returns the Metro log tail for a lane', async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		const lane = started.lane as Lane;
		metro.logs.set(
			lane.logPath,
			'Starting Metro Bundler\nWaiting on http://localhost:8100'
		);
		const log = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.log',
			laneId: lane.id,
			maxCharacters: 1_024,
		});
		expect(log.log).toContain('Waiting on http://localhost:8100');
	});

	it('reconciles leases on restart: dead Metros become stopped, the owner stays recorded', async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: true,
			agent: { kind: 'claude', sessionId: 'session-1' },
		});
		const lane = started.lane as Lane;
		await service.stop();

		metro.deadPids.add(lane.metroPid as number);
		now += 31 * 60 * 1_000;
		const reopened = new LaneService({
			store: new LaneStore(root),
			simulator,
			metro,
			worktrees,
			now: () => now,
		});
		await reopened.start();
		const state = reopened.getState();
		expect(state.lanes[0]).toMatchObject({ id: lane.id, metro: 'stopped' });
		// The agent is the hold's owner; it is not forgotten just because it has
		// been quiet. Whether it is still alive is the agent service's call.
		expect(state.lanes[0]?.agent).toMatchObject({ sessionId: 'session-1' });
		// A stopped lane frees its port for the next lease.
		const next = await reopened.runOperation({
			actionId: 'op-2',
			kind: 'lane.start',
			worktreePath: REPO,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		expect(next.lane?.port).toBe(8_100);
		await reopened.stop();
	});

	it('releases a lane whose owner has been gone past the grace period, and only then', async () => {
		metro.healthyPorts.add(8_100);
		let holderLive = true;
		let releaseAt: number | undefined;
		const withHolds = new LaneService({
			store: new LaneStore(root),
			simulator,
			metro,
			worktrees,
			now: () => now,
			holds: () =>
				new Map(
					withHolds.getState().lanes.map((lane) => [
						lane.simulatorUdid.toUpperCase(),
						{
							simulatorUdid: lane.simulatorUdid.toUpperCase(),
							via: 'lane' as const,
							laneId: lane.id,
							holder: { kind: 'claude' as const, sessionId: 'session-1' },
							holderLive,
							...(holderLive ? {} : { abandonedSince: now - 1, releaseAt }),
						},
					])
				),
		});
		await withHolds.start();
		const started = await withHolds.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
			agent: { kind: 'claude', sessionId: 'session-1' },
		});
		const lane = started.lane as Lane;

		// Owner alive: nothing happens on reconcile.
		await withHolds.runOperation({ actionId: 'op-r1', kind: 'lane.refresh' });
		expect(withHolds.getState().lanes).toHaveLength(1);

		// Owner gone but inside the grace period: still nothing.
		holderLive = false;
		releaseAt = now + 5 * 60_000;
		await withHolds.runOperation({ actionId: 'op-r2', kind: 'lane.refresh' });
		expect(withHolds.getState().lanes).toHaveLength(1);
		expect(metro.stopped).toEqual([]);

		// Grace elapsed: the lane is torn down and its Metro stopped.
		now = releaseAt;
		await withHolds.runOperation({ actionId: 'op-r3', kind: 'lane.refresh' });
		expect(withHolds.getState().lanes).toEqual([]);
		expect(metro.stopped).toEqual([{ pid: lane.metroPid, port: lane.port }]);
		await withHolds.stop();
	});

	it('notifies subscribers with a validated state on every change', async () => {
		const listener = vi.fn();
		service.subscribe(listener);
		metro.healthyPorts.add(8_100);
		await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(listener).toHaveBeenCalled();
		const last = listener.mock.lastCall?.[0];
		expect(last.lanes).toHaveLength(1);
		expect(last.environments.map((env: { id: string }) => env.id)).toContain(
			'development'
		);
	});

	it('surfaces repository discovery errors without hiding the rest of the state', async () => {
		worktrees.listWorktrees = async () => {
			throw new Error('fatal: not a git repository');
		};
		await service.addRepository(REPO).catch(() => undefined);
		const state = await service.refresh();
		expect(state.error).toMatch(/not a git repository/);
		expect(state.repositories).toEqual([REPO]);
	});

	describe('slimming on lane start', () => {
		it('parks an unapproved slim request in needs-approval and still starts Metro and launches', async () => {
			healthyMetro();
			const receipt = await startWithSlim();
			expect(receipt.completed).toBe(true);
			expect(receipt.lane?.slim).toMatchObject({
				profileId: 'rndevtools-development',
				status: 'needs-approval',
			});
			expect(receipt.lane?.slim?.message).toMatch(/operator approval/i);
			expect(receipt.lane?.metro).toBe('ready');
			// The gate was never even asked: no SimSlim action ran.
			expect(slimming.actions).toHaveLength(0);
			expect(simulator.actions.map((action) => action.kind)).toEqual([
				'device.boot',
				'app.list',
				'url.open',
			]);
		});

		it('applies the profile under a mutation lease when main says the operator approved', async () => {
			healthyMetro();
			const receipt = await startWithSlim({ slimApproved: true });
			expect(receipt.completed).toBe(true);
			expect(receipt.lane?.slim).toMatchObject({
				profileId: 'rndevtools-development',
				status: 'applied',
				jobId: 'slimming-1',
			});
			expect(slimming.refreshes).toBe(1);
			expect(slimming.actions).toHaveLength(1);
			const first = slimming.actions[0];
			expect(first?.action).toMatchObject({
				kind: 'profile.apply',
				profileId: 'rndevtools-development',
				simulatorUdids: [UDID],
				confirmation: 'APPLY_EXPERIMENTAL_PROFILE',
			});
			expect(first?.lease?.simulatorUdid).toBe(UDID);
			// Order: boot, slim, then Metro + launch.
			expect(simulator.actions.map((action) => action.kind)).toEqual([
				'device.boot',
				'app.list',
				'url.open',
			]);
			expect(metro.started).toHaveLength(1);
		});

		it('records a rejection from the SimSlim gate as skipped and keeps the lane usable', async () => {
			healthyMetro();
			slimming.rejectWith = 'Experimental Simulator mutations are disabled.';
			const receipt = await startWithSlim({ slimApproved: true });
			expect(receipt.completed).toBe(true);
			expect(receipt.lane?.slim).toMatchObject({
				status: 'skipped',
				message: 'Experimental Simulator mutations are disabled.',
			});
			expect(receipt.lane?.metro).toBe('ready');
		});

		it('records a failed SimSlim job as failed without aborting the lane', async () => {
			healthyMetro();
			slimming.failWith = 'native host mutation_authorization_required';
			const receipt = await startWithSlim({ slimApproved: true });
			expect(receipt.completed).toBe(true);
			expect(receipt.lane?.slim).toMatchObject({
				status: 'failed',
				message: 'native host mutation_authorization_required',
				jobId: 'slimming-1',
			});
			expect(receipt.lane?.metro).toBe('ready');
		});

		it('fails fast on an unknown profile before booting or starting Metro', async () => {
			const receipt = await service.runOperation({
				actionId: 'op-bad-profile',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: true,
				slimProfileId: 'nope',
			});
			expect(receipt.completed).toBe(false);
			expect(receipt.error).toMatch(/Unknown SimSlim profile "nope"/);
			expect(receipt.error).toMatch(/rndevtools-development/);
			expect(simulator.actions).toHaveLength(0);
			expect(metro.started).toHaveLength(0);
		});

		it('refuses --slim when the helper is unavailable', async () => {
			slimming.helperStatus = 'unavailable';
			const receipt = await startWithSlim();
			expect(receipt.completed).toBe(false);
			expect(receipt.error).toMatch(/helper is unavailable/i);
		});

		it('approves later: runs the mutation and relaunches the dev client', async () => {
			healthyMetro();
			const started = await startWithSlim();
			const laneId = started.lane?.id ?? '';
			simulator.actions.length = 0;
			// Approval without main's option is refused, so the IPC layer is the
			// only path in.
			const refused = await service.runOperation({
				actionId: 'op-approve-no-option',
				kind: 'lane.slim',
				laneId,
				decision: 'approve',
			});
			expect(refused.completed).toBe(false);
			expect(refused.error).toMatch(/operator approval/i);
			expect(slimming.actions).toHaveLength(0);

			const approved = await service.runOperation(
				{
					actionId: 'op-approve',
					kind: 'lane.slim',
					laneId,
					decision: 'approve',
				},
				undefined,
				{ slimApproved: true }
			);
			expect(approved.completed).toBe(true);
			expect(approved.lane?.slim).toMatchObject({ status: 'applied' });
			expect(slimming.actions).toHaveLength(1);
			expect(simulator.actions.map((action) => action.kind)).toEqual([
				'app.list',
				'url.open',
			]);
			expect(approved.lane?.lastLaunchedAt).toBe(now);
		});

		it('dismisses a pending request and refuses to decide twice', async () => {
			healthyMetro();
			const started = await startWithSlim();
			const laneId = started.lane?.id ?? '';
			const dismissed = await service.runOperation({
				actionId: 'op-dismiss',
				kind: 'lane.slim',
				laneId,
				decision: 'dismiss',
			});
			expect(dismissed.lane?.slim).toMatchObject({
				status: 'skipped',
				message: 'Dismissed by the operator.',
			});
			const again = await service.runOperation({
				actionId: 'op-dismiss-again',
				kind: 'lane.slim',
				laneId,
				decision: 'dismiss',
			});
			expect(again.completed).toBe(false);
			expect(again.error).toMatch(/no slimming request waiting/);
		});

		it('reports plainly when the build has no slimming at all', async () => {
			const bare = new LaneService({
				store: new LaneStore(
					await mkdtemp(path.join(os.tmpdir(), 'lane-bare-'))
				),
				simulator,
				metro,
				worktrees,
				now: () => now,
			});
			const receipt = await bare.runOperation({
				actionId: 'op-bare',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
				slimProfileId: 'rndevtools-development',
			});
			expect(receipt.completed).toBe(false);
			expect(receipt.error).toMatch(/not available in this build/);
			await bare.stop();
		});
	});

	describe('dev client presence', () => {
		it('refuses to launch when the worktree bundle is not installed and says what to build', async () => {
			healthyMetro();
			simulator.installedApps = ['com.apple.mobilesafari'];
			const receipt = await service.runOperation({
				actionId: 'op-no-client',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: true,
			});
			expect(receipt.completed).toBe(false);
			expect(receipt.error).toMatch(/com\.example\.app is not installed/);
			expect(receipt.error).toMatch(
				new RegExp(`expo run:ios --device ${UDID} --no-bundler`)
			);
			expect(receipt.error).toMatch(/Metro on port 8100 is still running/);
			expect(simulator.actions.map((action) => action.kind)).toEqual([
				'device.boot',
				'app.list',
			]);
			// The lease survives so the operator can build and relaunch.
			expect(service.getState().lanes).toHaveLength(1);
		});

		it('skips the check when the worktree declares no bundle identifier', async () => {
			healthyMetro();
			worktrees.identity = { scheme: 'exampleapp' };
			simulator.installedApps = [];
			const receipt = await service.runOperation({
				actionId: 'op-no-bundle-id',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: true,
			});
			expect(receipt.completed).toBe(true);
			expect(simulator.actions.map((action) => action.kind)).toEqual([
				'device.boot',
				'url.open',
			]);
		});
	});
});
