import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import {
	MAX_METRO_ENV_VALUE_LENGTH,
	METRO_ENV_NAME,
} from '../shared/lane-protocol';
import { runSimulatorCommand } from './simulator-command-runner';

const METRO_PROBE_TIMEOUT_MS = 750;
const METRO_LOG_TAIL_BYTES = 256 * 1024;
const LSOF_PATH = '/usr/sbin/lsof';
const OWNER_PROBE_TIMEOUT_MS = 3_000;
const OWNER_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_LANE_ENV_ENTRIES = 32;

/**
 * What a lane's Metro must not inherit from the desktop. Metro inlines
 * EXPO_PUBLIC_* into every lane's dev bundle, and SUPABASE_*, PG* and
 * RNDEVTOOLS_* would point a worktree's tooling at whatever backend or agent
 * session the desktop happened to be launched from. A lane gets such values
 * only from its environment's metroEnv or its own laneEnv.
 */
const STRIPPED_INHERITED_ENV = /^(?:EXPO_PUBLIC_|SUPABASE_|PG|RNDEVTOOLS_)/;

/**
 * A laneEnv entry named like a credential is refused whatever its value, as
 * is a value that is a Supabase secret key or a URL with a password in it:
 * Metro inlines EXPO_PUBLIC_* values into the app bundle and hands the rest
 * to app.config.js, and neither is a place for a secret.
 */
const SECRET_ENV_NAME =
	/(?:SECRET|SERVICE_ROLE|PASSWORD|PASSWD|PRIVATE_KEY|ROOT_KEY|DB_URL|DATABASE_URL)/;
const SECRET_ENV_VALUE = /sb_secret_|:\/\/[^/\s:@]+:[^/\s@]+@/;

export type MetroLaunchInput = {
	worktreePath: string;
	port: number;
	logPath: string;
	/** Environment selected in JavaScript; never changes the native build. */
	metroEnv?: Readonly<Record<string, string>>;
	/**
	 * This lane's own variables, such as its local backend's URL and
	 * publishable key, applied over metroEnv. A launch input only: lanes.json
	 * and LaneState never carry it, because a value may be a key.
	 */
	laneEnv?: Readonly<Record<string, string>>;
	maxWorkers?: number;
};

export type MetroSupervisorPort = {
	isPortFree: (port: number) => Promise<boolean>;
	start: (input: MetroLaunchInput) => Promise<number>;
	/**
	 * Whether the Metro at `pid` is serving `port`: a packager answers there
	 * and that very process holds the listening socket.
	 */
	isHealthy: (port: number, pid: number) => Promise<boolean>;
	isProcessRunning: (pid: number) => boolean;
	/** Stops the Metro at `pid` only if it is the one serving `port`. */
	stop: (pid: number, port: number) => Promise<void>;
	readLogTail: (logPath: string, maxCharacters: number) => Promise<string>;
};

type CommandRunner = typeof runSimulatorCommand;

type MetroSpawn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions
) => Pick<ChildProcess, 'pid' | 'unref'>;

type PackagerProbe = (
	url: string,
	init: { signal: AbortSignal }
) => Promise<{ ok: boolean; text: () => Promise<string> }>;

/**
 * Proves a PID is still the Metro this lane started before signalling it.
 * The command line is the only thing `ps` gives us; the working directory is
 * not on it, and a pnpm workspace hoists `.bin/expo` far from the app, so the
 * proof is the `--port <n>` argument the lane itself passed at launch. PIDs
 * get reused; without this a stale lease could kill an unrelated process.
 */
export function isLaneMetroCommand(commandLine: string, port: number): boolean {
	if (!/\b(expo|metro)\b/i.test(commandLine)) return false;
	const match = /(?:^|\s)--port(?:=|\s+)(\d+)(?:\s|$)/.exec(commandLine);
	return match !== null && Number(match[1]) === port;
}

/**
 * Finds the Expo CLI the worktree itself depends on. A pnpm workspace member
 * hoists `.bin/expo` to the workspace root, so walk upward until one appears;
 * never fall back to a global install, which would bundle against the wrong
 * React Native.
 */
function resolveExpoBinary(worktreePath: string): string | undefined {
	let current = path.resolve(worktreePath);
	for (let depth = 0; depth < 6; depth += 1) {
		const candidate = path.join(current, 'node_modules', '.bin', 'expo');
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.unref();
		server.once('error', () => resolve(false));
		server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
			server.close(() => resolve(true));
		});
	});
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Why a lane's own variables may not reach Metro, or undefined when they
 * may. The reason names a variable only once its name is known to be well
 * formed, and never echoes a value. The lane service asks before a spawn so a
 * backend's variables it would refuse never fail the spawn itself.
 */
export function laneEnvProblem(
	laneEnv: Readonly<Record<string, string>> | undefined
): string | undefined {
	const entries = Object.entries(laneEnv ?? {});
	if (entries.length > MAX_LANE_ENV_ENTRIES) {
		return `At most ${MAX_LANE_ENV_ENTRIES} lane variables can reach Metro.`;
	}
	for (const [name, value] of entries) {
		if (!METRO_ENV_NAME.test(name)) {
			return 'A lane variable name must be uppercase letters, digits, and underscores, at most 64 characters.';
		}
		if (SECRET_ENV_NAME.test(name)) {
			return `Lane variable ${name} names a credential, and credentials never reach Metro.`;
		}
		if (
			typeof value !== 'string' ||
			value.length > MAX_METRO_ENV_VALUE_LENGTH
		) {
			return `Lane variable ${name} must be a string of at most ${MAX_METRO_ENV_VALUE_LENGTH} characters.`;
		}
		if (SECRET_ENV_VALUE.test(value)) {
			return `Lane variable ${name} holds a secret key or a URL with a password, and those never reach Metro.`;
		}
	}
	return undefined;
}

/** A lane's own variables, checked before they reach Metro. */
function checkedLaneEnv(
	laneEnv: Readonly<Record<string, string>> | undefined
): Record<string, string> {
	const problem = laneEnvProblem(laneEnv);
	if (problem) throw new Error(problem);
	return Object.fromEntries(Object.entries(laneEnv ?? {}));
}

/**
 * Metro's environment, in this order: the desktop's own environment without
 * the variables a lane must not inherit, then the environment's metroEnv,
 * then the lane's laneEnv, then the fixed keys every lane needs, which
 * nothing overrides.
 */
function metroEnvironment(
	inherited: NodeJS.ProcessEnv,
	input: MetroLaunchInput
): NodeJS.ProcessEnv {
	const laneEnv = checkedLaneEnv(input.laneEnv);
	const base: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(inherited)) {
		if (value !== undefined && !STRIPPED_INHERITED_ENV.test(name)) {
			base[name] = value;
		}
	}
	return {
		...base,
		...input.metroEnv,
		...laneEnv,
		NODE_ENV: 'development',
		RCT_METRO_PORT: String(input.port),
		EXPO_NO_DOTENV: '1',
		EXPO_NO_INTERACTIVE: '1',
		// Every launch URL and QR code the CLI emits gets the automation
		// parameters, so agents see the app rather than the launcher sheet.
		EXPO_NO_DEV_MENU: '1',
		CI: '1',
		// `--localhost` binds whatever "localhost" resolves to; Node's verbatim
		// DNS order picks [::1] on macOS while the dev client rewrites its
		// packager host to 127.0.0.1. Force IPv4 so the app can actually reach
		// its own Metro.
		NODE_OPTIONS: [inherited.NODE_OPTIONS, '--dns-result-order=ipv4first']
			.filter(Boolean)
			.join(' '),
	};
}

/**
 * Metro is detached so it survives the desktop app and so one lane's crash
 * cannot take down the main process. Its output goes to a per-lane log file
 * that the renderer and the agent CLI can tail.
 */
async function startMetro(
	input: MetroLaunchInput,
	spawnProcess: MetroSpawn,
	inherited: NodeJS.ProcessEnv
): Promise<number> {
	const expoBinary = resolveExpoBinary(input.worktreePath);
	if (!expoBinary) {
		throw new Error(
			`Expo CLI was not found under ${input.worktreePath}/node_modules. Install dependencies in the worktree first.`
		);
	}
	// Refuse a bad laneEnv before the log is created or anything spawns.
	const env = metroEnvironment(inherited, input);
	const log = openSync(input.logPath, 'a', 0o600);
	try {
		const child = spawnProcess(
			expoBinary,
			[
				'start',
				'--dev-client',
				'--localhost',
				'--port',
				String(input.port),
				'--max-workers',
				String(input.maxWorkers ?? 2),
			],
			{
				cwd: input.worktreePath,
				detached: true,
				stdio: ['ignore', log, log],
				env,
			}
		);
		child.unref();
		if (!child.pid) throw new Error('Metro did not return a process id.');
		return child.pid;
	} finally {
		closeSync(log);
	}
}

/**
 * `expo start --localhost` may bind either loopback family, so a probe that
 * only tried 127.0.0.1 would report a healthy Metro as dead forever.
 */
async function packagerAnswers(
	port: number,
	probe: PackagerProbe
): Promise<boolean> {
	for (const host of ['127.0.0.1', 'localhost'] as const) {
		try {
			const response = await probe(`http://${host}:${port}/status`, {
				signal: AbortSignal.timeout(METRO_PROBE_TIMEOUT_MS),
			});
			if (
				response.ok &&
				(await response.text()).includes('packager-status:running')
			) {
				return true;
			}
		} catch {
			// Try the other loopback family.
		}
	}
	return false;
}

/**
 * Whether `pid` itself holds a listening TCP socket on `port`. Expo serves
 * Metro from the CLI process the lane spawned, so the lane's PID is the
 * listener. lsof exits 1 when the process has no such socket; that, and any
 * failure to run it, reads as "not this lane's Metro".
 */
async function listensOn(
	pid: number,
	port: number,
	runCommand: CommandRunner
): Promise<boolean> {
	try {
		const result = await runCommand(
			LSOF_PATH,
			[
				'-a',
				'-p',
				String(pid),
				`-iTCP:${port}`,
				'-sTCP:LISTEN',
				'-n',
				'-P',
				'-Fp',
			],
			{
				timeoutMs: OWNER_PROBE_TIMEOUT_MS,
				maxOutputBytes: OWNER_PROBE_MAX_OUTPUT_BYTES,
			}
		);
		return result.stdout.split('\n').includes(`p${pid}`);
	} catch {
		return false;
	}
}

/**
 * A packager answering on a lane's port is not enough to call the lane
 * ready. After a port race, or with a Metro started by hand, another
 * worktree's packager can answer there, and a dev client sent to it would
 * load the wrong branch. The answer counts only when the lane's own Metro
 * owns the socket; ownership that cannot be proven fails closed.
 */
async function isMetroHealthy(
	port: number,
	pid: number,
	probe: PackagerProbe,
	runCommand: CommandRunner
): Promise<boolean> {
	if (!(await packagerAnswers(port, probe))) return false;
	return listensOn(pid, port, runCommand);
}

/**
 * Stops only a Metro this lane owns. PIDs are recycled, so before signalling
 * the process group the command line must still name the worktree and Expo.
 */
async function stopMetro(
	pid: number,
	port: number,
	runCommand: CommandRunner
): Promise<void> {
	if (!isProcessRunning(pid)) return;
	let commandLine: string | undefined;
	try {
		const result = await runCommand(
			'/bin/ps',
			['-p', String(pid), '-o', 'command='],
			{ timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }
		);
		commandLine = result.stdout;
	} catch (error) {
		// Without `ps` the PID cannot be proven to be ours. Fail closed and say
		// so: the lane keeps its lease and the operator can stop Metro by hand.
		throw new Error(
			`Could not inspect process ${pid} to confirm it is this lane's Metro (${(error as Error).message}); refusing to stop it. Stop the Metro on port ${port} manually, then stop the lane again.`
		);
	}
	if (!isLaneMetroCommand(commandLine, port)) {
		throw new Error(
			`Process ${pid} is no longer the Metro serving port ${port}; refusing to stop it.`
		);
	}
	try {
		process.kill(-pid, 'SIGTERM');
	} catch {
		process.kill(pid, 'SIGTERM');
	}
}

/**
 * The end of a lane's Metro log. A tail that starts mid-file starts at the
 * next whole line when one follows: a line cut at its head can begin inside
 * a secret whose name was cut off, which no redactor can recognise
 * afterwards. A tail that is all one line is returned as it is.
 */
async function readLogTail(
	logPath: string,
	maxCharacters: number
): Promise<string> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const info = await stat(logPath);
		const bytes = Math.min(info.size, METRO_LOG_TAIL_BYTES);
		handle = await open(logPath, 'r');
		const buffer = Buffer.alloc(bytes);
		await handle.read(buffer, 0, bytes, info.size - bytes);
		let text = buffer.toString('utf8');
		let cut = bytes < info.size;
		if (text.length > maxCharacters) {
			text = text.slice(-maxCharacters);
			cut = true;
		}
		const newline = cut ? text.indexOf('\n') : -1;
		return newline === -1 || newline === text.length - 1
			? text
			: text.slice(newline + 1);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
		throw error;
	} finally {
		await handle?.close();
	}
}

export function createMetroSupervisor({
	runCommand = runSimulatorCommand,
	spawnProcess = spawn,
	probe = fetch,
	environment = process.env,
}: {
	/** The bounded runner `ps` and `lsof` go through. */
	runCommand?: CommandRunner;
	spawnProcess?: MetroSpawn;
	probe?: PackagerProbe;
	/** What a lane's Metro inherits before stripping: the desktop's own env. */
	environment?: NodeJS.ProcessEnv;
} = {}): MetroSupervisorPort {
	return {
		isPortFree,
		start: (input) => startMetro(input, spawnProcess, environment),
		isHealthy: (port, pid) => isMetroHealthy(port, pid, probe, runCommand),
		isProcessRunning,
		stop: (pid, port) => stopMetro(pid, port, runCommand),
		readLogTail,
	};
}

export const metroSupervisor: MetroSupervisorPort = createMetroSupervisor();
