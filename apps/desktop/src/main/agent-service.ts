import { mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
	AgentCliClaim,
	AgentIdentityResolution,
	AgentUnverifiedCause,
} from '../shared/agent-cli-protocol';
import {
	AGENT_TOUCH_TTL_MS,
	type AgentClaim,
	type AgentKind,
	type AgentOperation,
	type AgentSession,
	type AgentState,
	type AgentTouch,
	agentClaimSchema,
	agentOperationSchema,
	agentSessionKey,
	agentStateSchema,
	attributeAgents,
} from '../shared/agent-protocol';
import {
	type DeviceHold,
	type DeviceHolder,
	type DeviceRequester,
	decideDeviceAccess,
	type HolderLiveness,
	type HolderLivenessInputs,
	holderClockKey,
	resolveDeviceHolds,
	resolveHolderLiveness,
} from '../shared/device-hold';
import {
	type ProcessTableReader,
	processAncestry,
	readProcessTable,
} from './agent-peer';
import {
	discoverAgentSessions,
	type SessionDiscoveryResult,
} from './agent-sessions';
import { isMissing, writeFileAtomic } from './private-files';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
/**
 * How long a session with a process stays matchable by `identify` after
 * discovery last listed it. Claude Code deletes its registry file before it
 * runs the SessionEnd hook on a normal exit, while its process still lives,
 * so a hook that arrives after the next poll would find no session to be
 * under. The trade-off: a pid that the system reuses for an unrelated process
 * inside this window is taken for the session it belonged to.
 */
export const RECENT_SESSION_MS = 60_000;
const MAX_CLAIMS = 200;
const MAX_TOUCHES = 1_000;
const EVERY_AGENT_KIND: ReadonlySet<AgentKind> = new Set([
	'claude',
	'codex',
	'other',
]);

/**
 * The agent kinds whose sessions cannot be seen right now. Their holders are
 * unknown rather than gone. Nothing discovers `other` sessions, so those are
 * never known to be gone.
 */
function unseenKinds(
	discovery: Pick<SessionDiscoveryResult, 'claude' | 'codex'>
): Set<AgentKind> {
	const kinds = new Set<AgentKind>(['other']);
	if (discovery.claude === 'unavailable') kinds.add('claude');
	if (discovery.codex === 'unavailable') kinds.add('codex');
	return kinds;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * What happened when `identify` leaves a claim unverified, by cause. What the
 * agent can do about it is the refusal's recovery, which the CLI service owns
 * (`identityRefusal`).
 */
const UNVERIFIED_REASONS: Readonly<Record<AgentUnverifiedCause, string>> = {
	'no-proof':
		'RN Devtools could not confirm which process sent the request (an older rndevtools command-line tool does not name its process, or the check timed out).',
	'no-process-table':
		'RN Devtools could not read the process list to find the session.',
	'no-session':
		'This caller cannot be tied to a running Claude Code session, so it cannot hold or drive Simulators. Reads still work.',
};

/** A mismatch's reason when the sender runs under a session, but not the named one. */
const MISMATCH_OTHER_SESSION =
	'The request names a session other than the one the sending process runs under.';
/** And when it runs under none. */
const MISMATCH_NOT_UNDER_SESSION =
	'The request names a running session, but the sending process does not run under it.';

const storedClaimsSchema = z.strictObject({
	version: z.literal(1),
	claims: z.array(agentClaimSchema).max(MAX_CLAIMS),
});

class AgentClaimStore {
	readonly #file: string;
	#claims: AgentClaim[] = [];
	#writeQueue: Promise<void> = Promise.resolve();
	#loaded = false;

	constructor(directory: string) {
		this.#file = path.join(directory, 'claims.json');
	}

	async start(): Promise<void> {
		this.#loaded = false;
		await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
		try {
			const parsed = storedClaimsSchema.safeParse(
				JSON.parse(await readFile(this.#file, 'utf8'))
			);
			if (parsed.success) this.#claims = parsed.data.claims;
			else await this.#quarantine();
		} catch (error) {
			if (error instanceof SyntaxError) await this.#quarantine();
			else if (!isMissing(error)) throw error;
		}
		this.#loaded = true;
	}

	claims(): readonly AgentClaim[] {
		return this.#claims;
	}

	async #quarantine(): Promise<void> {
		await rename(this.#file, `${this.#file}.corrupt-${Date.now()}`);
	}

	update(
		operation: (
			claims: readonly AgentClaim[]
		) => readonly AgentClaim[] | undefined
	): Promise<void> {
		const write = this.#writeQueue.then(async () => {
			if (!this.#loaded)
				throw new Error('Agent claims must load successfully before writing.');
			const next = operation(this.#claims);
			if (!next) return;
			const validated = storedClaimsSchema.parse({ version: 1, claims: next });
			await writeFileAtomic(
				this.#file,
				`${JSON.stringify(validated, null, '\t')}\n`,
				'claims'
			);
			this.#claims = validated.claims;
		});
		this.#writeQueue = write.catch(() => undefined);
		return write;
	}
}

export type AgentLaneSource = () => readonly {
	id: string;
	simulatorUdid: string;
	/**
	 * The lane's checkout, not the app inside it: sessions working anywhere in
	 * it are attributed to the lane and keep alive a hold that an older desktop
	 * recorded under a shared MCP identity.
	 */
	worktreePath: string;
	agent?: { kind: 'claude' | 'codex' | 'other'; sessionId: string } | undefined;
	metro: 'starting' | 'ready' | 'stopped';
	startedAt: number;
	/**
	 * A start that has reserved its device but not stored its lane: it holds
	 * the device against newcomers and yields to an existing claim.
	 */
	starting?: boolean | undefined;
}[];

/**
 * Holders of resources other than lanes and claims, with the directory each
 * resource lives in. Their clocks run like a lane owner's.
 */
type AgentHolderSource = () => readonly {
	holder: DeviceHolder;
	directory?: string | undefined;
}[];

type AgentListener = (state: AgentState) => void;

/**
 * Discovers live sessions on a timer, keeps claims and touches, and derives
 * who is attached to which Simulator. A claim whose session is gone is kept
 * but reported `live: false` so a human can see what an agent left behind;
 * it is dropped once the session has been gone for the hold grace period.
 */
export class AgentService {
	readonly #store: AgentClaimStore;
	readonly #lanes: AgentLaneSource;
	readonly #holders: AgentHolderSource;
	readonly #discover: () => Promise<SessionDiscoveryResult>;
	readonly #processTable: ProcessTableReader;
	readonly #now: () => number;
	readonly #pollIntervalMs: number;
	readonly #listeners = new Set<AgentListener>();
	readonly #touches = new Map<string, AgentTouch>();
	// Reserve devices until their claim writes settle.
	readonly #pendingClaims = new Set<AgentClaim>();
	/**
	 * Abandonment clocks by `holderClockKey`: when each holder that a lane, a
	 * claim, or another resource names was first noticed missing. In memory
	 * only, so a desktop restart starts them over.
	 */
	readonly #missingSince = new Map<string, number>();
	/**
	 * Clocks paused because their holder's agent kind cannot be seen right now,
	 * with how long each had run when it paused.
	 */
	readonly #pausedClocks = new Map<string, number>();
	/**
	 * Sessions with a process (a pid above 1) that discovery listed within the
	 * last RECENT_SESSION_MS, by `agentSessionKey`, with when it last did. Only
	 * `identify` reads them, to match a sender's ancestry: holds, liveness, the
	 * state and the mismatch test all go by the current `#sessions`.
	 */
	readonly #recentSessions = new Map<
		string,
		{ session: AgentSession; seenAt: number }
	>();
	#sessions: AgentSession[] = [];
	#discovery: AgentState['discovery'] = { claude: 'ok', codex: 'ok' };
	#revision = 0;
	#updatedAt: number;
	#timer: NodeJS.Timeout | undefined;
	#pollingActive = true;
	#refreshPromise: Promise<AgentState> | undefined;
	#stopped = false;

	constructor({
		directory,
		lanes,
		holders = () => [],
		discover = discoverAgentSessions,
		processTable = readProcessTable,
		pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		now = Date.now,
	}: {
		directory: string;
		lanes: AgentLaneSource;
		/** Holders of other resources, so their clocks run; see `holderLiveness`. */
		holders?: AgentHolderSource;
		discover?: () => Promise<SessionDiscoveryResult>;
		/** The live process table, for `identify`; tests inject one. */
		processTable?: ProcessTableReader;
		pollIntervalMs?: number;
		now?: () => number;
	}) {
		this.#store = new AgentClaimStore(directory);
		this.#lanes = lanes;
		this.#holders = holders;
		this.#discover = discover;
		this.#processTable = processTable;
		this.#pollIntervalMs = pollIntervalMs;
		this.#now = now;
		this.#updatedAt = now();
	}

	async start(): Promise<void> {
		await this.#store.start();
		await this.refresh();
		this.#timer = setInterval(() => {
			if (this.#pollingActive) void this.refresh().catch(() => undefined);
		}, this.#pollIntervalMs);
		this.#timer.unref?.();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#timer) clearInterval(this.#timer);
	}

	setPollingActive(active: boolean): void {
		this.#pollingActive = active;
	}

	/**
	 * The hold on every Simulator, derived from lanes, claims, and which agent
	 * sessions are alive right now. This is the one answer to "who has this
	 * device"; the lane and slimming services both consult it.
	 */
	holds(): Map<string, DeviceHold> {
		return resolveDeviceHolds({
			lanes: this.#lanes(),
			claims: [...this.#store.claims(), ...this.#pendingClaims],
			...this.#livenessInputs(),
		});
	}

	/**
	 * Whether the holder of some other resource is still around, on the same
	 * clocks as device holds. List the resource's holders in the `holders`
	 * option: a holder no lane, claim, or listed resource names has no clock,
	 * and reads as gone from now on every call.
	 */
	holderLiveness(holder: DeviceHolder, directory?: string): HolderLiveness {
		return resolveHolderLiveness(holder, this.#livenessInputs(), directory);
	}

	/**
	 * Whether `requester` (an agent, the operator, or an anonymous socket
	 * request) may touch the device; see `decideDeviceAccess`.
	 */
	access(simulatorUdid: string, requester: DeviceRequester) {
		const hold = this.holds().get(simulatorUdid.toUpperCase());
		const lane = hold?.laneId
			? this.#lanes().find((candidate) => candidate.id === hold.laneId)
			: undefined;
		const session =
			typeof requester === 'string'
				? undefined
				: this.#sessions.find(
						(candidate) =>
							agentSessionKey(candidate) === agentSessionKey(requester)
					);
		return decideDeviceAccess(hold, requester, this.#now(), {
			directory: lane?.worktreePath,
			requesterCwd: session?.cwd,
		});
	}

	/**
	 * Resolves who sent a request, from the connection rather than the
	 * envelope. `claimed` is the session the envelope names and `peerPid` the
	 * process that sent it, given only once the CLI service has proven that it
	 * owns the connection. The rules, in order:
	 *
	 * 1. No claim: `anonymous`, whoever sent it.
	 * 2. A claim without a proven sender is `unverified` (`no-proof`), and so is
	 *    one whose sender cannot be traced because the process table cannot be
	 *    read (`no-process-table`).
	 * 3. The sender, or an ancestor of it (nearest first), is the process of a
	 *    session S (see `#sessionOfProcess`): the process proves S, so the
	 *    identity is S, `verified` by `process`. The claim only has to not
	 *    contradict that. A claim of exactly S agrees. One that names a
	 *    different session that is live right now is a `mismatch`. Any other is
	 *    ignored: the id a /clear replaced (an MCP server keeps the id it started
	 *    with), a synthetic `mcp-*` id, another agent's variable that leaked into
	 *    a Claude tree, an id no live session has. A claim that S does not
	 *    confirm is checked again after discovering sessions afresh, once: a
	 *    session that started, or took a new id, since the last poll is not in
	 *    the list yet, and its own requests must not read as another's.
	 * 4. No session in the ancestry: never promote the claim into an identity.
	 *    A claim that names a live session with a process is a `mismatch`: its
	 *    id, presented by a process that does not run under it. Any other claim
	 *    is `unverified` (`no-session`): Codex threads share one process, and
	 *    other agents and ended sessions have no process to match.
	 */
	async identify({
		claimed,
		peerPid,
	}: {
		claimed?: AgentCliClaim;
		peerPid?: number;
	}): Promise<AgentIdentityResolution> {
		if (!claimed) return { status: 'anonymous' };
		if (peerPid === undefined) {
			return {
				status: 'unverified',
				cause: 'no-proof',
				reason: UNVERIFIED_REASONS['no-proof'],
			};
		}
		let ancestry: number[];
		try {
			ancestry = processAncestry(await this.#processTable(), peerPid);
		} catch {
			return {
				status: 'unverified',
				cause: 'no-process-table',
				reason: UNVERIFIED_REASONS['no-process-table'],
			};
		}
		const key = agentSessionKey(claimed);
		this.#forgetStaleSessions();
		let owner = this.#sessionOfProcess(ancestry);
		if (!owner || agentSessionKey(owner) !== key) {
			await this.refresh();
			owner = this.#sessionOfProcess(ancestry);
		}
		const named = this.#sessions.find(
			(session) => agentSessionKey(session) === key
		);
		if (owner) {
			if (named && agentSessionKey(owner) !== key) {
				return { status: 'mismatch', reason: MISMATCH_OTHER_SESSION };
			}
			return {
				status: 'verified',
				agent: { kind: owner.kind, sessionId: owner.sessionId },
				basis: 'process',
			};
		}
		if (named?.pid !== undefined) {
			return { status: 'mismatch', reason: MISMATCH_NOT_UNDER_SESSION };
		}
		return {
			status: 'unverified',
			cause: 'no-session',
			reason: UNVERIFIED_REASONS['no-session'],
		};
	}

	/**
	 * The session whose process comes first in `ancestry`, which runs from the
	 * sender up, if any: a session in the current discovery, else the one that
	 * was listed last of those recently seen. Where several sessions share a
	 * pid (a /clear gives a session a new id, in the same process) the current
	 * one is the process's own. A pid of 1 or below never matches: launchd is
	 * the ancestor of every orphaned process, so a registry entry that names it
	 * would otherwise vouch for all of them.
	 */
	#sessionOfProcess(ancestry: readonly number[]): AgentSession | undefined {
		for (const pid of ancestry) {
			if (pid <= 1) continue;
			const current = this.#sessions.find((candidate) => candidate.pid === pid);
			if (current) return current;
			let recent: { session: AgentSession; seenAt: number } | undefined;
			for (const entry of this.#recentSessions.values()) {
				if (
					entry.session.pid === pid &&
					(recent === undefined || entry.seenAt > recent.seenAt)
				) {
					recent = entry;
				}
			}
			if (recent) return recent.session;
		}
		return undefined;
	}

	/** Remembers the sessions discovery just listed that have a process to match. */
	#rememberSessions(): void {
		const seenAt = this.#now();
		for (const session of this.#sessions) {
			if (session.pid !== undefined && session.pid > 1) {
				this.#recentSessions.set(agentSessionKey(session), { session, seenAt });
			}
		}
		this.#forgetStaleSessions();
	}

	/** Drops the sessions that discovery has not listed for RECENT_SESSION_MS. */
	#forgetStaleSessions(): void {
		const now = this.#now();
		for (const [key, { seenAt }] of this.#recentSessions) {
			if (now - seenAt > RECENT_SESSION_MS) this.#recentSessions.delete(key);
		}
	}

	subscribe(listener: AgentListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	getState = (): AgentState => {
		const now = this.#now();
		const byDevice = attributeAgents({
			sessions: this.#sessions,
			claims: this.#store.claims(),
			touches: [...this.#touches.values()],
			lanes: this.#lanes(),
			now,
		});
		return agentStateSchema.parse({
			revision: this.#revision,
			updatedAt: this.#updatedAt,
			sessions: this.#sessions,
			byDevice,
			claims: this.#store.claims(),
			holds: Object.fromEntries(this.holds()),
			discovery: this.#discovery,
		});
	};

	refresh(): Promise<AgentState> {
		if (!this.#refreshPromise) {
			this.#refreshPromise = this.#refreshInternal().finally(() => {
				this.#refreshPromise = undefined;
			});
		}
		return this.#refreshPromise;
	}

	/**
	 * Records that a session just drove a Simulator. Called by the CLI router
	 * for every device-targeted command from a verified session, which is the
	 * Claude Code session the sending process runs under, never a claim alone.
	 */
	touch(
		agent: Pick<AgentSession, 'kind' | 'sessionId'>,
		simulatorUdid: string
	): void {
		const udid = simulatorUdid.toUpperCase();
		const key = `${udid}|${agentSessionKey(agent)}`;
		this.#touches.set(key, {
			simulatorUdid: udid,
			kind: agent.kind,
			sessionId: agent.sessionId,
			lastSeenAt: this.#now(),
		});
		if (this.#touches.size > MAX_TOUCHES) {
			const oldest = [...this.#touches.entries()].sort(
				(a, b) => a[1].lastSeenAt - b[1].lastSeenAt
			)[0];
			if (oldest) this.#touches.delete(oldest[0]);
		}
		this.#touch();
	}

	async runOperation(value: AgentOperation): Promise<AgentState> {
		const operation = agentOperationSchema.parse(value);
		if (this.#stopped) throw new Error('Agents are shutting down.');
		switch (operation.kind) {
			case 'agent.claim': {
				const udid = operation.simulatorUdid.toUpperCase();
				const claim: AgentClaim = {
					simulatorUdid: udid,
					kind: operation.agent.kind,
					sessionId: operation.agent.sessionId,
					...(operation.note ? { note: operation.note } : {}),
					claimedAt: this.#now(),
				};
				this.#pendingClaims.add(claim);
				try {
					await this.#store.update((claims) => {
						const existing = claims.findIndex(
							(candidate) =>
								candidate.simulatorUdid === udid &&
								agentSessionKey(candidate) === agentSessionKey(operation.agent)
						);
						if (existing === -1 && claims.length >= MAX_CLAIMS) {
							throw new Error(`The ${MAX_CLAIMS}-claim limit is reached.`);
						}
						// Preserve order: the first claimant holds the device.
						return existing === -1
							? [...claims, claim]
							: claims.map((candidate, index) =>
									index === existing ? claim : candidate
								);
					});
				} finally {
					this.#pendingClaims.delete(claim);
				}
				this.touch(operation.agent, udid);
				return this.getState();
			}
			case 'agent.release': {
				const udid = operation.simulatorUdid.toUpperCase();
				const agent = operation.agent;
				await this.#store.update((claims) => {
					const remaining = claims.filter(
						(claim) =>
							claim.simulatorUdid !== udid ||
							(agent !== undefined &&
								agentSessionKey(claim) !== agentSessionKey(agent))
					);
					if (remaining.length === claims.length) {
						throw new Error(
							agent
								? `${agent.kind} ${agent.sessionId} holds no claim on ${udid}.`
								: `No claim exists on ${udid}.`
						);
					}
					return remaining;
				});
				this.#touch();
				return this.getState();
			}
			case 'agent.refresh':
				return this.refresh();
		}
	}

	async #refreshInternal(): Promise<AgentState> {
		let result: SessionDiscoveryResult;
		try {
			result = await this.#discover();
		} catch (error) {
			this.#discovery = { ...this.#discovery, error: errorText(error) };
			// Nothing was seen, so nobody is known to be gone.
			this.#runHolderClocks(EVERY_AGENT_KIND);
			this.#touch();
			return this.getState();
		}
		try {
			this.#sessions = result.sessions.slice(0, 200);
			this.#rememberSessions();
			this.#discovery = {
				claude: result.claude,
				codex: result.codex,
				...(result.error ? { error: result.error } : {}),
			};
			this.#runHolderClocks(unseenKinds(result));
			await this.#expireAbandonedClaims();
			this.#pruneTouches();
		} catch (error) {
			this.#discovery = { ...this.#discovery, error: errorText(error) };
		}
		this.#touch();
		return this.getState();
	}

	#livenessInputs(now = this.#now()): HolderLivenessInputs {
		let clocks: ReadonlyMap<string, number> = this.#missingSince;
		if (this.#pausedClocks.size > 0) {
			// A paused clock reads as having run exactly as long as it had when it
			// paused, so its release never comes closer while it is paused.
			const effective = new Map(this.#missingSince);
			for (const [key, elapsed] of this.#pausedClocks) {
				effective.set(key, now - elapsed);
			}
			clocks = effective;
		}
		return {
			liveSessionKeys: new Set(this.#sessions.map(agentSessionKey)),
			liveSessions: this.#sessions,
			missingSince: clocks,
			now,
		};
	}

	/** Every holder a lane, a claim, or another resource names. */
	#namedHolders(): { holder: DeviceHolder; directory?: string | undefined }[] {
		return [
			...this.#lanes().flatMap((lane) =>
				lane.agent
					? [
							{
								holder: {
									kind: lane.agent.kind,
									sessionId: lane.agent.sessionId,
								},
								directory: lane.worktreePath,
							},
						]
					: []
			),
			...this.#store.claims().map((claim) => ({
				holder: { kind: claim.kind, sessionId: claim.sessionId },
			})),
			...this.#holders(),
		];
	}

	/**
	 * Runs one abandonment clock per named holder. A clock starts when its
	 * holder goes missing and is dropped when the holder is live again or
	 * nothing names it any more. While a kind's sessions cannot be seen
	 * (`unseen`), its holders are unknown rather than gone: their running
	 * clocks pause, none start, and paused ones resume where they stopped once
	 * the kind can be seen again.
	 */
	#runHolderClocks(unseen: ReadonlySet<AgentKind>): void {
		const now = this.#now();
		const inputs = this.#livenessInputs(now);
		const named = new Set<string>();
		for (const { holder, directory } of this.#namedHolders()) {
			const key = holderClockKey(holder, directory);
			if (named.has(key)) continue;
			named.add(key);
			if (resolveHolderLiveness(holder, inputs, directory).live) {
				this.#missingSince.delete(key);
				this.#pausedClocks.delete(key);
				continue;
			}
			const since = this.#missingSince.get(key);
			if (unseen.has(holder.kind)) {
				if (since !== undefined) {
					this.#pausedClocks.set(key, now - since);
					this.#missingSince.delete(key);
				}
				continue;
			}
			const elapsed = this.#pausedClocks.get(key);
			if (elapsed !== undefined) {
				this.#missingSince.set(key, now - elapsed);
				this.#pausedClocks.delete(key);
			} else if (since === undefined) {
				this.#missingSince.set(key, now);
			}
		}
		for (const clocks of [this.#missingSince, this.#pausedClocks]) {
			for (const key of clocks.keys()) {
				if (!named.has(key)) clocks.delete(key);
			}
		}
	}

	async #expireAbandonedClaims(): Promise<void> {
		await this.#store.update((claims) => {
			const inputs = this.#livenessInputs();
			const kept = claims.filter((claim) => {
				const liveness = resolveHolderLiveness(
					{ kind: claim.kind, sessionId: claim.sessionId },
					inputs
				);
				return liveness.live || inputs.now < liveness.releaseAt;
			});
			return kept.length === claims.length ? undefined : kept;
		});
	}

	#pruneTouches(): void {
		const now = this.#now();
		for (const [key, touch] of this.#touches) {
			if (now - touch.lastSeenAt > AGENT_TOUCH_TTL_MS)
				this.#touches.delete(key);
		}
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
