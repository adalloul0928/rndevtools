import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
	diagnosticErrorText,
	redactDiagnosticText,
} from '@rndevtools/core/redact';
import type { DeviceHold } from '../shared/device-hold';
import {
	allocateLanePort,
	DEFAULT_LANE_ENVIRONMENTS,
	findLaneConflict,
	LANE_METRO_HEALTH_TIMEOUT_MS,
	type Lane,
	type LaneAgent,
	type LaneEnvironment,
	type LaneOperation,
	type LaneOperationReceipt,
	type LaneSlim,
	type LaneState,
	type LaneWorktree,
	laneAppDirectory,
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
import {
	SLIMMING_CONFIRMATIONS,
	type SlimmingAction,
	type SlimmingActionReceipt,
	type SlimmingJob,
	type SlimmingState,
} from '../shared/slimming-protocol';
import { type MetroSupervisorPort, metroSupervisor } from './lane-metro';
import type { LaneStore } from './lane-store';
import { type WorktreeInspectorPort, worktreeInspector } from './lane-worktree';
import type {
	SimulatorMutationCoordinatorPort,
	SimulatorMutationLease,
} from './simulator-mutation-coordinator';

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

/**
 * The slice of the SimSlim service a lane may drive. It is the same entry
 * point the Simulator panel and recipes use, so every gate in `runAction`
 * (experimental setting, compatibility tuple, signed-helper authorization)
 * applies to a lane exactly as it does to a click in the panel.
 */
export type LaneSlimmingPort = {
	getState: () => SlimmingState;
	refresh: () => Promise<SlimmingState>;
	runAction: (
		action: SlimmingAction,
		mutationLease?: SimulatorMutationLease
	) => SlimmingActionReceipt;
	cancelJob: (jobId: string) => boolean;
	subscribe: (listener: (state: SlimmingState) => void) => () => void;
};

type LaneListener = (state: LaneState) => void;

const TERMINAL_SLIMMING_STATUSES = new Set([
	'complete',
	'failed',
	'needs-attention',
	'cancelled',
]);
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
 * mutation pipeline, optionally slim it, start a detached Metro, wait for it
 * to answer, and send the dev client a launch URL that points at exactly
 * that Metro.
 *
 * Slimming rides along but never bypasses its gates. A lane start may name a
 * SimSlim profile; the desktop applies it before Metro starts, and the SimSlim
 * service checks the experimental setting, the device's compatibility tuple,
 * who holds the device (the lane's agent is the requester), and the helper's
 * signed-parent authorization. A refused slim is recorded as `skipped` with
 * the reason and the lane starts anyway, so an agent is never blocked on a
 * slim it cannot get.
 */
export class LaneService {
	readonly #store: LaneStore;
	readonly #simulator: LaneSimulatorPort;
	readonly #slimming: LaneSlimmingPort | undefined;
	readonly #mutationCoordinator: SimulatorMutationCoordinatorPort | undefined;
	readonly #holds: (() => ReadonlyMap<string, DeviceHold>) | undefined;
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
		slimming,
		mutationCoordinator,
		metro = metroSupervisor,
		worktrees = worktreeInspector,
		environments = DEFAULT_LANE_ENVIRONMENTS,
		metroMaxWorkers = 2,
		holds,
		now = Date.now,
	}: {
		store: LaneStore;
		simulator: LaneSimulatorPort;
		/** Both must be given for a lane to slim; neither means "report only". */
		slimming?: LaneSlimmingPort;
		mutationCoordinator?: SimulatorMutationCoordinatorPort;
		metro?: MetroSupervisorPort;
		worktrees?: WorktreeInspectorPort;
		environments?: readonly LaneEnvironment[];
		metroMaxWorkers?: number;
		/**
		 * Who holds each Simulator, from the agent service. When set, reconcile
		 * releases a lane whose owning agent has been gone past the grace
		 * period, so devices return to the pool without anyone's cooperation.
		 */
		holds?: () => ReadonlyMap<string, DeviceHold>;
		now?: () => number;
	}) {
		this.#store = store;
		this.#simulator = simulator;
		this.#slimming = slimming;
		this.#mutationCoordinator = mutationCoordinator;
		this.#metro = metro;
		this.#worktrees = worktrees;
		this.#environments = environments;
		this.#maxWorkers = metroMaxWorkers;
		this.#holds = holds;
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
		const requestedPath = path.resolve(input.worktreePath);
		const environment = this.#environments.find(
			(candidate) => candidate.id === input.environment
		);
		if (!environment) {
			throw new Error(`Unknown lane environment "${input.environment}".`);
		}

		// The agent passes wherever it is working. Resolve the checkout that
		// contains it: that is the lane's worktree, and the requested directory
		// (if deeper) is the Expo app inside a monorepo.
		const repositoryRoot = await this.#worktrees.repositoryRoot(requestedPath);
		const worktrees = await this.#worktrees.listWorktrees(repositoryRoot);
		const worktree = worktrees
			.map((candidate) => ({
				...candidate,
				path: path.resolve(candidate.path),
			}))
			.filter(
				(candidate) =>
					requestedPath === candidate.path ||
					requestedPath.startsWith(`${candidate.path}${path.sep}`)
			)
			.sort((left, right) => right.path.length - left.path.length)[0];
		if (!worktree) {
			throw new Error(
				`${requestedPath} is not inside a worktree of ${repositoryRoot}.`
			);
		}
		const worktreePath = worktree.path;
		const appPath = requestedPath === worktreePath ? undefined : requestedPath;
		// Starting the lane that already exists for this app on this Simulator is
		// idempotent: agents retry `lane up` after an interruption, and a second
		// attempt should land them in the lane rather than at a conflict they
		// cannot resolve. A lane on another Simulator, or another app's lane on
		// this Simulator, is still a conflict.
		const candidateApp = laneAppDirectory({
			worktreePath,
			...(appPath ? { appPath } : {}),
		});
		const existing = this.#store
			.lanes()
			.find(
				(lane) =>
					laneAppDirectory(lane) === candidateApp &&
					lane.simulatorUdid.toUpperCase() === input.simulatorUdid.toUpperCase()
			);
		if (existing) {
			return this.#resumeLane(existing, input, environment, signal);
		}
		const conflict = findLaneConflict(this.#store.lanes(), {
			worktreePath,
			...(appPath ? { appPath } : {}),
			simulatorUdid: input.simulatorUdid,
		});
		if (conflict) throw new Error(conflict);
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
		const identity = await this.#worktrees.readExpoIdentity(
			appPath ?? worktreePath
		);
		// Validate the slim request before anything is booted or spawned, so a
		// typo in a profile id fails fast instead of after a 20s boot.
		const slimRequest = input.slimProfileId
			? this.#slimRequest(input.slimProfileId)
			: undefined;
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

		// Slim before Metro so the dev client's first launch lands on a device
		// that already has its services trimmed. Without approval the lane is
		// parked in needs-approval and everything else proceeds.
		let slim: LaneSlim | undefined;
		if (slimRequest) {
			slim = await this.#applySlim(
				device.udid,
				slimRequest,
				input.agent,
				signal
			);
		}

		const metroPid = await this.#metro.start({
			worktreePath: appPath ?? worktreePath,
			port,
			logPath,
			maxWorkers: this.#maxWorkers,
			...(environment.metroEnv ? { metroEnv: environment.metroEnv } : {}),
		});
		let lane: Lane = {
			id,
			worktreePath,
			...(appPath ? { appPath } : {}),
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
			...(slim ? { slim } : {}),
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

	/**
	 * Brings an existing lane back to running for a repeated `lane up`: if its
	 * Metro is gone, start a fresh one on the lane's own port; then launch the
	 * dev client when asked. The lane keeps its id, port, and log.
	 */
	async #resumeLane(
		existing: Lane,
		input: Extract<LaneOperation, { kind: 'lane.start' }>,
		environment: LaneEnvironment,
		signal: AbortSignal
	): Promise<Lane> {
		let lane = existing;
		const metroAlive =
			(await this.#metro.isHealthy(lane.port)) ||
			(lane.metroPid !== undefined &&
				this.#metro.isProcessRunning(lane.metroPid));
		if (!metroAlive) {
			const metroPid = await this.#metro.start({
				worktreePath: laneAppDirectory(lane),
				port: lane.port,
				logPath: lane.logPath,
				maxWorkers: this.#maxWorkers,
				...(environment.metroEnv ? { metroEnv: environment.metroEnv } : {}),
			});
			lane = {
				...lane,
				metroPid,
				metro: 'starting',
				startedAt: this.#now(),
			};
			await this.#store.upsert(lane);
			this.#touch();
		}
		if (input.launch) {
			lane = await this.launchLane(lane.id, undefined, input.agent, signal);
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
		// Opening a scheme the Simulator has no app for fails with an opaque
		// FBSOpenApplicationServiceErrorDomain error; check first and say what to
		// build. The check only runs when the worktree told us its bundle id.
		await this.#assertDevClientInstalled(lane, signal);
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
			await this.#metro.stop(lane.metroPid, lane.port);
		}
		await this.#store.remove(laneId);
		this.#touch();
	}

	/**
	 * Refreshes the Metro liveness of every lane and releases abandoned ones.
	 *
	 * A lane's `agent` is the hold's owner and stays for the lane's lifetime;
	 * whether that owner is still around is the agent service's call (its
	 * session is alive or not), not a matter of recent CLI touches. When the
	 * owner has been gone for the grace period the lane is torn down, Metro
	 * stopped, and the device returns to the pool.
	 */
	async #reconcile(): Promise<void> {
		let changed = false;
		const holds = this.#holds?.();
		const now = this.#now();
		for (const lane of this.#store.lanes()) {
			const hold = holds?.get(lane.simulatorUdid.toUpperCase());
			if (
				hold?.laneId === lane.id &&
				!hold.holderLive &&
				hold.releaseAt !== undefined &&
				now >= hold.releaseAt
			) {
				await this.stopLane(lane.id).catch(() => undefined);
				changed = true;
				continue;
			}
			const status = this.#metroStatus(lane);
			const liveStatus =
				status === 'stopped'
					? 'stopped'
					: (await this.#metro.isHealthy(lane.port))
						? 'ready'
						: 'starting';
			if (liveStatus !== lane.metro) {
				await this.#store.upsert({ ...lane, metro: liveStatus });
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

	async #assertDevClientInstalled(
		lane: Lane,
		signal: AbortSignal
	): Promise<void> {
		if (!lane.bundleIdentifier) return;
		try {
			await this.#runSimulatorAction(
				{
					actionId: `lane-apps-${randomUUID()}`,
					kind: 'app.list',
					udid: lane.simulatorUdid,
				},
				signal
			);
		} catch {
			// Listing apps is advisory. If it fails, let url.open report instead.
			return;
		}
		const apps =
			this.#simulator.getState().appsByDevice[lane.simulatorUdid] ??
			this.#simulator.getState().appsByDevice[
				lane.simulatorUdid.toUpperCase()
			] ??
			[];
		const wanted = lane.bundleIdentifier.toLowerCase();
		if (apps.some((app) => app.bundleIdentifier.toLowerCase() === wanted)) {
			return;
		}
		throw new Error(
			`${lane.bundleIdentifier} is not installed on this Simulator, so there is no dev client to open. Build it once from the worktree with \`npx expo run:ios --device ${lane.simulatorUdid} --no-bundler\` (the RN Devtools build cache shares the result with other worktrees), then run lane launch again. Metro on port ${lane.port} is still running.`
		);
	}

	/** Checks a requested profile exists in the signed helper's catalog. */
	#slimRequest(profileId: string): string {
		if (!this.#slimming || !this.#mutationCoordinator) {
			throw new Error(
				'Slimming is not available in this build, so --slim cannot be honoured.'
			);
		}
		const state = this.#slimming.getState();
		if (state.helper.status !== 'available') {
			throw new Error(
				state.helper.error ??
					'The SimSlim helper is unavailable, so the lane cannot slim.'
			);
		}
		if (!state.profiles.some((profile) => profile.id === profileId)) {
			const known = state.profiles.map((profile) => profile.id).join(', ');
			throw new Error(
				`Unknown SimSlim profile "${profileId}". Known profiles: ${known || 'none'}.`
			);
		}
		return profileId;
	}

	/**
	 * Runs one `profile.apply` through the SimSlim service under the shared
	 * per-Simulator mutation lease, and folds the job's outcome into the lane.
	 * A rejected or failed job never throws: Metro and the launch still happen,
	 * and the lane carries the reason.
	 */
	async #applySlim(
		udid: string,
		profileId: string,
		requester:
			| { kind: 'claude' | 'codex' | 'other'; sessionId: string }
			| undefined,
		signal: AbortSignal
	): Promise<LaneSlim> {
		const slimming = this.#slimming;
		const coordinator = this.#mutationCoordinator;
		if (!slimming || !coordinator) {
			return {
				profileId,
				status: 'skipped',
				message: 'Slimming is not available in this build.',
				updatedAt: this.#now(),
			};
		}
		try {
			return await coordinator.runExclusive(udid, signal, async (lease) => {
				await slimming.refresh();
				const receipt = slimming.runAction(
					{
						actionId: `lane-slim-${randomUUID()}`,
						kind: 'profile.apply',
						profileId,
						simulatorUdids: [udid],
						confirmation: SLIMMING_CONFIRMATIONS.apply,
						// The lane's agent is the requester, so a device another session
						// holds is refused by the slimming service's ownership check.
						...(requester ? { requester } : {}),
					},
					lease
				);
				if (!receipt.accepted || !receipt.jobId) {
					return {
						profileId,
						status: 'skipped' as const,
						message: receipt.error ?? 'SimSlim rejected the profile.',
						updatedAt: this.#now(),
					};
				}
				const job = await this.#waitForSlimmingJob(receipt.jobId, signal);
				return {
					profileId,
					status:
						job.status === 'complete'
							? ('applied' as const)
							: ('failed' as const),
					message: job.message,
					jobId: receipt.jobId,
					updatedAt: this.#now(),
				};
			});
		} catch (error) {
			if (signal.aborted) throw error;
			return {
				profileId,
				status: 'failed',
				message: safeError(error),
				updatedAt: this.#now(),
			};
		}
	}

	#waitForSlimmingJob(
		jobId: string,
		signal: AbortSignal
	): Promise<SlimmingJob> {
		const slimming = this.#slimming;
		if (!slimming) return Promise.reject(new Error('Slimming unavailable.'));
		return new Promise((resolve, reject) => {
			let unsubscribe: () => void = () => undefined;
			const finish = (state: SlimmingState) => {
				const job = state.jobs.find((candidate) => candidate.id === jobId);
				if (!job || !TERMINAL_SLIMMING_STATUSES.has(job.status)) return;
				cleanup();
				resolve(job);
			};
			const onAbort = () => {
				slimming.cancelJob(jobId);
				cleanup();
				reject(new Error('Lane operation cancelled.'));
			};
			const cleanup = () => {
				unsubscribe();
				signal.removeEventListener('abort', onAbort);
			};
			unsubscribe = slimming.subscribe(finish);
			signal.addEventListener('abort', onAbort, { once: true });
			finish(slimming.getState());
			if (signal.aborted) onAbort();
		});
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
