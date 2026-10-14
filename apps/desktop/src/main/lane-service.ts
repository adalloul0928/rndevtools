import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
	diagnosticErrorText,
	redactDiagnosticText,
} from '@rndevtools/core/redact';
import {
	allocateLanePort,
	DEFAULT_LANE_ENVIRONMENTS,
	findLaneConflict,
	LANE_AGENT_TOUCH_TTL_MS,
	LANE_METRO_HEALTH_TIMEOUT_MS,
	type Lane,
	type LaneAgent,
	type LaneEnvironment,
	type LaneOperation,
	type LaneOperationReceipt,
	type LaneState,
	type LaneWorktree,
	laneDeepLink,
	laneDevClientLaunchUrl,
	laneOperationReceiptSchema,
	laneOperationSchema,
	laneStateSchema,
} from '../shared/lane-protocol';
import type {
	SimulatorAction,
	SimulatorActionReceipt,
	SimulatorJob,
	SimulatorState,
} from '../shared/simulator-protocol';
import { type MetroSupervisorPort, metroSupervisor } from './lane-metro';
import type { LaneStore } from './lane-store';
import { type WorktreeInspectorPort, worktreeInspector } from './lane-worktree';

const TERMINAL_SIMULATOR_STATUSES = new Set([
	'complete',
	'failed',
	'needs-attention',
	'cancelled',
]);
const HEALTH_POLL_INTERVAL_MS = 500;
const RECONCILE_INTERVAL_MS = 5_000;
const MAX_ERROR_LENGTH = 4 * 1024;

export type LaneSimulatorPort = {
	getState: () => SimulatorState;
	refresh: () => Promise<SimulatorState>;
	runAction: (action: SimulatorAction) => SimulatorActionReceipt;
	cancelJob: (jobId: string) => boolean;
	subscribe: (listener: (state: SimulatorState) => void) => () => void;
};

type LaneListener = (state: LaneState) => void;

function safeError(error: unknown): string {
	return redactDiagnosticText(diagnosticErrorText(error)).slice(
		0,
		MAX_ERROR_LENGTH
	);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('Lane operation cancelled.'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Owns lane leases and the lifecycle around them: validate the worktree,
 * refuse to steal a device or port, boot the Simulator through the shared
 * mutation pipeline, start a detached Metro, wait for it to answer, and send
 * the dev client a launch URL that points at exactly that Metro.
 *
 * Slimming is deliberately not part of a lane start. The Simulator panel owns
 * slim profiles with its own confirmation and verification; a lane just reports
 * which device it uses so the fleet view can show the two together.
 */
export class LaneService {
	readonly #store: LaneStore;
	readonly #simulator: LaneSimulatorPort;
	readonly #metro: MetroSupervisorPort;
	readonly #worktrees: WorktreeInspectorPort;
	readonly #environments: readonly LaneEnvironment[];
	readonly #maxWorkers: number;
	readonly #now: () => number;
	readonly #listeners = new Set<LaneListener>();
	#worktreeCache: LaneWorktree[] = [];
	#revision = 0;
	#updatedAt: number;
	#error: string | undefined;
	#reconcileTimer: NodeJS.Timeout | undefined;
	#refreshPromise: Promise<LaneState> | undefined;
	#stopped = false;

	constructor({
		store,
		simulator,
		metro = metroSupervisor,
		worktrees = worktreeInspector,
		environments = DEFAULT_LANE_ENVIRONMENTS,
		metroMaxWorkers = 2,
		now = Date.now,
	}: {
		store: LaneStore;
		simulator: LaneSimulatorPort;
		metro?: MetroSupervisorPort;
		worktrees?: WorktreeInspectorPort;
		environments?: readonly LaneEnvironment[];
		metroMaxWorkers?: number;
		now?: () => number;
	}) {
		this.#store = store;
		this.#simulator = simulator;
		this.#metro = metro;
		this.#worktrees = worktrees;
		this.#environments = environments;
		this.#maxWorkers = metroMaxWorkers;
		this.#now = now;
		this.#updatedAt = now();
	}

	async start(): Promise<void> {
		await this.#store.start();
		await this.#reconcile();
		await this.refresh().catch(() => undefined);
		this.#reconcileTimer = setInterval(() => {
			void this.#reconcile();
		}, RECONCILE_INTERVAL_MS);
		this.#reconcileTimer.unref();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
		// Metro processes are detached on purpose; they keep serving the agents
		// that started them after the desktop app quits.
	}

	getState = (): LaneState => {
		const lanes = this.#store.lanes();
		const laneByWorktree = new Map(
			lanes.map((lane) => [lane.worktreePath, lane.id])
		);
		return laneStateSchema.parse({
			revision: this.#revision,
			updatedAt: this.#updatedAt,
			environments: this.#environments,
			lanes,
			worktrees: this.#worktreeCache.map((worktree) => ({
				...worktree,
				...(laneByWorktree.has(worktree.path)
					? { laneId: laneByWorktree.get(worktree.path) }
					: {}),
			})),
			repositories: this.#store.repositories(),
			...(this.#error ? { error: this.#error } : {}),
		});
	};

	subscribe(listener: LaneListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	refresh(): Promise<LaneState> {
		if (!this.#refreshPromise) {
			this.#refreshPromise = this.#refreshWorktrees().finally(() => {
				this.#refreshPromise = undefined;
			});
		}
		return this.#refreshPromise;
	}

	async runOperation(
		value: LaneOperation,
		signal: AbortSignal = new AbortController().signal
	): Promise<LaneOperationReceipt> {
		const operation = laneOperationSchema.parse(value);
		const base = { actionId: operation.actionId, kind: operation.kind };
		try {
			if (this.#stopped) throw new Error('Lanes are shutting down.');
			switch (operation.kind) {
				case 'lane.start': {
					const lane = await this.startLane(operation, signal);
					return laneOperationReceiptSchema.parse({
						...base,
						completed: true,
						lane,
						state: this.getState(),
					});
				}
				case 'lane.launch': {
					const lane = await this.launchLane(
						operation.laneId,
						operation.url,
						operation.agent,
						signal
					);
					return laneOperationReceiptSchema.parse({
						...base,
						completed: true,
						lane,
						state: this.getState(),
					});
				}
				case 'lane.stop': {
					await this.stopLane(operation.laneId);
					return laneOperationReceiptSchema.parse({
						...base,
						completed: true,
						state: this.getState(),
					});
				}
				case 'lane.log': {
					const lane = this.#requireLane(operation.laneId);
					const log = await this.#metro.readLogTail(
						lane.logPath,
						operation.maxCharacters
					);
					return laneOperationReceiptSchema.parse({
						...base,
						completed: true,
						lane,
						log,
					});
				}
				case 'lane.refresh': {
					await this.#reconcile();
					return laneOperationReceiptSchema.parse({
						...base,
						completed: true,
						state: await this.refresh(),
					});
				}
				case 'lane.remove-repository': {
					await this.#store.removeRepository(operation.repositoryRoot);
					return laneOperationReceiptSchema.parse({
						...base,
						completed: true,
						state: await this.refresh(),
					});
				}
				case 'lane.add-repository':
					throw new Error(
						'Repository selection must be resolved by the IPC layer before reaching the lane service.'
					);
			}
		} catch (error) {
			return laneOperationReceiptSchema.parse({
				...base,
				completed: false,
				error: safeError(error),
			});
		}
	}

	async addRepository(root: string): Promise<LaneState> {
		const repositoryRoot = await this.#worktrees.repositoryRoot(root);
		await this.#store.addRepository(repositoryRoot);
		return this.refresh();
	}

	async startLane(
		input: Extract<LaneOperation, { kind: 'lane.start' }>,
		signal: AbortSignal
	): Promise<Lane> {
		const worktreePath = path.resolve(input.worktreePath);
		const environment = this.#environments.find(
			(candidate) => candidate.id === input.environment
		);
		if (!environment) {
			throw new Error(`Unknown lane environment "${input.environment}".`);
		}
		const conflict = findLaneConflict(this.#store.lanes(), {
			worktreePath,
			simulatorUdid: input.simulatorUdid,
		});
		if (conflict) throw new Error(conflict);

		const repositoryRoot = await this.#worktrees.repositoryRoot(worktreePath);
		const worktrees = await this.#worktrees.listWorktrees(repositoryRoot);
		const worktree = worktrees.find(
			(candidate) => path.resolve(candidate.path) === worktreePath
		);
		if (!worktree) {
			throw new Error(
				`${worktreePath} is not a worktree of ${repositoryRoot}. Lanes run from a checkout root, not a subdirectory.`
			);
		}
		await this.#store.addRepository(repositoryRoot);

		const device = (await this.#simulator.refresh()).devices.find(
			(candidate) =>
				candidate.udid.toUpperCase() === input.simulatorUdid.toUpperCase()
		);
		if (!device?.isAvailable) {
			throw new Error(
				'The Simulator is not available in the current inventory.'
			);
		}

		const port = await allocateLanePort({
			environment,
			lanes: this.#store.lanes(),
			isPortFree: this.#metro.isPortFree,
			...(input.preferredPort !== undefined
				? { preferredPort: input.preferredPort }
				: {}),
		});
		const identity = await this.#worktrees.readExpoIdentity(worktreePath);
		const id = this.#store.newLaneId();
		const logPath = this.#store.logPathFor(id);
		const startedAt = this.#now();
		const agent = this.#agentWithTimestamp(input.agent);

		// Boot first: a lane whose device cannot boot should not leave a Metro
		// running for nothing.
		if (device.state !== 'booted') {
			await this.#runSimulatorAction(
				{
					actionId: `lane-boot-${randomUUID()}`,
					kind: 'device.boot',
					udid: device.udid,
				},
				signal
			);
		}

		const metroPid = await this.#metro.start({
			worktreePath,
			port,
			logPath,
			maxWorkers: this.#maxWorkers,
			...(environment.metroEnv ? { metroEnv: environment.metroEnv } : {}),
		});
		let lane: Lane = {
			id,
			worktreePath,
			branch: worktree.branch,
			simulatorUdid: device.udid,
			environment: environment.id,
			port,
			metroPid,
			metro: 'starting',
			logPath,
			...(identity.bundleIdentifier
				? { bundleIdentifier: identity.bundleIdentifier }
				: {}),
			...(identity.scheme ? { scheme: identity.scheme } : {}),
			startedAt,
			...(agent ? { agent } : {}),
		};
		await this.#store.upsert(lane);
		this.#touch();
		// The repository may be new to the store; make its worktrees visible
		// without waiting for the next explicit refresh.
		await this.refresh().catch(() => undefined);

		if (input.launch) {
			lane = await this.launchLane(id, undefined, input.agent, signal);
		}
		return lane;
	}

	async launchLane(
		laneId: string,
		url: string | undefined,
		agent: Pick<LaneAgent, 'kind' | 'sessionId'> | undefined,
		signal: AbortSignal
	): Promise<Lane> {
		let lane = this.#requireLane(laneId);
		const healthy = await this.#waitForMetro(lane, signal);
		if (!healthy) {
			lane = { ...lane, metro: this.#metroStatus(lane) };
			await this.#store.upsert(lane);
			this.#touch();
			throw new Error(
				`Metro on port ${lane.port} did not become ready within ${LANE_METRO_HEALTH_TIMEOUT_MS / 1_000}s. Read the lane log for the bundler error.`
			);
		}
		const target =
			url !== undefined
				? laneDeepLink(lane, url)
				: lane.scheme
					? laneDevClientLaunchUrl(lane.scheme, lane.port)
					: undefined;
		if (!target) {
			throw new Error(
				'The worktree declares no URL scheme in app.json, so the dev client cannot be deep-linked. Pass --url with the full launch URL.'
			);
		}
		await this.#runSimulatorAction(
			{
				actionId: `lane-launch-${randomUUID()}`,
				kind: 'url.open',
				udid: lane.simulatorUdid,
				url: target,
			},
			signal
		);
		const touched = this.#agentWithTimestamp(agent) ?? lane.agent;
		lane = {
			...lane,
			metro: 'ready',
			lastLaunchedAt: this.#now(),
			...(touched ? { agent: touched } : {}),
		};
		await this.#store.upsert(lane);
		this.#touch();
		return lane;
	}

	async stopLane(laneId: string): Promise<void> {
		const lane = this.#requireLane(laneId);
		if (lane.metroPid !== undefined) {
			await this.#metro.stop(lane.metroPid, lane.worktreePath);
		}
		await this.#store.remove(laneId);
		this.#touch();
	}

	/** Refreshes the Metro liveness of every lease and expires stale agents. */
	async #reconcile(): Promise<void> {
		let changed = false;
		for (const lane of this.#store.lanes()) {
			const status = this.#metroStatus(lane);
			const liveStatus =
				status === 'stopped'
					? 'stopped'
					: (await this.#metro.isHealthy(lane.port))
						? 'ready'
						: 'starting';
			const agent =
				lane.agent &&
				this.#now() - lane.agent.lastSeenAt > LANE_AGENT_TOUCH_TTL_MS
					? undefined
					: lane.agent;
			if (liveStatus !== lane.metro || agent !== lane.agent) {
				const { agent: _agent, ...rest } = lane;
				await this.#store.upsert({
					...rest,
					metro: liveStatus,
					...(agent ? { agent } : {}),
				});
				changed = true;
			}
		}
		if (changed) this.#touch();
	}

	async #refreshWorktrees(): Promise<LaneState> {
		const roots = new Set(this.#store.repositories());
		for (const lane of this.#store.lanes()) {
			try {
				roots.add(await this.#worktrees.repositoryRoot(lane.worktreePath));
			} catch {
				// A lane whose worktree vanished is reported through its own entry.
			}
		}
		const worktrees: LaneWorktree[] = [];
		const errors: string[] = [];
		for (const root of roots) {
			try {
				for (const entry of await this.#worktrees.listWorktrees(root)) {
					worktrees.push({
						path: entry.path,
						branch: entry.branch,
						repositoryRoot: entry.repositoryRoot,
						dirty: entry.dirty,
					});
				}
			} catch (error) {
				errors.push(`${root}: ${safeError(error)}`);
			}
		}
		this.#worktreeCache = worktrees
			.slice(0, 128)
			.sort((left, right) => left.path.localeCompare(right.path));
		this.#error = errors.length ? errors.join('\n').slice(0, 4_096) : undefined;
		this.#touch();
		return this.getState();
	}

	#metroStatus(lane: Lane): Lane['metro'] {
		if (
			lane.metroPid === undefined ||
			!this.#metro.isProcessRunning(lane.metroPid)
		) {
			return 'stopped';
		}
		return lane.metro === 'stopped' ? 'starting' : lane.metro;
	}

	async #waitForMetro(lane: Lane, signal: AbortSignal): Promise<boolean> {
		const deadline = this.#now() + LANE_METRO_HEALTH_TIMEOUT_MS;
		while (this.#now() < deadline) {
			if (signal.aborted) throw new Error('Lane launch cancelled.');
			if (await this.#metro.isHealthy(lane.port)) return true;
			if (
				lane.metroPid !== undefined &&
				!this.#metro.isProcessRunning(lane.metroPid)
			) {
				throw new Error(
					`Metro for ${lane.branch} exited before it became ready. Read the lane log for the bundler error.`
				);
			}
			await sleep(HEALTH_POLL_INTERVAL_MS, signal);
		}
		return false;
	}

	async #runSimulatorAction(
		action: SimulatorAction,
		signal: AbortSignal
	): Promise<SimulatorJob> {
		const receipt = this.#simulator.runAction(action);
		if (!receipt.accepted || !receipt.jobId) {
			throw new Error(receipt.error ?? 'The Simulator action was rejected.');
		}
		const job = await this.#waitForSimulatorJob(receipt.jobId, signal);
		if (job.status !== 'complete') throw new Error(job.message);
		return job;
	}

	#waitForSimulatorJob(
		jobId: string,
		signal: AbortSignal
	): Promise<SimulatorJob> {
		return new Promise((resolve, reject) => {
			let unsubscribe: () => void = () => undefined;
			const finish = (state: SimulatorState) => {
				const job = state.jobs.find((candidate) => candidate.id === jobId);
				if (!job || !TERMINAL_SIMULATOR_STATUSES.has(job.status)) return;
				cleanup();
				resolve(job);
			};
			const onAbort = () => {
				this.#simulator.cancelJob(jobId);
				cleanup();
				reject(new Error('Lane operation cancelled.'));
			};
			const cleanup = () => {
				unsubscribe();
				signal.removeEventListener('abort', onAbort);
			};
			unsubscribe = this.#simulator.subscribe(finish);
			signal.addEventListener('abort', onAbort, { once: true });
			finish(this.#simulator.getState());
			if (signal.aborted) onAbort();
		});
	}

	#requireLane(laneId: string): Lane {
		const lane = this.#store.get(laneId);
		if (!lane) throw new Error(`Lane ${laneId} does not exist.`);
		return lane;
	}

	#agentWithTimestamp(
		agent: Pick<LaneAgent, 'kind' | 'sessionId'> | undefined
	): LaneAgent | undefined {
		return agent ? { ...agent, lastSeenAt: this.#now() } : undefined;
	}

	#touch(): void {
		this.#revision += 1;
		this.#updatedAt = this.#now();
		const state = this.getState();
		for (const listener of this.#listeners) {
			try {
				listener(state);
			} catch {
				// One failing subscriber must not starve the others.
			}
		}
	}
}
