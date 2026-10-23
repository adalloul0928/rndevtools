import { type SpawnOptions, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import {
	MAX_METRO_ENV_VALUE_LENGTH,
	METRO_ENV_NAME,
} from '../shared/lane-protocol';
import { resolveToolPath, type ToolPathResolver } from './lane-tool-path';
import { runSimulatorCommand } from './simulator-command-runner';

const METRO_PROBE_TIMEOUT_MS = 750;
const METRO_LOG_TAIL_BYTES = 256 * 1024;
const LSOF_PATH = '/usr/sbin/lsof';
const OWNER_PROBE_TIMEOUT_MS = 3_000;
const OWNER_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_LANE_ENV_ENTRIES = 32;

/** Exclude desktop backend and agent variables from every lane. */
const STRIPPED_INHERITED_ENV = /^(?:EXPO_PUBLIC_|SUPABASE_|PG|RNDEVTOOLS_)/;

/** Metro exposes these values to app.config.js and the bundle; refuse credentials. */
const SECRET_ENV_NAME =
	/(?:SECRET|SERVICE_ROLE|PASSWORD|PASSWD|PRIVATE_KEY|ROOT_KEY|DB_URL|DATABASE_URL)/;
const SECRET_ENV_VALUE = /sb_secret_|:\/\/[^/\s:@]+:[^/\s@]+@/;

export type MetroLaunchInput = {
	worktreePath: string;
	port: number;
	logPath: string;
	/** Environment selected in JavaScript; never changes the native build. */
	metroEnv?: Readonly<Record<string, string>>;
	/** Launch-only overrides; never persist these potentially sensitive values. */
	laneEnv?: Readonly<Record<string, string>>;
	maxWorkers?: number;
};

export type MetroSupervisorPort = {
	isPortFree: (port: number) => Promise<boolean>;
	start: (input: MetroLaunchInput) => Promise<number>;
	isHealthy: (port: number, pid: number) => Promise<boolean>;
	isProcessRunning: (pid: number) => boolean;
	/** Signal only a verified Metro for this port and app directory; otherwise throw. */
	stop: (pid: number, port: number, appDirectory: string) => Promise<void>;
	readLogTail: (logPath: string, maxCharacters: number) => Promise<string>;
};

/** The recorded PID belongs to another process; nothing was signalled. */
export class NotLaneMetroError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NotLaneMetroError';
	}
}

type CommandRunner = typeof runSimulatorCommand;

type MetroChild = {
	readonly pid?: number | undefined;
	unref: () => void;
	once: (event: 'spawn', listener: () => void) => unknown;
	on: (event: 'error', listener: (error: Error) => void) => unknown;
};

type MetroSpawn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions
) => MetroChild;

type PackagerProbe = (
	url: string,
	init: { signal: AbortSignal }
) => Promise<{ ok: boolean; text: () => Promise<string> }>;

/** Match the command and port here; verify the working directory before signalling. */
export function isLaneMetroCommand(commandLine: string, port: number): boolean {
	if (!/\b(expo|metro)\b/i.test(commandLine)) return false;
	const match = /(?:^|\s)--port(?:=|\s+)(\d+)(?:\s|$)/.exec(commandLine);
	return match !== null && Number(match[1]) === port;
}

/** Search upward for a hoisted Expo CLI, never a global installation. */
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

/** Return a refusal without echoing values or malformed variable names. */
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

function checkedLaneEnv(
	laneEnv: Readonly<Record<string, string>> | undefined
): Record<string, string> {
	const problem = laneEnvProblem(laneEnv);
	if (problem) throw new Error(problem);
	return Object.fromEntries(Object.entries(laneEnv ?? {}));
}

/** Lane values override inherited values; fixed keys win and CI is always omitted. */
function metroEnvironment(
	inherited: NodeJS.ProcessEnv,
	input: MetroLaunchInput,
	laneEnv: Record<string, string>,
	toolPath: string | undefined
): NodeJS.ProcessEnv {
	const base: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(inherited)) {
		if (value !== undefined && !STRIPPED_INHERITED_ENV.test(name)) {
			base[name] = value;
		}
	}
	if (toolPath !== undefined) base.PATH = toolPath;
	const environment: NodeJS.ProcessEnv = {
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
		// `--localhost` binds whatever "localhost" resolves to; Node's verbatim
		// DNS order picks [::1] on macOS while the dev client rewrites its
		// packager host to 127.0.0.1. Force IPv4 so the app can actually reach
		// its own Metro.
		NODE_OPTIONS: [inherited.NODE_OPTIONS, '--dns-result-order=ipv4first']
			.filter(Boolean)
			.join(' '),
	};
	// Expo's CI mode disables Metro watchers and Fast Refresh. Detached stdio
	// and the noninteractive flags keep this a background development server.
	delete environment.CI;
	return environment;
}

/** Keep the error listener after spawn: detached Metro has no other child owner. */
function spawned(child: MetroChild): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once('spawn', () => resolve());
		child.on('error', reject);
	});
}

/** Detached Metro survives desktop restarts and writes to the lane log. */
async function startMetro(
	input: MetroLaunchInput,
	spawnProcess: MetroSpawn,
	inherited: NodeJS.ProcessEnv,
	toolPath: ToolPathResolver
): Promise<number> {
	const expoBinary = resolveExpoBinary(input.worktreePath);
	if (!expoBinary) {
		throw new Error(
			`Expo CLI was not found under ${input.worktreePath}/node_modules. Install dependencies in the worktree first.`
		);
	}
	// Refuse a bad laneEnv before the log is created or anything spawns.
	const laneEnv = checkedLaneEnv(input.laneEnv);
	const env = metroEnvironment(
		inherited,
		input,
		laneEnv,
		await toolPath(inherited.PATH)
	);
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
		try {
			await spawned(child);
		} catch (error) {
			throw new Error(`Metro could not start: ${(error as Error).message}`, {
				cause: error,
			});
		}
		if (!child.pid) throw new Error('Metro did not return a process id.');
		return child.pid;
	} finally {
		closeSync(log);
	}
}

/** Expo may bind either loopback family. */
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

/** A responding packager is insufficient: the lane PID must own its socket. */
async function isMetroHealthy(
	port: number,
	pid: number,
	probe: PackagerProbe,
	runCommand: CommandRunner
): Promise<boolean> {
	if (!(await packagerAnswers(port, probe))) return false;
	return listensOn(pid, port, runCommand);
}

type DirectoryIdentity = { device: bigint; inode: bigint };

type ProcessCwd = {
	/** Path in lsof escapes; compare with printsPath. */
	printed: string;
	identity: DirectoryIdentity | undefined;
};

/** lsof emits fields in p/f/D/i/n order regardless of the -F argument order. */
const LSOF_CWD_REPORT =
	/^p(\d+)\nfcwd\n(?:D0x([0-9a-f]{1,8})\n)?(?:i(\d{1,20})\n)?n([^\n]+)\n$/;

/** C locale escapes every non-ASCII byte, avoiding ambiguous legacy-locale output. */
async function processCwd(
	pid: number,
	runCommand: CommandRunner
): Promise<ProcessCwd> {
	const result = await runCommand(
		LSOF_PATH,
		['-a', '-p', String(pid), '-d', 'cwd', '-FDin'],
		{
			timeoutMs: OWNER_PROBE_TIMEOUT_MS,
			maxOutputBytes: OWNER_PROBE_MAX_OUTPUT_BYTES,
			environment: { LC_ALL: 'C' },
		}
	);
	const [, reported, device, inode, printed] =
		LSOF_CWD_REPORT.exec(result.stdout) ?? [];
	if (reported !== String(pid) || printed === undefined) {
		throw new Error(`lsof reported no working directory for process ${pid}.`);
	}
	return {
		printed,
		identity:
			device === undefined || inode === undefined
				? undefined
				: { device: BigInt(`0x${device}`), inode: BigInt(inode) },
	};
}

const LSOF_CONTROL_ESCAPES: ReadonlyMap<number, string> = new Map([
	[0x08, '\\b'],
	[0x09, '\\t'],
	[0x0a, '\\n'],
	[0x0c, '\\f'],
	[0x0d, '\\r'],
]);

/** Match lsof C-locale escapes; UTF-8 paths cannot contain its special 0xff byte. */
function lsofPrintedByte(byte: number): string {
	if (byte === 0x5c) return '\\\\';
	if (byte >= 0x20 && byte < 0x7f) return String.fromCharCode(byte);
	const control = LSOF_CONTROL_ESCAPES.get(byte);
	if (control !== undefined) return control;
	if (byte < 0x20) return `^${String.fromCharCode(byte | 0x40)}`;
	return `\\x${byte.toString(16).padStart(2, '0')}`;
}

/** Compare against a candidate: lsof renders both a literal ^A and byte 0x01 as ^A. */
function printsPath(printed: string, candidate: string): boolean {
	let at = 0;
	for (const character of candidate) {
		// Every escape is ASCII, so a non-ASCII character printed as it is
		// cannot be part of one.
		if (
			(character.codePointAt(0) ?? 0) > 0x7f &&
			printed.startsWith(character, at)
		) {
			at += character.length;
			continue;
		}
		for (const byte of Buffer.from(character, 'utf8')) {
			const expected = lsofPrintedByte(byte);
			if (!printed.startsWith(expected, at)) return false;
			at += expected.length;
		}
	}
	return at === printed.length;
}

/** Reject incomplete UTF-8 and preserve BOMs so distinct paths stay distinct. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Invisible and directional characters can make distinct paths look identical. */
const UNSAFE_IN_MESSAGE =
	/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** Decode readable UTF-8; keep controls and ambiguous escapes visible. */
function readableLsofPath(printed: string): string {
	return printed.replace(
		/\\\\|\^\\(?=(?:\\\\)*\\x[89a-f][0-9a-f])|(?:\\x[89a-f][0-9a-f])+|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu,
		(match) => {
			if (match === '\\\\' || match === '^\\') return match;
			if (!match.startsWith('\\x')) {
				return Array.from(Buffer.from(match, 'utf8'), lsofPrintedByte).join('');
			}
			try {
				const decoded = UTF8.decode(
					Buffer.from(match.replaceAll('\\x', ''), 'hex')
				);
				return UNSAFE_IN_MESSAGE.test(decoded) ? match : decoded;
			} catch {
				return match;
			}
		}
	);
}

/** Use the same escapes for expected and observed paths in error messages. */
function readablePath(directory: string): string {
	return readableLsofPath(
		Array.from(Buffer.from(directory, 'utf8'), lsofPrintedByte).join('')
	);
}

/** Compare kernel identity across symlinks, case and Unicode; dev_t is unsigned 32-bit. */
async function directoryIdentity(
	directory: string
): Promise<DirectoryIdentity | undefined> {
	try {
		const { dev, ino } = await stat(directory, { bigint: true });
		return { device: BigInt.asUintN(32, dev), inode: BigInt.asUintN(64, ino) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

/** Caret escapes are ambiguous with literal carets; a doubled backslash can be too. */
const LSOF_CARET_ESCAPE = /\^[A-GKN-Z[\\\]^_]/;

/** Prefer device/inode identity. Only a deleted directory permits an unambiguous path fallback. */
async function isAppDirectory(
	cwd: ProcessCwd,
	appDirectory: string
): Promise<boolean> {
	const resolved = path.resolve(appDirectory);
	const identity = await directoryIdentity(resolved);
	if (identity === undefined) {
		if (!printsPath(cwd.printed, resolved)) return false;
		if (LSOF_CARET_ESCAPE.test(cwd.printed)) {
			throw new Error(
				"the app directory is gone, and the path lsof printed could be another directory's: lsof prints a control byte as a caret and a letter or sign."
			);
		}
		return true;
	}
	if (cwd.identity === undefined) {
		throw new Error(
			'lsof printed no device and inode for its working directory.'
		);
	}
	return (
		cwd.identity.device === identity.device &&
		cwd.identity.inode === identity.inode
	);
}

async function readsAsAppDirectory(
	printed: string,
	appDirectory: string
): Promise<boolean> {
	const resolved = path.resolve(appDirectory);
	if (printsPath(printed, resolved)) return true;
	try {
		return printsPath(printed, await realpath(resolved));
	} catch {
		return false;
	}
}

/** Verify command, port and directory before signalling: PIDs can be reused. */
async function stopMetro(
	pid: number,
	port: number,
	appDirectory: string,
	runCommand: CommandRunner
): Promise<void> {
	if (!isProcessRunning(pid)) return;
	let cwd: ProcessCwd | undefined;
	let servesHere = false;
	try {
		const result = await runCommand(
			'/bin/ps',
			['-p', String(pid), '-o', 'command='],
			{ timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }
		);
		if (isLaneMetroCommand(result.stdout, port)) {
			cwd = await processCwd(pid, runCommand);
			servesHere = await isAppDirectory(cwd, appDirectory);
		}
	} catch (error) {
		// A process that exited while it was inspected has nothing to stop.
		if (!isProcessRunning(pid)) return;
		// Otherwise the PID cannot be proven to be ours. Fail closed and say
		// so: the lane keeps its lease and the operator can stop Metro by hand.
		throw new Error(
			`Could not inspect process ${pid} to confirm it is this lane's Metro (${(error as Error).message}); refusing to stop it. Stop the Metro on port ${port} manually, then stop the lane again.`
		);
	}
	if (cwd === undefined) {
		throw new NotLaneMetroError(
			`Process ${pid} is no longer the Metro serving port ${port}; refusing to stop it.`
		);
	}
	if (!servesHere) {
		// Not proof the lane's Metro is gone, so the lane keeps its lease.
		const lanePath = readablePath(appDirectory);
		throw new Error(
			(await readsAsAppDirectory(cwd.printed, appDirectory))
				? `Process ${pid} is an Expo or Metro on port ${port} serving from another directory than this lane's ${lanePath}, though lsof prints its path the same; refusing to stop it. If the app directory was recreated, it is likely this lane's Metro: stop it manually, then stop the lane again.`
				: `Process ${pid} is an Expo or Metro on port ${port} serving from ${readableLsofPath(cwd.printed)}, not from this lane's ${lanePath}; refusing to stop it. If the worktree was moved or renamed, it is likely this lane's Metro: stop it manually, then stop the lane again.`
		);
	}
	try {
		process.kill(-pid, 'SIGTERM');
	} catch {
		process.kill(pid, 'SIGTERM');
	}
}

/** Skip a partial first line so redaction sees complete secret names. */
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
	toolPath = resolveToolPath,
}: {
	runCommand?: CommandRunner;
	spawnProcess?: MetroSpawn;
	probe?: PackagerProbe;
	environment?: NodeJS.ProcessEnv;
	toolPath?: ToolPathResolver;
} = {}): MetroSupervisorPort {
	return {
		isPortFree,
		start: (input) => startMetro(input, spawnProcess, environment, toolPath),
		isHealthy: (port, pid) => isMetroHealthy(port, pid, probe, runCommand),
		isProcessRunning,
		stop: (pid, port, appDirectory) =>
			stopMetro(pid, port, appDirectory, runCommand),
		readLogTail,
	};
}

export const metroSupervisor: MetroSupervisorPort = createMetroSupervisor();
