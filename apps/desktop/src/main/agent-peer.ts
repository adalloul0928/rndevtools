import type { Socket } from 'node:net';
import {
	runSimulatorCommand,
	SimulatorCommandError,
} from './simulator-command-runner';

/**
 * Prove the claimed PID owns the accepted socket by matching lsof peer addresses.
 * Missing or ambiguous evidence never establishes identity.
 */

const LSOF = '/usr/sbin/lsof';
const PS = '/bin/ps';
const LSOF_TIMEOUT_MS = 5_000;
const LSOF_MAX_OUTPUT_BYTES = 1024 * 1024;
const PS_TIMEOUT_MS = 5_000;
const PS_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ANCESTRY_HOPS = 64;

export type UnixSocketRecord = {
	pid: number;
	fd: number;
	/** The socket's kernel address, as lsof prints it (`0x…`), lowercase. */
	address: string;
	/** The socket's name: its path, or `->0x…` naming its connected peer. */
	name: string;
};

/** Accept only complete lsof p/f/d/n socket records. */
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

/** The peer socket must point to the accepted desktop socket; self-connections are refused. */
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

/** A socket without an exposed descriptor cannot be proven. */
export async function peerOwnsConnection(
	socket: Socket,
	peerPid: number,
	{
		selfPid = process.pid,
		lsof = lsofUnixSockets,
	}: {
		selfPid?: number;
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
	startedAt?: string;
};

export type ProcessTableReader = () => Promise<readonly ProcessTableEntry[]>;

export function parseProcessTable(stdout: string): ProcessTableEntry[] {
	const entries: ProcessTableEntry[] = [];
	for (const line of stdout.split('\n')) {
		const match =
			/^\s*(\d{1,10})\s+(\d{1,10})\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(
				line
			);
		const startedAt = match?.[3];
		if (match && startedAt) {
			entries.push({
				pid: Number(match[1]),
				ppid: Number(match[2]),
				startedAt: startedAt.replace(/\s+/g, ' '),
			});
		}
	}
	return entries;
}

export async function readProcessTable(): Promise<ProcessTableEntry[]> {
	const result = await runSimulatorCommand(PS, ['-axo', 'pid=,ppid=,lstart='], {
		timeoutMs: PS_TIMEOUT_MS,
		maxOutputBytes: PS_MAX_OUTPUT_BYTES,
		forceKillDelayMs: 1_000,
		environment: { LC_ALL: 'C' },
	});
	return parseProcessTable(result.stdout);
}

/** Keep the sender even if it has exited; bound ancestors and stop at cycles. */
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
