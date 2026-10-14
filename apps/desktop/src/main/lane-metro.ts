import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { runSimulatorCommand } from './simulator-command-runner';

const METRO_PROBE_TIMEOUT_MS = 750;
const METRO_LOG_TAIL_BYTES = 256 * 1024;

export type MetroLaunchInput = {
	worktreePath: string;
	port: number;
	logPath: string;
	/** Environment selected in JavaScript; never changes the native build. */
	metroEnv?: Readonly<Record<string, string>>;
	maxWorkers?: number;
};

export type MetroSupervisorPort = {
	isPortFree: (port: number) => Promise<boolean>;
	start: (input: MetroLaunchInput) => Promise<number>;
	isHealthy: (port: number) => Promise<boolean>;
	isProcessRunning: (pid: number) => boolean;
	/** Stops the Metro at `pid` only if it is the one serving `port`. */
	stop: (pid: number, port: number) => Promise<void>;
	readLogTail: (logPath: string, maxCharacters: number) => Promise<string>;
};

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
 * Metro is detached so it survives the desktop app and so one lane's crash
 * cannot take down the main process. Its output goes to a per-lane log file
 * that the renderer and the agent CLI can tail.
 */
async function startMetro(input: MetroLaunchInput): Promise<number> {
	const expoBinary = resolveExpoBinary(input.worktreePath);
	if (!expoBinary) {
		throw new Error(
			`Expo CLI was not found under ${input.worktreePath}/node_modules. Install dependencies in the worktree first.`
		);
	}
	const log = openSync(input.logPath, 'a', 0o600);
	try {
		const child = spawn(
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
				env: {
					...process.env,
					...input.metroEnv,
					NODE_ENV: 'development',
					RCT_METRO_PORT: String(input.port),
					EXPO_NO_DOTENV: '1',
					EXPO_NO_INTERACTIVE: '1',
					// Every launch URL and QR code the CLI emits gets the
					// automation parameters, so agents see the app rather than
					// the launcher sheet.
					EXPO_NO_DEV_MENU: '1',
					CI: '1',
					// `--localhost` binds whatever "localhost" resolves to; Node's
					// verbatim DNS order picks [::1] on macOS while the dev client
					// rewrites its packager host to 127.0.0.1. Force IPv4 so the
					// app can actually reach its own Metro.
					NODE_OPTIONS: [
						process.env.NODE_OPTIONS,
						'--dns-result-order=ipv4first',
					]
						.filter(Boolean)
						.join(' '),
				},
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
async function isMetroHealthy(port: number): Promise<boolean> {
	for (const host of ['127.0.0.1', 'localhost'] as const) {
		try {
			const response = await fetch(`http://${host}:${port}/status`, {
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
 * Stops only a Metro this lane owns. PIDs are recycled, so before signalling
 * the process group the command line must still name the worktree and Expo.
 */
async function stopMetro(pid: number, port: number): Promise<void> {
	if (!isProcessRunning(pid)) return;
	let commandLine: string | undefined;
	try {
		const result = await runSimulatorCommand(
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
		const text = buffer.toString('utf8');
		return text.length > maxCharacters ? text.slice(-maxCharacters) : text;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
		throw error;
	} finally {
		await handle?.close();
	}
}

export const metroSupervisor: MetroSupervisorPort = {
	isPortFree,
	start: startMetro,
	isHealthy: isMetroHealthy,
	isProcessRunning,
	stop: stopMetro,
	readLogTail,
};
