import type { SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createMetroSupervisor,
	isLaneMetroCommand,
	laneEnvProblem,
} from './lane-metro';
import {
	SimulatorCommandError,
	type SimulatorCommandResult,
} from './simulator-command-runner';

describe('isLaneMetroCommand', () => {
	it('recognises the Metro a lane started by its --port argument, wherever the binary lives', () => {
		expect(
			isLaneMetroCommand(
				'node /Users/dev/app/node_modules/.bin/expo start --dev-client --localhost --port 8100 --max-workers 2',
				8_100
			)
		).toBe(true);
		// pnpm hoists the binary to the workspace root; the cwd is not on the command line.
		expect(
			isLaneMetroCommand(
				'node /Users/dev/monorepo/node_modules/.bin/expo start --dev-client --localhost --port 8100 --max-workers 2',
				8_100
			)
		).toBe(true);
		expect(isLaneMetroCommand('node expo start --port=8100', 8_100)).toBe(true);
	});

	it("refuses a reused PID that is not this lane's Metro", () => {
		expect(isLaneMetroCommand('node expo start --port 8101', 8_100)).toBe(
			false
		);
		expect(isLaneMetroCommand('node expo start --port 81000', 8_100)).toBe(
			false
		);
		expect(isLaneMetroCommand('/usr/bin/ssh -p 8100 host', 8_100)).toBe(false);
		expect(isLaneMetroCommand('postgres --port 8100', 8_100)).toBe(false);
		expect(isLaneMetroCommand('', 8_100)).toBe(false);
	});
});

describe('Metro launch', () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-metro-'));
		await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
		await writeFile(path.join(root, 'node_modules', '.bin', 'expo'), '');
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function supervisor(environment: NodeJS.ProcessEnv) {
		const spawned: Array<{
			command: string;
			args: readonly string[];
			options: SpawnOptions;
		}> = [];
		const metro = createMetroSupervisor({
			environment,
			spawnProcess: (command, args, options) => {
				spawned.push({ command, args, options });
				return { pid: 4_242, unref: () => undefined };
			},
		});
		return { metro, spawned };
	}

	function launch(
		metro: ReturnType<typeof supervisor>['metro'],
		extra: {
			metroEnv?: Record<string, string>;
			laneEnv?: Record<string, string>;
		} = {}
	) {
		return metro.start({
			worktreePath: root,
			port: 8_100,
			logPath: path.join(root, 'lane.log'),
			maxWorkers: 2,
			...extra,
		});
	}

	it('gives Metro the stripped inherited env, then metroEnv, then laneEnv, then the fixed keys', async () => {
		const { metro, spawned } = supervisor({
			PATH: '/usr/bin:/bin',
			HOME: '/Users/dev',
			NODE_OPTIONS: '--max-old-space-size=4096',
			SHARED: 'inherited',
			NODE_ENV: 'production',
			CI: '0',
			// Nothing the desktop was launched with may reach a lane's bundle
			// or point its tooling at another backend or session.
			EXPO_PUBLIC_SUPABASE_URL: 'https://example.com',
			EXPO_PUBLIC_FLAVOR: 'inherited',
			SUPABASE_ACCESS_TOKEN: 'sbp_inherited',
			SUPABASE_DB_PASSWORD: 'inherited',
			PGPASSWORD: 'inherited',
			PGHOST: 'db.example.com',
			RNDEVTOOLS_AGENT_SESSION_ID: 'session-1',
		});
		const pid = await launch(metro, {
			metroEnv: {
				SHARED: 'metro-env',
				FROM_ENVIRONMENT: '1',
				EXPO_PUBLIC_FLAVOR: 'staging',
			},
			laneEnv: {
				SHARED: 'lane-env',
				EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
				EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
				// The fixed keys win over anything a lane passes.
				CI: '0',
			},
		});
		expect(pid).toBe(4_242);
		expect(spawned).toHaveLength(1);
		expect(spawned[0]?.command).toBe(
			path.join(root, 'node_modules', '.bin', 'expo')
		);
		expect(spawned[0]?.args).toEqual([
			'start',
			'--dev-client',
			'--localhost',
			'--port',
			'8100',
			'--max-workers',
			'2',
		]);
		expect(spawned[0]?.options).toMatchObject({ cwd: root, detached: true });
		expect(spawned[0]?.options.env).toEqual({
			PATH: '/usr/bin:/bin',
			HOME: '/Users/dev',
			SHARED: 'lane-env',
			FROM_ENVIRONMENT: '1',
			EXPO_PUBLIC_FLAVOR: 'staging',
			EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
			EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
			NODE_ENV: 'development',
			RCT_METRO_PORT: '8100',
			EXPO_NO_DOTENV: '1',
			EXPO_NO_INTERACTIVE: '1',
			EXPO_NO_DEV_MENU: '1',
			CI: '1',
			NODE_OPTIONS: '--max-old-space-size=4096 --dns-result-order=ipv4first',
		});
	});

	it('strips the inherited variables even when no environment or lane adds any', async () => {
		const { metro, spawned } = supervisor({
			PATH: '/usr/bin:/bin',
			EXPO_PUBLIC_API_URL: 'https://api.example.com',
			PGUSER: 'postgres',
		});
		await launch(metro);
		expect(spawned[0]?.options.env).toEqual({
			PATH: '/usr/bin:/bin',
			NODE_ENV: 'development',
			RCT_METRO_PORT: '8100',
			EXPO_NO_DOTENV: '1',
			EXPO_NO_INTERACTIVE: '1',
			EXPO_NO_DEV_MENU: '1',
			CI: '1',
			NODE_OPTIONS: '--dns-result-order=ipv4first',
		});
	});

	it.each([
		[
			'a secret-named variable',
			{
				EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.e30.c2ln',
			},
		],
		['a secret key under a neutral name', { EXPO_PUBLIC_KEY: 'sb_secret_x1' }],
		[
			'a URL that carries a password',
			{ EXPO_PUBLIC_DB: 'postgresql://postgres:hunter2@127.0.0.1:54322/db' },
		],
		[
			'a name outside the metroEnv rule',
			{ 'expo-public-url': 'http://127.0.0.1:54321' },
		],
		['an oversized value', { EXPO_PUBLIC_BLOB: 'x'.repeat(1_025) }],
	])(
		'refuses a laneEnv with %s and spawns nothing',
		async (_label, laneEnv) => {
			const { metro, spawned } = supervisor({ PATH: '/usr/bin:/bin' });
			const error = await launch(metro, { laneEnv }).then(
				() => undefined,
				(caught: unknown) => caught as Error
			);
			expect(error?.message).toMatch(/lane variable/i);
			for (const value of Object.values(laneEnv)) {
				expect(error?.message).not.toContain(value);
			}
			expect(spawned).toEqual([]);
		}
	);
});

describe('laneEnvProblem', () => {
	it('passes public values, and names a refused variable without echoing its value', () => {
		expect(laneEnvProblem(undefined)).toBeUndefined();
		expect(
			laneEnvProblem({
				EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:21734',
				EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
			})
		).toBeUndefined();
		const secret = laneEnvProblem({ EXPO_PUBLIC_KEY: 'sb_secret_x1' });
		expect(secret).toMatch(/EXPO_PUBLIC_KEY holds a secret key/);
		expect(secret).not.toContain('sb_secret_x1');
		expect(laneEnvProblem({ SUPABASE_SERVICE_ROLE_KEY: 'x' })).toMatch(
			/names a credential/
		);
	});
});

describe('Metro health', () => {
	const ANSWERS = async () => ({
		ok: true,
		text: async () => 'packager-status:running',
	});

	function probe(
		lsof: (args: readonly string[]) => Promise<SimulatorCommandResult>,
		answers: typeof ANSWERS = ANSWERS
	) {
		const commands: Array<{ executable: string; args: readonly string[] }> = [];
		const metro = createMetroSupervisor({
			probe: answers,
			runCommand: async (executable, args) => {
				commands.push({ executable, args });
				return lsof(args);
			},
		});
		return { metro, commands };
	}

	it("counts only when the lane's own Metro process listens on the port", async () => {
		const { metro, commands } = probe(async () => ({
			stdout: 'p4242\nf23\n',
			stderr: '',
			exitCode: 0,
		}));
		expect(await metro.isHealthy(8_100, 4_242)).toBe(true);
		expect(commands).toEqual([
			{
				executable: '/usr/sbin/lsof',
				args: [
					'-a',
					'-p',
					'4242',
					'-iTCP:8100',
					'-sTCP:LISTEN',
					'-n',
					'-P',
					'-Fp',
				],
			},
		]);
	});

	it("does not count another worktree's packager answering on the lane's port", async () => {
		// lsof exits 1 when the process has no listener there.
		const { metro } = probe(async () => {
			throw new SimulatorCommandError('lsof failed with exit code 1.', {
				kind: 'failed',
				exitCode: 1,
			});
		});
		expect(await metro.isHealthy(8_100, 4_242)).toBe(false);
		const { metro: other } = probe(async () => ({
			stdout: 'p31337\nf9\n',
			stderr: '',
			exitCode: 0,
		}));
		expect(await other.isHealthy(8_100, 4_242)).toBe(false);
	});

	it('fails closed when lsof cannot run', async () => {
		const { metro } = probe(async () => {
			throw new SimulatorCommandError('lsof timed out.', { kind: 'timeout' });
		});
		expect(await metro.isHealthy(8_100, 4_242)).toBe(false);
	});

	it('asks lsof nothing while no packager answers', async () => {
		const { metro, commands } = probe(
			async () => ({ stdout: 'p4242\n', stderr: '', exitCode: 0 }),
			async () => {
				throw new Error('connect ECONNREFUSED 127.0.0.1:8100');
			}
		);
		expect(await metro.isHealthy(8_100, 4_242)).toBe(false);
		expect(commands).toEqual([]);
	});
});

describe('Metro log tail', () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-metro-log-'));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('starts a cut tail at a whole line, so no half-secret leads it', async () => {
		const file = path.join(root, 'lane.log');
		await writeFile(
			file,
			'SECRET_KEY=sb_secret_abcdefghijklmnop\nline two\nline three\n'
		);
		const { readLogTail } = createMetroSupervisor();
		// The last 30 characters begin inside the secret's value, past its name.
		expect(await readLogTail(file, 30)).toBe('line two\nline three\n');
		expect(await readLogTail(file, 4_096)).toBe(
			'SECRET_KEY=sb_secret_abcdefghijklmnop\nline two\nline three\n'
		);
	});

	it('keeps a tail that is all one line', async () => {
		const file = path.join(root, 'lane.log');
		await writeFile(file, `${'a'.repeat(40)}\n`);
		const { readLogTail } = createMetroSupervisor();
		expect(await readLogTail(file, 11)).toBe('aaaaaaaaaa\n');
	});

	it('drops the partial first line of a log longer than the read window', async () => {
		const file = path.join(root, 'lane.log');
		await writeFile(file, `password=${'x'.repeat(256 * 1024)}\nlast line\n`);
		const { readLogTail } = createMetroSupervisor();
		expect(await readLogTail(file, 512 * 1024)).toBe('last line\n');
	});

	it('reads a missing log as empty', async () => {
		const { readLogTail } = createMetroSupervisor();
		expect(await readLogTail(path.join(root, 'absent.log'), 1_024)).toBe('');
	});
});
