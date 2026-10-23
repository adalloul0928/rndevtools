import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSession } from '../shared/agent-protocol';
import { DEVICE_HOLD_GRACE_MS } from '../shared/device-hold';
import type { Lane } from '../shared/lane-protocol';
import type { ProcessTableEntry } from './agent-peer';
import { AgentService, RECENT_SESSION_MS } from './agent-service';
import { type CodexDatabase, discoverAgentSessions } from './agent-sessions';
import type { MetroLaunchInput, MetroSupervisorPort } from './lane-metro';
import { LaneService, type LaneSimulatorPort } from './lane-service';
import { LaneStore } from './lane-store';
import type { WorktreeInspectorPort } from './lane-worktree';

const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'AAAAAAAA-0000-4000-8000-000000000002';
const now = 1_700_000_000_000;

describe('discoverAgentSessions', () => {
	let home: string;
	beforeEach(async () => {
		home = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-agents-'));
		await mkdir(path.join(home, '.claude', 'sessions'), { recursive: true });
		await mkdir(path.join(home, '.codex'), { recursive: true });
	});
	afterEach(() => rm(home, { recursive: true, force: true }));

	async function writeClaude(
		name: string,
		entry: Record<string, unknown> | string
	) {
		await writeFile(
			path.join(home, '.claude', 'sessions', name),
			typeof entry === 'string' ? entry : JSON.stringify(entry)
		);
	}

	it('reads live Claude Code sessions and skips dead or malformed registry files', async () => {
		await writeClaude('100.json', {
			pid: 100,
			sessionId: 'live-session',
			cwd: '/Users/dev/app',
			name: 'checkout',
			status: 'idle',
			startedAt: now - 5_000,
			updatedAt: now - 1_000,
		});
		await writeClaude('200.json', {
			pid: 200,
			sessionId: 'dead-session',
			cwd: '/Users/dev/other',
		});
		await writeClaude('300.json', { sessionId: 'no-pid' });
		await writeClaude('400.json', 'not json{');
		await writeClaude('500.key', { pid: 100, sessionId: 'wrong-extension' });
		const result = await discoverAgentSessions({
			homeDirectory: home,
			codexHome: path.join(home, '.codex'),
			isProcessRunning: (pid) => pid === 100,
			now: () => now,
			openCodexDatabase: () => undefined,
		});
		expect(result.claude).toBe('ok');
		expect(result.codex).toBe('unavailable');
		expect(result.sessions).toEqual([
			{
				kind: 'claude',
				sessionId: 'live-session',
				title: 'checkout',
				cwd: '/Users/dev/app',
				status: 'idle',
				pid: 100,
				startedAt: now - 5_000,
				updatedAt: now - 1_000,
			},
		]);
	});

	it('reads recent Codex threads from the newest state database, read-only, and always closes it', async () => {
		await writeFile(path.join(home, '.codex', 'state_3.sqlite'), '');
		await writeFile(path.join(home, '.codex', 'state_12.sqlite'), '');
		const opened: string[] = [];
		let closed = 0;
		const database: CodexDatabase = {
			threads: (since) => {
				expect(since).toBe(now - 30 * 60 * 1_000);
				return [
					{
						id: '01a0f36f-9daa-7990-9dfe-53ee1cf32874',
						cwd: '/Users/dev/app',
						title: 'Fix the cart',
						name: null,
						created_at_ms: now - 100_000,
						updated_at_ms: now - 10_000,
					},
					{
						id: 'bad id with spaces',
						cwd: null,
						title: null,
						name: null,
						created_at_ms: null,
						updated_at_ms: null,
					},
				];
			},
			close: () => {
				closed += 1;
			},
		};
		const result = await discoverAgentSessions({
			homeDirectory: home,
			codexHome: path.join(home, '.codex'),
			isProcessRunning: () => false,
			now: () => now,
			openCodexDatabase: (file) => {
				opened.push(path.basename(file));
				return database;
			},
		});
		expect(opened).toEqual(['state_12.sqlite']);
		expect(closed).toBe(1);
		expect(result.codex).toBe('ok');
		expect(result.sessions).toEqual([
			{
				kind: 'codex',
				sessionId: '01a0f36f-9daa-7990-9dfe-53ee1cf32874',
				title: 'Fix the cart',
				cwd: '/Users/dev/app',
				status: 'recent',
				startedAt: now - 100_000,
				updatedAt: now - 10_000,
			},
		]);
	});

	it('opens a real Codex state database read-only through node:sqlite when available', async () => {
		let sqlite: {
			DatabaseSync: new (
				file: string
			) => { exec: (sql: string) => void; close: () => void };
		};
		try {
			sqlite = (await import('node:sqlite')) as unknown as typeof sqlite;
		} catch {
			return; // This Node has no node:sqlite; discovery degrades to unavailable there.
		}
		const file = path.join(home, '.codex', 'state_7.sqlite');
		const db = new sqlite.DatabaseSync(file);
		db.exec(
			`CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, name TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, archived INTEGER);
			 INSERT INTO threads VALUES ('01a0f36f-9daa-7990-9dfe-53ee1cf32874', '/Users/dev/app', 'Fix cart', NULL, ${now - 5_000}, ${now - 1_000}, 0);
			 INSERT INTO threads VALUES ('archived-thread', '/Users/dev/app', 'old', NULL, ${now - 5_000}, ${now - 1_000}, 1);
			 INSERT INTO threads VALUES ('stale-thread', '/Users/dev/app', 'stale', NULL, 1, 1, 0);`
		);
		db.close();
		const result = await discoverAgentSessions({
			homeDirectory: home,
			codexHome: path.join(home, '.codex'),
			isProcessRunning: () => false,
			now: () => now,
		});
		expect(result.codex).toBe('ok');
		expect(result.sessions.map((session) => session.sessionId)).toEqual([
			'01a0f36f-9daa-7990-9dfe-53ee1cf32874',
		]);
	});

	it('reports both sources unavailable on a machine without either agent', async () => {
		const result = await discoverAgentSessions({
			homeDirectory: path.join(home, 'nowhere'),
			codexHome: path.join(home, 'nowhere-codex'),
			now: () => now,
			openCodexDatabase: () => undefined,
		});
		expect(result).toEqual({
			sessions: [],
			claude: 'unavailable',
			codex: 'unavailable',
		});
	});
});

describe('AgentService', () => {
	let root: string;
	let clock: number;
	let sessions: Awaited<ReturnType<typeof discoverAgentSessions>>['sessions'];
	let codexDiscovery: 'ok' | 'unavailable';
	let service: AgentService;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-agent-service-'));
		clock = now;
		codexDiscovery = 'unavailable';
		sessions = [
			{
				kind: 'claude',
				sessionId: 'claude-1',
				title: 'checkout',
				cwd: '/Users/dev/app-checkout',
				pid: 1,
			},
		];
		service = new AgentService({
			directory: root,
			lanes: () => [
				{
					id: 'lane-checkout',
					simulatorUdid: A,
					worktreePath: '/Users/dev/app-checkout',
					metro: 'ready',
					startedAt: clock - 60_000,
				},
			],
			discover: async () => ({
				sessions,
				claude: 'ok',
				codex: codexDiscovery,
			}),
			pollIntervalMs: 60_000,
			now: () => clock,
		});
		await service.start();
	});
	afterEach(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});

	it('claims, touches, attributes, and releases, persisting claims across restarts', async () => {
		const claimed = await service.runOperation({
			kind: 'agent.claim',
			simulatorUdid: A.toLowerCase(),
			agent: { kind: 'claude', sessionId: 'claude-1' },
			note: 'reviewing checkout',
		});
		expect(claimed.claims).toEqual([
			{
				simulatorUdid: A,
				kind: 'claude',
				sessionId: 'claude-1',
				note: 'reviewing checkout',
				claimedAt: now,
			},
		]);
		expect(claimed.byDevice[A]?.map((agent) => agent.via)).toEqual(['claim']);

		// Restart with the same directory: the claim is still there.
		await service.stop();
		service = new AgentService({
			directory: root,
			lanes: () => [],
			discover: async () => ({ sessions, claude: 'ok', codex: 'unavailable' }),
			now: () => clock,
		});
		await service.start();
		expect(service.getState().claims).toHaveLength(1);

		service.touch({ kind: 'codex', sessionId: 'codex-9' }, A);
		expect(
			service
				.getState()
				.byDevice[A]?.map((agent) => [agent.sessionId, agent.via, agent.live])
		).toEqual([
			['claude-1', 'claim', true],
			['codex-9', 'touch', false],
		]);

		await expect(
			service.runOperation({
				kind: 'agent.release',
				simulatorUdid: A,
				agent: { kind: 'claude', sessionId: 'someone-else' },
			})
		).rejects.toThrow(/holds no claim/);
		const released = await service.runOperation({
			kind: 'agent.release',
			simulatorUdid: A,
		});
		expect(released.claims).toEqual([]);
	});

	it('keeps claims and holds unchanged when persistence fails, then accepts a retry', async () => {
		const agent = { kind: 'claude' as const, sessionId: 'claude-1' };
		await service.runOperation({
			kind: 'agent.claim',
			simulatorUdid: B,
			agent,
		});
		const claims = service.getState().claims;
		const file = path.join(root, 'claims.json');
		await rename(file, `${file}.backup`);
		await mkdir(file);

		await expect(
			service.runOperation({ kind: 'agent.release', simulatorUdid: B, agent })
		).rejects.toThrow();
		expect(service.getState().claims).toEqual(claims);
		expect(service.access(B, 'anonymous').allowed).toBe(false);
		await expect(
			service.runOperation({
				kind: 'agent.claim',
				simulatorUdid: B,
				agent,
				note: 'unsaved',
			})
		).rejects.toThrow();
		expect(service.getState().claims).toEqual(claims);

		await rm(file, { recursive: true });
		await rename(`${file}.backup`, file);
		await service.runOperation({
			kind: 'agent.release',
			simulatorUdid: B,
			agent,
		});
		expect(service.getState().claims).toEqual([]);
		expect(JSON.parse(await readFile(file, 'utf8')).claims).toEqual([]);
		await rename(file, `${file}.backup`);
		await mkdir(file);
		await expect(
			service.runOperation({ kind: 'agent.claim', simulatorUdid: B, agent })
		).rejects.toThrow();
		expect(service.getState().claims).toEqual([]);
		expect(service.access(B, 'anonymous').allowed).toBe(true);
	});

	it('refuses to start or write after a claims read failure', async () => {
		await service.stop();
		const file = path.join(root, 'claims.json');
		await mkdir(file);
		await writeFile(path.join(file, 'keep'), 'saved data');
		service = new AgentService({
			directory: root,
			lanes: () => [],
			discover: async () => ({ sessions, claude: 'ok', codex: 'ok' }),
		});
		await expect(service.start()).rejects.toThrow();
		await expect(
			service.runOperation({
				kind: 'agent.claim',
				simulatorUdid: B,
				agent: { kind: 'claude', sessionId: 'claude-1' },
			})
		).rejects.toThrow();
		expect(await readFile(path.join(file, 'keep'), 'utf8')).toBe('saved data');
	});

	it('preserves malformed claims in quarantine before accepting fresh claims', async () => {
		await service.stop();
		const file = path.join(root, 'claims.json');
		await writeFile(file, '{broken json');
		service = new AgentService({
			directory: root,
			lanes: () => [],
			discover: async () => ({ sessions, claude: 'ok', codex: 'ok' }),
		});
		await service.start();
		await service.runOperation({
			kind: 'agent.claim',
			simulatorUdid: B,
			agent: { kind: 'claude', sessionId: 'claude-1' },
		});
		const quarantined = (await readdir(root)).find((name) =>
			name.startsWith('claims.json.corrupt-')
		);
		expect(quarantined).toBeDefined();
		expect(
			await readFile(path.join(root, quarantined ?? 'missing'), 'utf8')
		).toBe('{broken json');
	});

	it('drops a claim once its session has been gone for the hold grace period, not before', async () => {
		await service.runOperation({
			kind: 'agent.claim',
			simulatorUdid: B,
			agent: { kind: 'claude', sessionId: 'claude-1' },
		});
		sessions = [];
		await service.refresh();
		expect(service.getState().claims).toHaveLength(1);
		expect(service.getState().byDevice[B]?.[0]).toMatchObject({ live: false });
		clock += DEVICE_HOLD_GRACE_MS - 1;
		await service.refresh();
		expect(service.getState().claims).toHaveLength(1);
		clock += 1;
		await service.refresh();
		expect(service.getState().claims).toEqual([]);
	});

	it('answers who holds each device and who may touch it', async () => {
		await service.runOperation({
			kind: 'agent.claim',
			simulatorUdid: B,
			agent: { kind: 'codex', sessionId: 'codex-9' },
		});
		// A is held through the fixture lane, which has no agent and so belongs to
		// the operator; B through codex-9's claim.
		const holds = service.holds();
		expect(holds.get(A)).toMatchObject({
			via: 'lane',
			laneId: 'lane-checkout',
			holderLive: true,
		});
		expect(holds.get(A)?.holder).toBeUndefined();
		expect(holds.get(B)).toMatchObject({
			via: 'claim',
			holder: { kind: 'codex', sessionId: 'codex-9' },
		});

		const claude = { kind: 'claude' as const, sessionId: 'claude-1' };
		const codex = { kind: 'codex' as const, sessionId: 'codex-9' };
		expect(service.access(A, 'operator').allowed).toBe(true);
		expect(service.access(A, claude).allowed).toBe(false);
		expect(service.access(B, codex).allowed).toBe(true);
		expect(service.access(B, claude).allowed).toBe(false);
		expect(
			service.access('AAAAAAAA-0000-4000-8000-00000000000F', claude).allowed
		).toBe(true);
		// A request that names no session is nobody's: it gets the free device
		// and neither the operator's lane nor the claimed one.
		expect(service.access(A, 'anonymous').allowed).toBe(false);
		expect(service.access(B, 'anonymous').allowed).toBe(false);
		expect(
			service.access('AAAAAAAA-0000-4000-8000-00000000000F', 'anonymous')
				.allowed
		).toBe(true);

		// codex-9 is not a live session, but Codex discovery is unavailable in
		// this fixture: its sessions cannot be seen, so the hold is unknown rather
		// than abandoned and its clock does not start.
		await service.refresh();
		expect(service.holds().get(B)).toMatchObject({ holderLive: false });
		clock += DEVICE_HOLD_GRACE_MS;
		await service.refresh();
		expect(service.access(B, claude).allowed).toBe(false);
		expect(service.getState().claims).toHaveLength(1);

		// Once Codex can be seen and codex-9 is still missing, the clock starts
		// and the hold opens up after the grace period.
		codexDiscovery = 'ok';
		await service.refresh();
		expect(service.access(B, claude).allowed).toBe(false);
		clock += DEVICE_HOLD_GRACE_MS;
		expect(service.access(B, claude).allowed).toBe(true);
	});

	it('keeps clocks for holders other resources name, and answers their liveness', async () => {
		const holder = { kind: 'claude' as const, sessionId: 'claude-2' };
		let named = [{ holder, directory: '/Users/dev/app-checkout' }];
		const withHolders = new AgentService({
			directory: path.join(root, 'with-holders'),
			lanes: () => [],
			holders: () => named,
			discover: async () => ({ sessions, claude: 'ok', codex: 'ok' }),
			now: () => clock,
		});
		await withHolders.start();
		const since = clock;
		clock += 60_000;
		await withHolders.refresh();
		expect(withHolders.holderLiveness(holder)).toEqual({
			live: false,
			abandonedSince: since,
			releaseAt: since + DEVICE_HOLD_GRACE_MS,
		});
		expect(
			withHolders.holderLiveness({ kind: 'claude', sessionId: 'claude-1' })
		).toEqual({ live: true });

		// Once nothing names the holder, its clock is dropped.
		named = [];
		await withHolders.refresh();
		expect(withHolders.holderLiveness(holder)).toMatchObject({
			abandonedSince: clock,
		});
		await withHolders.stop();
	});

	it('attributes a session to the lane whose checkout it works in', () => {
		expect(service.getState().byDevice[A]).toEqual([
			expect.objectContaining({
				sessionId: 'claude-1',
				via: 'lane',
				live: true,
			}),
		]);
	});

	it('keeps a device with its first claimant when that session claims it again', async () => {
		const first = { kind: 'claude' as const, sessionId: 'claude-1' };
		const later = { kind: 'codex' as const, sessionId: 'codex-9' };
		await service.runOperation({
			kind: 'agent.claim',
			simulatorUdid: B,
			agent: first,
		});
		// The operator may still claim a held device on another session's behalf.
		await service.runOperation({
			kind: 'agent.claim',
			simulatorUdid: B,
			agent: later,
		});
		await service.runOperation({
			kind: 'agent.claim',
			simulatorUdid: B,
			agent: first,
			note: 'still mine',
		});
		expect(service.holds().get(B)?.holder).toEqual(first);
		expect(service.access(B, first).allowed).toBe(true);
		expect(service.access(B, later).allowed).toBe(false);
		expect(
			service.getState().claims.map((claim) => [claim.sessionId, claim.note])
		).toEqual([
			['claude-1', 'still mine'],
			['codex-9', undefined],
		]);
	});

	it('persists overlapping claims and releases in order, failing none of them', async () => {
		const udids = Array.from(
			{ length: 8 },
			(_, index) => `AAAAAAAA-0000-4000-8000-00000000001${index}`
		);
		await Promise.all(
			udids.map((simulatorUdid, index) =>
				service.runOperation({
					kind: 'agent.claim',
					simulatorUdid,
					agent: { kind: 'claude', sessionId: `claude-${index + 10}` },
				})
			)
		);
		// A release and a claim started in the same tick.
		await Promise.all([
			service.runOperation({
				kind: 'agent.release',
				simulatorUdid: 'AAAAAAAA-0000-4000-8000-000000000010',
				agent: { kind: 'claude', sessionId: 'claude-10' },
			}),
			service.runOperation({
				kind: 'agent.claim',
				simulatorUdid: B,
				agent: { kind: 'claude', sessionId: 'claude-1' },
			}),
		]);
		const claims = service.getState().claims;
		expect(claims).toHaveLength(8);
		// What a restart reads back is exactly what the running service holds.
		const restarted = new AgentService({
			directory: root,
			lanes: () => [],
			discover: async () => ({ sessions, claude: 'ok', codex: 'unavailable' }),
			now: () => clock,
		});
		await restarted.start();
		expect(restarted.getState().claims).toEqual(claims);
		await restarted.stop();
	});

	it('keeps answering when more than 32 sessions have touched one device', () => {
		for (let index = 0; index < 40; index += 1) {
			clock += 1;
			service.touch({ kind: 'claude', sessionId: `headless-${index}` }, B);
		}
		const attached = service.getState().byDevice[B] ?? [];
		expect(attached).toHaveLength(32);
		expect(attached[0]?.sessionId).toBe('headless-39');
	});

	it('notifies subscribers with validated state and keeps discovery errors visible', async () => {
		const seen: number[] = [];
		const unsubscribe = service.subscribe((state) => seen.push(state.revision));
		service.touch({ kind: 'claude', sessionId: 'claude-1' }, A);
		expect(seen).toHaveLength(1);
		unsubscribe();
		const failing = new AgentService({
			directory: path.join(root, 'failing'),
			lanes: () => [],
			discover: async () => {
				throw new Error('registry unreadable');
			},
			now: () => clock,
		});
		await failing.start();
		expect(failing.getState().discovery.error).toBe('registry unreadable');
		await failing.stop();
	});
});

/**
 * The lane service's reconcile is what tears an abandoned lane down, and it
 * asks the agent service who holds each device, wired as index.ts wires them.
 * Lanes are seeded straight into the store: these tests are about the hold
 * clocks and the reconcile, not about starting lanes.
 */
describe('AgentService holds through the lane reconcile', () => {
	const APP = '/Users/dev/app-checkout';
	const OTHER_APP = '/Users/dev/app-onboarding';
	const LANE_A = 'lane-11111111-2222-4333-8444-555555555555';
	const LANE_B = 'lane-22222222-2222-4333-8444-555555555555';
	// The holder an older desktop recorded for every Codex session that called
	// over MCP. No request verifies as it now, but its holds persist.
	const synthetic = {
		kind: 'codex' as const,
		sessionId: 'mcp-codex-mcp-client',
	};

	class FakeMetro implements MetroSupervisorPort {
		readonly stopped: Array<{ pid: number; port: number }> = [];
		isPortFree = async () => true;
		start = async (_input: MetroLaunchInput) => 1;
		isHealthy = async () => true;
		isProcessRunning = () => true;
		stop = async (pid: number, port: number) => {
			this.stopped.push({ pid, port });
		};
		readLogTail = async () => '';
	}

	function unused(): never {
		throw new Error('The reconcile path never drives the Simulator.');
	}
	const simulator: LaneSimulatorPort = {
		getState: unused,
		refresh: unused,
		runAction: unused,
		cancelJob: unused,
		subscribe: unused,
	};
	const worktrees: WorktreeInspectorPort = {
		repositoryRoot: async () => '/Users/dev/app',
		listWorktrees: async () => [],
		readExpoIdentity: async () => ({}),
	};

	let root: string;
	let clock: number;
	let sessions: AgentSession[];
	let discovery: { claude: 'ok' | 'unavailable'; codex: 'ok' | 'unavailable' };
	let metro: FakeMetro;
	let lanes: LaneService;
	let agents: AgentService;

	function lane(
		id: string,
		simulatorUdid: string,
		appDirectory: string,
		agent: { kind: 'claude' | 'codex' | 'other'; sessionId: string },
		port = 8_100
	): Lane {
		return {
			id,
			worktreePath: appDirectory,
			branch: 'feature',
			simulatorUdid,
			environment: 'development',
			port,
			metroPid: port - 4_000,
			metro: 'ready',
			logPath: path.join(root, 'lanes', 'logs', `${id}.log`),
			startedAt: now,
			agent: { ...agent, lastSeenAt: now },
		};
	}

	function session(
		kind: 'claude' | 'codex',
		sessionId: string,
		cwd: string
	): AgentSession {
		return { kind, sessionId, title: sessionId, cwd };
	}

	async function start(seed: readonly Lane[]): Promise<void> {
		const store = new LaneStore(path.join(root, 'lanes'));
		await store.start();
		for (const entry of seed) await store.upsert(entry);
		metro = new FakeMetro();
		lanes = new LaneService({
			store,
			simulator,
			metro,
			worktrees,
			holds: () => agents.holds(),
			now: () => clock,
		});
		agents = new AgentService({
			directory: path.join(root, 'agents'),
			lanes: () =>
				lanes.getState().lanes.map((entry) => ({
					id: entry.id,
					simulatorUdid: entry.simulatorUdid,
					worktreePath: entry.worktreePath,
					agent: entry.agent,
					metro: entry.metro,
					startedAt: entry.startedAt,
				})),
			discover: async () => ({ sessions, ...discovery }),
			pollIntervalMs: 60_000,
			now: () => clock,
		});
		await lanes.start();
		await agents.start();
	}

	/** One agent poll, then one lane reconcile, at the current clock. */
	async function tick(): Promise<void> {
		await agents.refresh();
		await lanes.runOperation({
			actionId: `reconcile-${clock}`,
			kind: 'lane.refresh',
		});
	}

	function laneIds(): string[] {
		return lanes.getState().lanes.map((entry) => entry.id);
	}

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-agent-holds-'));
		clock = now;
		sessions = [];
		discovery = { claude: 'ok', codex: 'ok' };
	});
	afterEach(async () => {
		await agents?.stop();
		await lanes?.stop();
		await rm(root, { recursive: true, force: true });
	});

	it('releases a lane-only holder once it has been gone for the grace period', async () => {
		sessions = [session('claude', 'claude-1', APP)];
		await start([
			lane(LANE_A, A, APP, { kind: 'claude', sessionId: 'claude-1' }),
		]);
		await tick();
		expect(agents.holds().get(A)).toMatchObject({ holderLive: true });

		// The session exits; the next poll starts the holder's clock.
		sessions = [];
		await tick();
		const missingAt = clock;
		clock += 60_000;
		expect(agents.holds().get(A)).toMatchObject({
			holderLive: false,
			abandonedSince: missingAt,
			releaseAt: missingAt + DEVICE_HOLD_GRACE_MS,
		});

		clock = missingAt + DEVICE_HOLD_GRACE_MS - 1;
		await tick();
		expect(laneIds()).toEqual([LANE_A]);
		expect(metro.stopped).toEqual([]);

		clock += 1;
		await tick();
		expect(laneIds()).toEqual([]);
		expect(metro.stopped).toEqual([{ pid: 4_100, port: 8_100 }]);
	});

	it('keeps a synthetic MCP holder live only on the lanes a session of its kind works in', async () => {
		sessions = [session('codex', 'thread-1', `${APP}/src`)];
		await start([
			lane(LANE_A, A, APP, synthetic),
			lane(LANE_B, B, OTHER_APP, synthetic, 8_101),
		]);
		await tick();
		expect(agents.holds().get(A)).toMatchObject({
			holder: synthetic,
			holderLive: true,
		});
		// The id is shared, but nobody works in the other app: its clock runs.
		expect(agents.holds().get(B)).toMatchObject({
			holderLive: false,
			abandonedSince: now,
		});

		clock += DEVICE_HOLD_GRACE_MS;
		await tick();
		expect(laneIds()).toEqual([LANE_A]);

		// Once the Codex thread works elsewhere, the remaining lane follows.
		sessions = [session('codex', 'thread-1', '/Users/dev/elsewhere')];
		await tick();
		clock += DEVICE_HOLD_GRACE_MS;
		await tick();
		expect(laneIds()).toEqual([]);
	});

	it('keeps a monorepo app lane while a session of its synthetic holder works from the checkout root', async () => {
		const REPO = '/Users/dev/repo';
		sessions = [session('codex', 'thread-1', REPO)];
		await start([
			{
				...lane(LANE_A, A, REPO, synthetic),
				appPath: `${REPO}/examples/expo-demo`,
			},
		]);
		await tick();
		expect(agents.holds().get(A)).toMatchObject({
			holder: synthetic,
			holderLive: true,
		});
		clock += 2 * DEVICE_HOLD_GRACE_MS;
		await tick();
		expect(laneIds()).toEqual([LANE_A]);
		expect(metro.stopped).toEqual([]);
		// The hold lets a thread of the holder's kind that works inside the lane
		// through, and the thread reads as attached.
		expect(
			agents.access(A, { kind: 'codex', sessionId: 'thread-1' }).allowed
		).toBe(true);
		expect(
			agents
				.getState()
				.byDevice[A]?.map((agent) => [agent.sessionId, agent.via])
		).toEqual([['thread-1', 'lane']]);
	});

	it('pauses the clocks of an agent kind while its discovery is unavailable', async () => {
		await start([
			lane(LANE_A, A, APP, { kind: 'codex', sessionId: 'thread-1' }),
		]);
		await tick();
		const missingAt = clock;

		// Four minutes in, Codex can no longer be seen: the clock pauses with six
		// minutes of grace left, however long the outage lasts.
		clock = missingAt + 4 * 60_000;
		discovery = { claude: 'ok', codex: 'unavailable' };
		await tick();
		clock += 3 * DEVICE_HOLD_GRACE_MS;
		await tick();
		expect(laneIds()).toEqual([LANE_A]);
		expect(agents.holds().get(A)).toMatchObject({
			holderLive: false,
			releaseAt: clock + 6 * 60_000,
		});

		// Codex is visible again and the thread is still gone: the clock resumes.
		discovery = { claude: 'ok', codex: 'ok' };
		await tick();
		clock += 6 * 60_000 - 1;
		await tick();
		expect(laneIds()).toEqual([LANE_A]);
		clock += 1;
		await tick();
		expect(laneIds()).toEqual([]);
	});

	it('starts no clock for a holder whose kind cannot be seen at all', async () => {
		discovery = { claude: 'ok', codex: 'unavailable' };
		await start([
			lane(LANE_A, A, APP, { kind: 'codex', sessionId: 'thread-1' }),
			// No discovery exists for `other` sessions, so they are never known gone.
			lane(
				LANE_B,
				B,
				OTHER_APP,
				{ kind: 'other', sessionId: 'harness-1' },
				8_101
			),
		]);
		await tick();
		clock += 3 * DEVICE_HOLD_GRACE_MS;
		await tick();
		expect(laneIds()).toEqual([LANE_A, LANE_B]);

		discovery = { claude: 'ok', codex: 'ok' };
		await tick();
		expect(agents.holds().get(A)).toMatchObject({
			abandonedSince: clock,
			releaseAt: clock + DEVICE_HOLD_GRACE_MS,
		});
	});

	it('drops the clock of a holder nothing names any more', async () => {
		const holder = { kind: 'claude' as const, sessionId: 'claude-1' };
		await start([lane(LANE_A, A, APP, holder)]);
		await tick();
		await lanes.runOperation({
			actionId: 'stop-a',
			kind: 'lane.stop',
			laneId: LANE_A,
		});
		clock += 5 * 60_000;
		await tick();

		// A new hold by the same session starts a fresh clock instead of
		// inheriting the five minutes the old lane had used up.
		await agents.runOperation({
			kind: 'agent.claim',
			simulatorUdid: B,
			agent: holder,
		});
		await tick();
		expect(agents.holds().get(B)).toMatchObject({
			via: 'claim',
			holderLive: false,
			abandonedSince: clock,
		});
	});

	it('lets a session of a synthetic holder’s kind that works inside the lane use its device', async () => {
		sessions = [
			session('codex', 'thread-1', `${APP}/src`),
			session('codex', 'thread-2', OTHER_APP),
			session('claude', 'claude-1', APP),
		];
		await start([lane(LANE_A, A, APP, synthetic)]);
		await tick();
		expect(agents.access(A, synthetic).allowed).toBe(true);
		expect(
			agents.access(A, { kind: 'codex', sessionId: 'thread-1' }).allowed
		).toBe(true);
		expect(
			agents.access(A, { kind: 'codex', sessionId: 'thread-2' }).allowed
		).toBe(false);
		expect(
			agents.access(A, { kind: 'claude', sessionId: 'claude-1' }).allowed
		).toBe(false);
	});
});

describe('AgentService.identify', () => {
	// Two Claude sessions with pids, and one Codex thread, which has none.
	const claudeA = { kind: 'claude', sessionId: 'claude-a' } as const;
	const claudeB = { kind: 'claude', sessionId: 'claude-b' } as const;
	const codexT = { kind: 'codex', sessionId: 'codex-t' } as const;
	const CLAUDE_A_PID = 100;
	const CLAUDE_B_PID = 200;

	// What identify says when it will not take a claim at its word, by cause.
	const NO_PROOF =
		'RN Devtools could not confirm which process sent the request (an older rndevtools command-line tool does not name its process, or the check timed out).';
	const NO_PROCESS_TABLE =
		'RN Devtools could not read the process list to find the session.';
	const NO_SESSION =
		'This caller cannot be tied to a running Claude Code session, so it cannot hold or drive Simulators. Reads still work.';
	const OTHER_SESSION =
		'The request names a session other than the one the sending process runs under.';
	const NOT_UNDER_SESSION =
		'The request names a running session, but the sending process does not run under it.';
	const noSession = {
		status: 'unverified',
		cause: 'no-session',
		reason: NO_SESSION,
	} as const;

	function entry(pid: number, ppid: number) {
		return { pid, ppid } satisfies ProcessTableEntry;
	}

	/**
	 * launchd (1) starts claude A (100) and B (200) and a terminal (300). The
	 * CLI that session A ran is 111, under a shell (110); the one B ran is 211.
	 * The terminal's CLI is 301. 400 is a Codex app-server with a CLI under it
	 * (401), and 500 a shell whose parent has already exited (ppid 1).
	 */
	const baseTable = [
		entry(1, 0),
		entry(CLAUDE_A_PID, 1),
		entry(110, CLAUDE_A_PID),
		entry(111, 110),
		entry(CLAUDE_B_PID, 1),
		entry(210, CLAUDE_B_PID),
		entry(211, 210),
		entry(300, 1),
		entry(301, 300),
		entry(400, 1),
		entry(401, 400),
		entry(500, 1),
	];

	let root: string;
	let service: AgentService;
	let clock: number;
	let discovered: AgentSession[];
	let table: readonly ProcessTableEntry[] | Error;
	let discoveries: number;

	function live(
		kind: AgentSession['kind'],
		sessionId: string,
		pid?: number
	): AgentSession {
		return {
			kind,
			sessionId,
			title: sessionId,
			cwd: '/Users/dev/app',
			...(pid === undefined ? {} : { pid }),
		};
	}

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-agent-identify-'));
		clock = now;
		discoveries = 0;
		table = baseTable;
		discovered = [
			live('claude', claudeA.sessionId, CLAUDE_A_PID),
			live('claude', claudeB.sessionId, CLAUDE_B_PID),
			live('codex', codexT.sessionId),
		];
		service = new AgentService({
			directory: root,
			lanes: () => [],
			discover: async () => {
				discoveries += 1;
				return { sessions: discovered, claude: 'ok', codex: 'ok' };
			},
			processTable: async () => {
				if (table instanceof Error) throw table;
				return table;
			},
			pollIntervalMs: 60_000,
			now: () => clock,
		});
		await service.start();
		discoveries = 0;
	});
	afterEach(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});

	it('takes a request that claims no session for anonymous, whoever sent it', async () => {
		await expect(service.identify({})).resolves.toEqual({
			status: 'anonymous',
		});
		await expect(service.identify({ peerPid: 111 })).resolves.toEqual({
			status: 'anonymous',
		});
		expect(discoveries).toBe(0);
	});

	it('leaves a claim unverified, and says why, when the sender was not proven or cannot be traced', async () => {
		await expect(service.identify({ claimed: claudeA })).resolves.toEqual({
			status: 'unverified',
			cause: 'no-proof',
			reason: NO_PROOF,
		});
		table = new Error('ps is not available');
		await expect(
			service.identify({ claimed: claudeA, peerPid: 111 })
		).resolves.toEqual({
			status: 'unverified',
			cause: 'no-process-table',
			reason: NO_PROCESS_TABLE,
		});
		// There was no process to place, so the sessions were not looked at again.
		expect(discoveries).toBe(0);
	});

	it('verifies a process under a session that claims exactly that session', async () => {
		// The CLI itself, and the shell it was run from, are both under claude A.
		for (const pid of [111, 110, CLAUDE_A_PID]) {
			await expect(
				service.identify({ claimed: claudeA, peerPid: pid })
			).resolves.toEqual({
				status: 'verified',
				agent: claudeA,
				basis: 'process',
			});
		}
		// Nothing needed to look again.
		expect(discoveries).toBe(0);
	});

	it('refuses a process under one session that claims another live session, with a process of its own or without', async () => {
		await expect(
			service.identify({ claimed: claudeB, peerPid: 111 })
		).resolves.toEqual({ status: 'mismatch', reason: OTHER_SESSION });
		// A Codex thread has no process, but it is as live as claude B: a thread
		// id that leaked into a Claude tree does not make the sender its own.
		await expect(
			service.identify({ claimed: codexT, peerPid: 111 })
		).resolves.toEqual({ status: 'mismatch', reason: OTHER_SESSION });
	});

	it('takes the session a process runs under when its claim names no live session', async () => {
		// The id a /clear replaced (an MCP server keeps the one it started with),
		// the shared id an MCP server makes up when it has no session variable,
		// another agent's variable that leaked into a Claude tree, and a Codex
		// thread that is no longer active: no live session has any of them.
		const claims = [
			{ kind: 'claude', sessionId: 'claude-a-before-clear' },
			{ kind: 'claude', sessionId: 'mcp-claude-code' },
			{ kind: 'other', sessionId: 'mcp-some-client' },
			{ kind: 'other', sessionId: 'id-from-another-tool' },
			{ kind: 'codex', sessionId: 'codex-thread-gone' },
		] as const;
		for (const claimed of claims) {
			// The claim disagrees with the session the sender is under, so the
			// sessions are discovered afresh before it is read as ignorable.
			discoveries = 0;
			for (const pid of [111, 110, CLAUDE_A_PID]) {
				await expect(
					service.identify({ claimed, peerPid: pid })
				).resolves.toEqual({
					status: 'verified',
					agent: claudeA,
					basis: 'process',
				});
			}
			expect(discoveries).toBe(3);
		}
	});

	it('takes the session nearest the sender when sessions nest', async () => {
		// Claude B was started from a shell under claude A.
		table = [
			...baseTable.filter((candidate) => candidate.pid !== CLAUDE_B_PID),
			entry(CLAUDE_B_PID, 110),
		];
		await expect(
			service.identify({ claimed: claudeB, peerPid: 211 })
		).resolves.toMatchObject({ status: 'verified', basis: 'process' });
		await expect(
			service.identify({ claimed: claudeA, peerPid: 211 })
		).resolves.toEqual({ status: 'mismatch', reason: OTHER_SESSION });
	});

	it('does not verify an undiscovered tree from its claimed session id', async () => {
		// A terminal, a Codex app-server and a hook whose claude already exited
		// (the registry file of an ending session may be gone) are no session's.
		for (const [pid, claimed] of [
			[301, { kind: 'claude', sessionId: 'claude-ended' }],
			[401, { kind: 'other', sessionId: 'mcp-codex-mcp-client' }],
			[500, { kind: 'claude', sessionId: 'claude-ending' }],
		] as const) {
			await expect(
				service.identify({ claimed, peerPid: pid })
			).resolves.toEqual(noSession);
		}
	});

	it('refuses an undiscovered tree that claims a live session with a process', async () => {
		await expect(
			service.identify({ claimed: claudeB, peerPid: 301 })
		).resolves.toEqual({ status: 'mismatch', reason: NOT_UNDER_SESSION });
		await expect(
			service.identify({ claimed: claudeA, peerPid: 500 })
		).resolves.toEqual({ status: 'mismatch', reason: NOT_UNDER_SESSION });
	});

	it('refuses to verify a Codex thread that shares a process with other threads', async () => {
		// The thread is live and discovered, yet nothing ties a process to it, so
		// the app-server's CLI, a hook and a terminal must all remain unverified.
		for (const pid of [401, 301, 500]) {
			await expect(
				service.identify({ claimed: codexT, peerPid: pid })
			).resolves.toEqual(noSession);
		}
	});

	it('does not let a registry entry for pid 1 vouch for the processes launchd adopted', async () => {
		// launchd is the ancestor of every orphaned process, so an entry that
		// names it would verify any of them.
		const init = { kind: 'claude', sessionId: 'claude-init' } as const;
		discovered = [live('claude', init.sessionId, 1), ...discovered];
		await service.refresh();
		// Process 500 is a shell whose parent exited: launchd's now.
		await expect(
			service.identify({ claimed: init, peerPid: 500 })
		).resolves.toEqual({ status: 'mismatch', reason: NOT_UNDER_SESSION });
		// A process under claude A is not launchd's session either.
		await expect(
			service.identify({ claimed: init, peerPid: 111 })
		).resolves.toEqual({ status: 'mismatch', reason: OTHER_SESSION });
		// And once the entry is gone it is not remembered for the minute after.
		discovered = discovered.filter((session) => session.pid !== 1);
		await service.refresh();
		await expect(
			service.identify({ claimed: init, peerPid: 500 })
		).resolves.toEqual(noSession);
	});

	it('discovers sessions once more for a session the last poll had not seen', async () => {
		const claudeC = { kind: 'claude', sessionId: 'claude-c' } as const;
		table = [...baseTable, entry(600, 1), entry(611, 600)];
		// Not discovered yet: an undiscovered tree claiming an unknown id.
		discovered = [...discovered, live('claude', claudeC.sessionId, 600)];
		await expect(
			service.identify({ claimed: claudeC, peerPid: 611 })
		).resolves.toEqual({
			status: 'verified',
			agent: claudeC,
			basis: 'process',
		});
		expect(discoveries).toBe(1);
		// Once it is known, nothing needs to look again.
		await expect(
			service.identify({ claimed: claudeC, peerPid: 611 })
		).resolves.toMatchObject({ basis: 'process' });
		expect(discoveries).toBe(1);
	});

	it('follows a session that took a new id, and does not read the id it dropped as another session', async () => {
		// Claude A took a new id (a /clear, say) since the last poll. Its process
		// is the same, and so are the MCP servers under it.
		const renamed = { kind: 'claude', sessionId: 'claude-a-cleared' } as const;
		discovered = [
			live('claude', renamed.sessionId, CLAUDE_A_PID),
			live('claude', claudeB.sessionId, CLAUDE_B_PID),
		];
		await expect(
			service.identify({ claimed: renamed, peerPid: 111 })
		).resolves.toEqual({
			status: 'verified',
			agent: renamed,
			basis: 'process',
		});
		expect(discoveries).toBe(1);
		// The id it dropped is no live session's now, and an MCP server that began
		// before the /clear still claims it. That is not a mismatch, however many
		// times the sessions are discovered again: the sender is under the renamed
		// session, which is the one discovery lists for this process, not the id
		// remembered beside it for the minute after.
		for (const call of [1, 2]) {
			await expect(
				service.identify({ claimed: claudeA, peerPid: 111 })
			).resolves.toEqual({
				status: 'verified',
				agent: renamed,
				basis: 'process',
			});
			expect(discoveries).toBe(1 + call);
		}
	});

	it('walks a process table with a cycle without hanging', async () => {
		table = [entry(700, 701), entry(701, 700)];
		const claimed = { kind: 'other', sessionId: 'looping-tool' } as const;
		await expect(service.identify({ claimed, peerPid: 700 })).resolves.toEqual(
			noSession
		);
	});

	describe('when Claude Code has deleted the registry file of a session that is still running', () => {
		// Claude Code deletes ~/.claude/sessions/<pid>.json before it runs the
		// SessionEnd hook on a normal exit, and its process outlives the hook.
		const sessionEnd = () =>
			service.identify({ claimed: claudeA, peerPid: 111 });

		it('still verifies the hook by its process for a minute after discovery last listed the session', async () => {
			discovered = [];
			await service.refresh();
			clock = now + 5_000;
			expect(service.getState().sessions).toEqual([]);
			discoveries = 0;
			for (const pid of [111, 110, CLAUDE_A_PID]) {
				await expect(
					service.identify({ claimed: claudeA, peerPid: pid })
				).resolves.toEqual({
					status: 'verified',
					agent: claudeA,
					basis: 'process',
				});
			}
			// The remembered session agreed with the claim: nothing to look again.
			expect(discoveries).toBe(0);

			// It was last listed at `now`: a minute on, still remembered, and one
			// millisecond later it is not.
			clock = now + RECENT_SESSION_MS;
			await expect(sessionEnd()).resolves.toMatchObject({
				status: 'verified',
			});
			clock = now + RECENT_SESSION_MS + 1;
			await expect(sessionEnd()).resolves.toEqual(noSession);
		});

		it('counts the minute from when discovery last listed the session, not from the polls since', async () => {
			// Listed at `now`; the polls that follow find it gone.
			discovered = [live('claude', claudeB.sessionId, CLAUDE_B_PID)];
			for (const after of [10_000, 40_000]) {
				clock = now + after;
				await service.refresh();
			}
			await expect(sessionEnd()).resolves.toMatchObject({
				status: 'verified',
			});
			// A poll 20 s ago would have kept it a while longer, had it counted.
			clock = now + RECENT_SESSION_MS + 1;
			await expect(sessionEnd()).resolves.toEqual(noSession);
		});

		it('remembers a session for the placing of a process and for nothing else', async () => {
			await service.runOperation({
				kind: 'agent.claim',
				simulatorUdid: A,
				agent: claudeA,
			});
			discovered = [live('claude', claudeB.sessionId, CLAUDE_B_PID)];
			await service.refresh();
			clock = now + 5_000;
			await expect(sessionEnd()).resolves.toMatchObject({
				status: 'verified',
			});

			// It is not listed, and what it holds is abandoned: the minute it is
			// remembered for does not keep it alive.
			const state = service.getState();
			expect(state.sessions.map((session) => session.sessionId)).toEqual([
				claudeB.sessionId,
			]);
			expect(state.holds[A]).toMatchObject({
				holder: claudeA,
				holderLive: false,
			});
			expect(service.holderLiveness(claudeA).live).toBe(false);
			expect(state.byDevice[A]?.[0]).toMatchObject({ live: false });

			// Nor is it a live session to be mismatched with: a process under no
			// session that names it is unverified, and a process under another
			// session has the claim ignored.
			await expect(
				service.identify({ claimed: claudeA, peerPid: 301 })
			).resolves.toEqual(noSession);
			await expect(
				service.identify({ claimed: claudeA, peerPid: 211 })
			).resolves.toEqual({
				status: 'verified',
				agent: claudeB,
				basis: 'process',
			});
		});

		it('counts the minute from the last listing of a session that stayed listed for a long time', async () => {
			// Listed by every poll for ten minutes, so its first listing is long
			// past: the minute runs from the last one.
			discovered = [live('claude', claudeA.sessionId, CLAUDE_A_PID)];
			for (let elapsed = 0; elapsed <= 600_000; elapsed += 10_000) {
				clock = now + elapsed;
				await service.refresh();
			}
			// Claude Code deletes the registry file, then runs the hook a few
			// seconds later.
			discovered = [];
			clock = now + 601_000;
			await service.refresh();
			clock = now + 605_000;
			await expect(sessionEnd()).resolves.toEqual({
				status: 'verified',
				agent: claudeA,
				basis: 'process',
			});
			clock = now + 600_000 + RECENT_SESSION_MS;
			await expect(sessionEnd()).resolves.toMatchObject({
				status: 'verified',
			});
			clock += 1;
			await expect(sessionEnd()).resolves.toEqual(noSession);
		});

		it('places a process under the session listed last when a /clear left two on one pid', async () => {
			const cleared = {
				kind: 'claude',
				sessionId: 'claude-a-cleared',
			} as const;
			// A /clear: the same process lists the old id, then the new one.
			discovered = [live('claude', claudeA.sessionId, CLAUDE_A_PID)];
			await service.refresh();
			clock = now + 10_000;
			discovered = [live('claude', cleared.sessionId, CLAUDE_A_PID)];
			await service.refresh();
			// The registry file is deleted on exit; the hook names the new id.
			clock = now + 20_000;
			discovered = [];
			await service.refresh();
			clock = now + 25_000;
			await expect(
				service.identify({ claimed: cleared, peerPid: 111 })
			).resolves.toEqual({
				status: 'verified',
				agent: cleared,
				basis: 'process',
			});
			// A late hook that still names the old id runs under the same process:
			// the old id is live nowhere, so the claim is ignored.
			await expect(sessionEnd()).resolves.toEqual({
				status: 'verified',
				agent: cleared,
				basis: 'process',
			});
		});

		it('refuses the hook of a remembered session that names another live session', async () => {
			discovered = [
				live('claude', claudeA.sessionId, CLAUDE_A_PID),
				live('claude', claudeB.sessionId, CLAUDE_B_PID),
			];
			await service.refresh();
			// A's file is deleted; B is still listed and live.
			discovered = [live('claude', claudeB.sessionId, CLAUDE_B_PID)];
			await service.refresh();
			clock = now + 5_000;
			await expect(
				service.identify({ claimed: claudeB, peerPid: 111 })
			).resolves.toMatchObject({ status: 'mismatch' });
			await expect(sessionEnd()).resolves.toMatchObject({
				status: 'verified',
			});
		});

		it('verifies the hook of a real registry once its file is deleted', async () => {
			const home = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-hook-'));
			try {
				const sessions = path.join(home, '.claude', 'sessions');
				await mkdir(sessions, { recursive: true });
				const file = path.join(sessions, `${CLAUDE_A_PID}.json`);
				await writeFile(
					file,
					JSON.stringify({
						pid: CLAUDE_A_PID,
						sessionId: claudeA.sessionId,
						cwd: '/Users/dev/app',
					})
				);
				const real = new AgentService({
					directory: path.join(root, 'real'),
					lanes: () => [],
					discover: () =>
						discoverAgentSessions({
							homeDirectory: home,
							codexHome: path.join(home, '.codex'),
							isProcessRunning: () => true,
							now: () => clock,
							openCodexDatabase: () => undefined,
						}),
					processTable: async () => baseTable,
					pollIntervalMs: 60_000,
					now: () => clock,
				});
				await real.start();
				try {
					await expect(
						real.identify({ claimed: claudeA, peerPid: 111 })
					).resolves.toMatchObject({ status: 'verified' });
					await rm(file);
					// The poll that follows finds the file gone.
					await real.refresh();
					clock = now + 5_000;
					expect(real.getState().sessions).toEqual([]);
					await expect(
						real.identify({ claimed: claudeA, peerPid: 111 })
					).resolves.toEqual({
						status: 'verified',
						agent: claudeA,
						basis: 'process',
					});
				} finally {
					await real.stop();
				}
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		});
	});
});
