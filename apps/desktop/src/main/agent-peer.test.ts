import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	parseProcessTable,
	parseUnixSocketRecords,
	peerHoldsConnection,
	peerOwnsConnection,
	processAncestry,
	readProcessTable,
} from './agent-peer';

const DESKTOP = 80_938;
const CLI = 80_948;

/**
 * What `lsof -n -P -l -b -w -a -p <desktop>,<cli> -U -F pfdn` prints on
 * macOS: the desktop's accepted socket (descriptor 13) carries the address
 * of the connection in `d` and the listening path in `n`, and the CLI's end
 * (descriptor 12) names that address as its peer.
 */
const PAIRED = [
	`p${DESKTOP}`,
	'f12',
	'd0xe13c033095cb4468',
	'n/Users/dev/Library/Application Support/RN Devtools/agent/rndevtools.sock',
	'f13',
	'd0x9aaa12d1d309c084',
	'n/Users/dev/Library/Application Support/RN Devtools/agent/rndevtools.sock',
	'f14',
	'd0x5fa4617cf5953e45',
	'n->0x2342acec047b8d06',
	`p${CLI}`,
	'f0',
	'd0x2098cbb8b7eaa61a',
	'n->0xee18fba358fd2d5e',
	'f12',
	'd0x2098cbb8b7eaa61b',
	'n->0x9aaa12d1d309c084',
	'',
].join('\n');

/** The same, but the CLI's socket points at some other connection. */
const ELSEWHERE = PAIRED.replace(
	'n->0x9aaa12d1d309c084',
	'n->0x1111111111111111'
);

function socketWithFd(fd: number | undefined): Socket {
	return { _handle: fd === undefined ? {} : { fd } } as unknown as Socket;
}

describe('parseUnixSocketRecords', () => {
	it('reads one record per socket, with the process, descriptor, address and name', () => {
		const records = parseUnixSocketRecords(PAIRED);
		expect(records).toHaveLength(5);
		expect(records[1]).toEqual({
			pid: DESKTOP,
			fd: 13,
			address: '0x9aaa12d1d309c084',
			name: '/Users/dev/Library/Application Support/RN Devtools/agent/rndevtools.sock',
		});
		expect(records[4]).toEqual({
			pid: CLI,
			fd: 12,
			address: '0x2098cbb8b7eaa61b',
			name: '->0x9aaa12d1d309c084',
		});
	});

	it('lowercases addresses and leaves out what is incomplete or unreadable', () => {
		const records = parseUnixSocketRecords(
			[
				`p${CLI}`,
				'f3',
				'd0xABCDEF0123456789',
				'n->0x0000000000000001',
				// No address, no name, a name only, and a descriptor that is no number.
				'f4',
				'n->0x0000000000000002',
				'f5',
				'd0x0000000000000005',
				'fcwd',
				'd0x0000000000000006',
				'n/some/path',
				'd not an address',
				'garbage',
				'',
			].join('\n')
		);
		expect(records).toEqual([
			{
				pid: CLI,
				fd: 3,
				address: '0xabcdef0123456789',
				name: '->0x0000000000000001',
			},
		]);
	});

	it('reads nothing from output with no process, from empty output, or from noise', () => {
		expect(parseUnixSocketRecords('')).toEqual([]);
		expect(parseUnixSocketRecords('f3\nd0x1\nn->0x2\n')).toEqual([]);
		expect(parseUnixSocketRecords('pnot-a-pid\nf3\nd0x1\nn->0x2\n')).toEqual(
			[]
		);
		expect(parseUnixSocketRecords('lsof: WARNING: something\n')).toEqual([]);
	});
});

describe('peerHoldsConnection', () => {
	const records = parseUnixSocketRecords(PAIRED);
	const paired = { selfPid: DESKTOP, fd: 13, peerPid: CLI };

	it('holds when a socket of the peer names the address of the desktop descriptor', () => {
		expect(peerHoldsConnection(records, paired)).toBe(true);
	});

	it('does not hold when the peer socket points at another connection', () => {
		expect(peerHoldsConnection(parseUnixSocketRecords(ELSEWHERE), paired)).toBe(
			false
		);
	});

	it('does not hold for another descriptor of the desktop, or one it does not have', () => {
		expect(peerHoldsConnection(records, { ...paired, fd: 12 })).toBe(false);
		expect(peerHoldsConnection(records, { ...paired, fd: 99 })).toBe(false);
	});

	it('does not hold for a process that is not the peer, or for the desktop itself', () => {
		expect(peerHoldsConnection(records, { ...paired, peerPid: 12_345 })).toBe(
			false
		);
		expect(peerHoldsConnection(records, { ...paired, peerPid: DESKTOP })).toBe(
			false
		);
		expect(peerHoldsConnection([], paired)).toBe(false);
	});

	it('does not take a name that merely contains the address for the peer', () => {
		const lookalike = parseUnixSocketRecords(
			PAIRED.replace(
				'n->0x9aaa12d1d309c084',
				'n/tmp/->0x9aaa12d1d309c084/socket'
			)
		);
		expect(peerHoldsConnection(lookalike, paired)).toBe(false);
	});
});

describe('peerOwnsConnection', () => {
	it('runs lsof over the desktop and the peer, and answers from its output', async () => {
		const lsof = vi.fn(async (_pids: readonly number[]) => PAIRED);
		await expect(
			peerOwnsConnection(socketWithFd(13), CLI, { selfPid: DESKTOP, lsof })
		).resolves.toBe(true);
		expect(lsof).toHaveBeenCalledWith([DESKTOP, CLI]);
		await expect(
			peerOwnsConnection(socketWithFd(13), CLI, {
				selfPid: DESKTOP,
				lsof: async () => ELSEWHERE,
			})
		).resolves.toBe(false);
	});

	it('proves nothing when lsof is missing, slow, or fails', async () => {
		await expect(
			peerOwnsConnection(socketWithFd(13), CLI, {
				selfPid: DESKTOP,
				lsof: async () => undefined,
			})
		).resolves.toBe(false);
		await expect(
			peerOwnsConnection(socketWithFd(13), CLI, {
				selfPid: DESKTOP,
				lsof: async () => '',
			})
		).resolves.toBe(false);
	});

	it('asks nothing for a socket without a descriptor, or for a pid that cannot be the peer', async () => {
		const lsof = vi.fn(async () => PAIRED);
		for (const [socket, pid] of [
			[socketWithFd(undefined), CLI],
			[socketWithFd(-1), CLI],
			[{} as Socket, CLI],
			[socketWithFd(13), DESKTOP],
			[socketWithFd(13), 0],
			[socketWithFd(13), -CLI],
			[socketWithFd(13), 1.5],
		] as const) {
			await expect(
				peerOwnsConnection(socket, pid, { selfPid: DESKTOP, lsof })
			).resolves.toBe(false);
		}
		expect(lsof).not.toHaveBeenCalled();
	});
});

describe('parseProcessTable', () => {
	it('reads pid and parent, and skips a line of any other shape', () => {
		expect(
			parseProcessTable(
				[
					'    1     0',
					'  100     1',
					'12345 100',
					'not a process line',
					'12 abc',
					'7 8 /bin/with-a-command',
					'',
				].join('\n')
			)
		).toEqual([
			{ pid: 1, ppid: 0 },
			{ pid: 100, ppid: 1 },
			{ pid: 12_345, ppid: 100 },
		]);
	});
});

describe('processAncestry', () => {
	const entry = (pid: number, ppid: number) => ({ pid, ppid });

	it('lists the pid and its ancestors, nearest first, up to launchd', () => {
		expect(
			processAncestry(
				[entry(1, 0), entry(10, 1), entry(20, 10), entry(30, 20)],
				30
			)
		).toEqual([30, 20, 10, 1]);
	});

	it('keeps a pid the table does not hold as its own ancestry', () => {
		expect(processAncestry([entry(1, 0)], 999)).toEqual([999]);
		expect(processAncestry([], 999)).toEqual([999]);
	});

	it('stops at a cycle and never yields pid 0 or less', () => {
		expect(processAncestry([entry(5, 6), entry(6, 5)], 5)).toEqual([5, 6]);
		expect(processAncestry([entry(7, 7)], 7)).toEqual([7]);
		expect(processAncestry([entry(8, 0)], 8)).toEqual([8]);
		expect(processAncestry([entry(8, 0)], 0)).toEqual([]);
	});

	it('follows at most 64 pids up a very long chain', () => {
		const chain = Array.from({ length: 200 }, (_, index) =>
			entry(index + 2, index + 1)
		);
		const ancestry = processAncestry(chain, 201);
		expect(ancestry).toHaveLength(64);
		expect(ancestry[0]).toBe(201);
		expect(ancestry[63]).toBe(138);
	});
});

describe.skipIf(process.platform !== 'darwin')('on this Mac', () => {
	const children: ChildProcess[] = [];
	const servers: Server[] = [];
	const directories: string[] = [];

	afterEach(async () => {
		for (const child of children.splice(0)) child.kill('SIGKILL');
		for (const server of servers.splice(0)) server.close();
		await Promise.all(
			directories
				.splice(0)
				.map((directory) => rm(directory, { recursive: true, force: true }))
		);
	});

	function node(script: string, ...args: string[]): ChildProcess {
		const child = spawn(process.execPath, ['-e', script, ...args], {
			stdio: 'ignore',
		});
		children.push(child);
		return child;
	}

	/** A connection a child node process makes to a server of this process. */
	async function acceptChild(): Promise<{ socket: Socket; childPid: number }> {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-peer-'));
		directories.push(directory);
		const socketPath = path.join(directory, 'peer.sock');
		const accepted = new Promise<{ socket: Socket; childPid: number }>(
			(resolve) => {
				const server = createServer({ allowHalfOpen: true }, (socket) => {
					let line = '';
					socket.on('data', (chunk: Buffer) => {
						line += chunk.toString('utf8');
						if (line.endsWith('\n')) {
							resolve({ socket, childPid: Number(line.trim()) });
						}
					});
				});
				servers.push(server);
				server.listen(socketPath, () => {
					node(
						`const socket = require('node:net').connect(process.argv[1], () => socket.write(process.pid + '\\n'));
						 socket.on('data', () => {});
						 socket.on('close', () => process.exit(0));`,
						socketPath
					);
				});
			}
		);
		return await accepted;
	}

	it('proves the process on the other end of an accepted connection, and no other', async () => {
		const { socket, childPid } = await acceptChild();
		const bystander = node('setInterval(() => {}, 1000);');
		const gone = node('');
		await new Promise((resolve) => gone.once('exit', resolve));
		const [bystanderPid, gonePid] = [bystander.pid, gone.pid];
		expect(bystanderPid).toBeGreaterThan(0);
		expect(gonePid).toBeGreaterThan(0);

		const [other, exited, self] = await Promise.all([
			peerOwnsConnection(socket, bystanderPid as number),
			peerOwnsConnection(socket, gonePid as number),
			peerOwnsConnection(socket, process.pid),
		]);
		expect(other).toBe(false);
		expect(exited).toBe(false);
		expect(self).toBe(false);
		// lsof can overrun its budget on a busy Mac, and a proof that times out
		// is a proof that fails, so the true answer is waited for.
		await vi.waitFor(
			async () => {
				expect(await peerOwnsConnection(socket, childPid)).toBe(true);
			},
			{ timeout: 30_000, interval: 100 }
		);
	}, 60_000);

	it('reads the live process table, with this process under its parent', async () => {
		const table = await readProcessTable();
		expect(table.find((entry) => entry.pid === process.pid)).toMatchObject({
			pid: process.pid,
			ppid: process.ppid,
		});
		expect(processAncestry(table, process.pid).slice(0, 2)).toEqual([
			process.pid,
			process.ppid,
		]);
	}, 20_000);
});
