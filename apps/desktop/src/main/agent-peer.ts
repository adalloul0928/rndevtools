import type { Socket } from 'node:net';
import {
	runSimulatorCommand,
	SimulatorCommandError,
} from './simulator-command-runner';

/**
 * Who is at the other end of an agent socket connection.
 *
 * The CLI names its own pid in every request. A pid is cheap to assert, so
 * the desktop proves that it owns the connection before trusting it. macOS
 * lsof lists every Unix socket of a process with the socket's kernel address
 * (its `d` field) and, for a connected socket, the address of its peer (the
 * `n` field, as `->0x…`). One lsof call over the desktop and the named pid
 * therefore shows the accepted socket's address and whether some socket of
 * that pid points at it. Anything else (no lsof, a slow one, output that
 * does not match) proves nothing: the check never fails open.
 *
 * A proven pid is then mapped to the agent session that spawned it through
 * its ancestry: the process table from ps, walked parent by parent.
 */

const LSOF = '/usr/sbin/lsof';
const PS = '/bin/ps';
const LSOF_TIMEOUT_MS = 5_000;
const LSOF_MAX_OUTPUT_BYTES = 1024 * 1024;
const PS_TIMEOUT_MS = 5_000;
const PS_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Hops up the process tree: more than any shell nesting reaches. */
const MAX_ANCESTRY_HOPS = 64;

export type UnixSocketRecord = {
	pid: number;
	fd: number;
	/** The socket's kernel address, as lsof prints it (`0x…`), lowercase. */
	address: string;
	/** The socket's name: its path, or `->0x…` naming its connected peer. */
	name: string;
};

/**
 * Parses `lsof -F pfdn` output over Unix sockets into one record per socket.
 * Each field is on its own line: `p` starts a process, `f` a file, and `d`
 * and `n` belong to the `f` before them. A file that lacks a numeric
 * descriptor, an address or a name yields no record, and a line of any other
 * shape is ignored: a record exists only where every part is there, and the
 * proof needs a positive match on records, so garbage proves nothing.
 */
export function parseUnixSocketRecords(stdout: string): UnixSocketRecord[] {
	const records: UnixSocketRecord[] = [];
	let pid: number | undefined;
	let fd: number | undefined;
	let address: string | undefined;
	let name: string | undefined;
	const flush = () => {
		if (
			pid !== undefined &&
			fd !== undefined &&
			address !== undefined &&
			name !== undefined
		) {
			records.push({ pid, fd, address, name });
		}
		fd = undefined;
		address = undefined;
		name = undefined;
	};
	for (const line of stdout.split('\n')) {
		const value = line.slice(1);
		switch (line.charAt(0)) {
			case 'p':
				flush();
				pid = /^\d{1,10}$/.test(value) ? Number(value) : undefined;
				break;
			case 'f':
				flush();
				fd = /^\d{1,10}$/.test(value) ? Number(value) : undefined;
				break;
			case 'd':
				address = /^0x[0-9a-f]{1,32}$/i.test(value)
					? value.toLowerCase()
					: undefined;
				break;
			case 'n':
				name = value;
				break;
			default:
				break;
		}
	}
	flush();
	return records;
}

/**
 * Whether, by `records`, `peerPid` holds the other end of the desktop's
 * descriptor `fd`: the desktop's socket has an address, and a socket of the
 * peer names exactly that address as its peer. The desktop never connects to
 * itself, so its own pid is no peer.
 */
export function peerHoldsConnection(
	records: readonly UnixSocketRecord[],
	{ selfPid, fd, peerPid }: { selfPid: number; fd: number; peerPid: number }
): boolean {
	if (peerPid === selfPid) return false;
	const own = records.find(
		(record) => record.pid === selfPid && record.fd === fd
	);
	if (!own) return false;
	const peerName = `->${own.address}`;
	return records.some(
		(record) => record.pid === peerPid && record.name.toLowerCase() === peerName
	);
}

/** lsof's Unix sockets of `pids`, or undefined when lsof could not say. */
async function lsofUnixSockets(
	pids: readonly number[]
): Promise<string | undefined> {
	try {
		const result = await runSimulatorCommand(
			LSOF,
			[
				'-n',
				'-P',
				'-l',
				'-b',
				'-w',
				'-a',
				'-p',
				pids.join(','),
				'-U',
				'-F',
				'pfdn',
			],
			{
				timeoutMs: LSOF_TIMEOUT_MS,
				maxOutputBytes: LSOF_MAX_OUTPUT_BYTES,
				forceKillDelayMs: 1_000,
			}
		);
		return result.stdout;
	} catch (error) {
		// lsof exits 1 when one of the pids is gone or holds no Unix socket,
		// and still lists the others; with -w any stderr alongside means a
		// real failure, which proves nothing.
		if (
			error instanceof SimulatorCommandError &&
			error.kind === 'failed' &&
			error.exitCode === 1 &&
			error.stderr.trim() === ''
		) {
			return error.stdout;
		}
		return undefined;
	}
}

/**
 * Whether `peerPid` owns the client end of `socket`, a connection the
 * desktop (`selfPid`) accepted. Proven through lsof, see above; a socket
 * whose descriptor Node does not expose cannot be proven.
 */
export async function peerOwnsConnection(
	socket: Socket,
	peerPid: number,
	{
		selfPid = process.pid,
		lsof = lsofUnixSockets,
	}: {
		selfPid?: number;
		/** Runs lsof over these pids; tests inject its output. */
		lsof?: (pids: readonly number[]) => Promise<string | undefined>;
	} = {}
): Promise<boolean> {
	const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
	if (
		fd === undefined ||
		!Number.isInteger(fd) ||
		fd < 0 ||
		!Number.isInteger(peerPid) ||
		peerPid <= 0 ||
		peerPid === selfPid
	) {
		return false;
	}
	const stdout = await lsof([selfPid, peerPid]);
	if (stdout === undefined) return false;
	return peerHoldsConnection(parseUnixSocketRecords(stdout), {
		selfPid,
		fd,
		peerPid,
	});
}

export type ProcessTableEntry = {
	pid: number;
	ppid: number;
};

/** Reads the live process table; the agent service's injectable reader. */
export type ProcessTableReader = () => Promise<readonly ProcessTableEntry[]>;

/**
 * Parses `ps -axo pid=,ppid=` output: two numbers per line. A line of another
 * shape is skipped.
 */
export function parseProcessTable(stdout: string): ProcessTableEntry[] {
	const entries: ProcessTableEntry[] = [];
	for (const line of stdout.split('\n')) {
		const match = /^\s*(\d{1,10})\s+(\d{1,10})\s*$/.exec(line);
		if (match) entries.push({ pid: Number(match[1]), ppid: Number(match[2]) });
	}
	return entries;
}

/**
 * The process table from ps, within a timeout; throws when ps fails. Only the
 * parent column is asked for: the executable's name costs ps a lookup per
 * process, which on a busy Mac more than doubles the time it takes, and
 * nothing here reads it.
 */
export async function readProcessTable(): Promise<ProcessTableEntry[]> {
	const result = await runSimulatorCommand(PS, ['-axo', 'pid=,ppid='], {
		timeoutMs: PS_TIMEOUT_MS,
		maxOutputBytes: PS_MAX_OUTPUT_BYTES,
		forceKillDelayMs: 1_000,
	});
	return parseProcessTable(result.stdout);
}

/**
 * `pid` and its ancestors, nearest first, as far as the table knows them:
 * at most MAX_ANCESTRY_HOPS of them, never through a cycle, and never pid 0.
 * A pid the table does not hold is still its own ancestry, so a process that
 * exited since the table was read can still be matched by itself.
 */
export function processAncestry(
	table: readonly ProcessTableEntry[],
	pid: number
): number[] {
	const parents = new Map(table.map((entry) => [entry.pid, entry.ppid]));
	const ancestry: number[] = [];
	const seen = new Set<number>();
	let current: number | undefined = pid;
	while (
		current !== undefined &&
		current > 0 &&
		!seen.has(current) &&
		ancestry.length < MAX_ANCESTRY_HOPS
	) {
		seen.add(current);
		ancestry.push(current);
		current = parents.get(current);
	}
	return ancestry;
}
