import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
	AGENT_TOUCH_TTL_MS,
	type AgentClaim,
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
	DEVICE_HOLD_GRACE_MS,
	type DeviceHold,
	type DeviceHolder,
	decideDeviceAccess,
	resolveDeviceHolds,
} from '../shared/device-hold';
import {
	discoverAgentSessions,
	type SessionDiscoveryResult,
} from './agent-sessions';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MAX_CLAIMS = 200;
const MAX_TOUCHES = 1_000;

const storedClaimsSchema = z.strictObject({
	version: z.literal(1),
	claims: z.array(agentClaimSchema).max(MAX_CLAIMS),
});

/**
 * Claims survive a desktop restart because the agent that made one is
 * usually still running. Touches are in memory only: they expire in half an
 * hour, and after a restart every live session will touch again soon enough.
 */
class AgentClaimStore {
	readonly #file: string;
	#claims: AgentClaim[] = [];

	constructor(directory: string) {
		this.#file = path.join(directory, 'claims.json');
	}

	async start(): Promise<void> {
		await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
		try {
			const parsed = storedClaimsSchema.safeParse(
				JSON.parse(await readFile(this.#file, 'utf8'))
			);
			if (parsed.success) {
				this.#claims = parsed.data.claims;
			} else {
				await rename(this.#file, `${this.#file}.corrupt-${Date.now()}`).catch(
					() => undefined
				);
			}
		} catch {
			// No claims yet.
		}
	}

	claims(): readonly AgentClaim[] {
		return this.#claims;
	}

	async set(claims: readonly AgentClaim[]): Promise<void> {
		this.#claims = [...claims];
		const temporary = `${this.#file}.tmp`;
		await writeFile(
			temporary,
			`${JSON.stringify({ version: 1, claims: this.#claims }, null, '\t')}\n`,
			{ mode: 0o600 }
		);
		await chmod(temporary, 0o600).catch(() => undefined);
		await rename(temporary, this.#file);
	}
}

export type AgentLaneSource = () => readonly {
	id: string;
	simulatorUdid: string;
	appDirectory: string;
	agent?: { kind: 'claude' | 'codex' | 'other'; sessionId: string } | undefined;
	metro: 'starting' | 'ready' | 'stopped';
	startedAt: number;
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
	readonly #discover: () => Promise<SessionDiscoveryResult>;
	readonly #now: () => number;
	readonly #pollIntervalMs: number;
	readonly #listeners = new Set<AgentListener>();
	readonly #touches = new Map<string, AgentTouch>();
	readonly #missingSince = new Map<string, number>();
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
		discover = discoverAgentSessions,
		pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		now = Date.now,
	}: {
		directory: string;
		lanes: AgentLaneSource;
		discover?: () => Promise<SessionDiscoveryResult>;
		pollIntervalMs?: number;
		now?: () => number;
	}) {
		this.#store = new AgentClaimStore(directory);
		this.#lanes = lanes;
		this.#discover = discover;
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
			lanes: this.#lanes().map((lane) => ({
				id: lane.id,
				simulatorUdid: lane.simulatorUdid,
				metro: lane.metro,
				startedAt: lane.startedAt,
				...(lane.agent ? { agent: { ...lane.agent, lastSeenAt: 0 } } : {}),
			})),
			claims: this.#store.claims(),
			liveSessionKeys: new Set(this.#sessions.map(agentSessionKey)),
			missingSince: this.#missingSince,
			now: this.#now(),
		});
	}

	/** Whether `requester` (an agent, or the operator when undefined) may touch the device. */
	access(simulatorUdid: string, requester: DeviceHolder | undefined) {
		return decideDeviceAccess(
			this.holds().get(simulatorUdid.toUpperCase()),
			requester,
			this.#now()
		);
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
	 * for every device-targeted command that carried an agent id.
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
				const others = this.#store
					.claims()
					.filter(
						(claim) =>
							!(
								claim.simulatorUdid === udid &&
								agentSessionKey(claim) === agentSessionKey(operation.agent)
							)
					);
				if (others.length >= MAX_CLAIMS) {
					throw new Error(`The ${MAX_CLAIMS}-claim limit is reached.`);
				}
				await this.#store.set([
					...others,
					{
						simulatorUdid: udid,
						kind: operation.agent.kind,
						sessionId: operation.agent.sessionId,
						...(operation.note ? { note: operation.note } : {}),
						claimedAt: this.#now(),
					},
				]);
				this.touch(operation.agent, udid);
				return this.getState();
			}
			case 'agent.release': {
				const udid = operation.simulatorUdid.toUpperCase();
				const agent = operation.agent;
				const remaining = this.#store
					.claims()
					.filter(
						(claim) =>
							claim.simulatorUdid !== udid ||
							(agent !== undefined &&
								agentSessionKey(claim) !== agentSessionKey(agent))
					);
				if (remaining.length === this.#store.claims().length) {
					throw new Error(
						agent
							? `${agent.kind} ${agent.sessionId} holds no claim on ${udid}.`
							: `No claim exists on ${udid}.`
					);
				}
				await this.#store.set(remaining);
				this.#touch();
				return this.getState();
			}
			case 'agent.refresh':
				return this.refresh();
		}
	}

	async #refreshInternal(): Promise<AgentState> {
		try {
			const result = await this.#discover();
			this.#sessions = result.sessions.slice(0, 200);
			this.#discovery = {
				claude: result.claude,
				codex: result.codex,
				...(result.error ? { error: result.error } : {}),
			};
			await this.#expireAbandonedClaims();
			this.#pruneTouches();
		} catch (error) {
			this.#discovery = {
				...this.#discovery,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		this.#touch();
		return this.getState();
	}

	/** Drops claims whose session has been gone for the whole touch TTL. */
	async #expireAbandonedClaims(): Promise<void> {
		const live = new Set(this.#sessions.map(agentSessionKey));
		const now = this.#now();
		const kept: AgentClaim[] = [];
		let changed = false;
		for (const claim of this.#store.claims()) {
			const key = agentSessionKey(claim);
			if (live.has(key)) {
				this.#missingSince.delete(key);
				kept.push(claim);
				continue;
			}
			const since = this.#missingSince.get(key) ?? now;
			this.#missingSince.set(key, since);
			// A claim is a hold; it expires on the same clock as every other hold
			// so a device never stays claimed after its lane would have released.
			if (now - since >= DEVICE_HOLD_GRACE_MS) {
				changed = true;
				continue;
			}
			kept.push(claim);
		}
		if (changed) await this.#store.set(kept);
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
