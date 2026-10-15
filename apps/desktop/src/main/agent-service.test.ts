import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentService } from './agent-service';
import { type CodexDatabase, discoverAgentSessions } from './agent-sessions';

const A = 'AAAAAAAA-0000-4000-8000-000000000001';
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
	let service: AgentService;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-agent-service-'));
		clock = now;
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
				{ simulatorUdid: A, appDirectory: '/Users/dev/app-checkout' },
			],
			discover: async () => ({ sessions, claude: 'ok', codex: 'unavailable' }),
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

	it('drops a claim once its session has been gone for the touch TTL, not before', async () => {
		await service.runOperation({
			kind: 'agent.claim',
			simulatorUdid: A,
			agent: { kind: 'claude', sessionId: 'claude-1' },
		});
		sessions = [];
		await service.refresh();
		expect(service.getState().claims).toHaveLength(1);
		expect(service.getState().byDevice[A]?.[0]).toMatchObject({ live: false });
		clock += 30 * 60 * 1_000 + 1;
		await service.refresh();
		expect(service.getState().claims).toEqual([]);
	});

	it('attributes a session to the lane whose app directory it works in', () => {
		expect(service.getState().byDevice[A]).toEqual([
			expect.objectContaining({
				sessionId: 'claude-1',
				via: 'lane',
				live: true,
			}),
		]);
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
