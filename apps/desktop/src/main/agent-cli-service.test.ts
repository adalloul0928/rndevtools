import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	type AgentCliResponse,
	RNDEVTOOLS_AGENT_CLI_PROTOCOL,
} from '../shared/agent-cli-protocol';
import { AgentCliError, AgentCliService } from './agent-cli-service';

const LANE_ID = 'lane-11111111-2222-4333-8444-555555555555';

const temporaryDirectories: string[] = [];
const services: AgentCliService[] = [];

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.stop()));
	const { rm } = await import('node:fs/promises');
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	);
});

async function fixture(
	handler: ConstructorParameters<typeof AgentCliService>[0]['handler'] = async (
		command
	) => ({ command })
): Promise<{ service: AgentCliService; socketPath: string }> {
	const directory = await mkdtemp(path.join(tmpdir(), 'rndevtools-agent-cli-'));
	temporaryDirectories.push(directory);
	const socketPath = path.join(directory, 'agent', 'rndevtools.sock');
	const service = new AgentCliService({
		socketPath,
		handler,
		platform: 'darwin',
	});
	services.push(service);
	expect(await service.start()).toMatchObject({
		status: 'available',
		socketPath,
	});
	return { service, socketPath };
}

async function request(
	socketPath: string,
	body: unknown
): Promise<AgentCliResponse> {
	return await new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		const chunks: Buffer[] = [];
		socket.once('error', reject);
		socket.on('data', (chunk: Buffer) => chunks.push(chunk));
		socket.once('end', () => {
			try {
				resolve(
					JSON.parse(Buffer.concat(chunks).toString('utf8')) as AgentCliResponse
				);
			} catch (error) {
				reject(error);
			}
		});
		socket.once('connect', () => {
			socket.end(`${JSON.stringify(body)}\n`);
		});
	});
}

describe('agent CLI service', () => {
	it('creates a private Unix socket and handles one typed command', async () => {
		const { socketPath } = await fixture();
		const metadata = await stat(socketPath);
		expect(metadata.isSocket()).toBe(true);
		expect(metadata.mode & 0o777).toBe(0o600);

		const response = await request(socketPath, {
			protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
			id: 'request-1',
			command: { kind: 'simulators', includeUnavailable: false },
		});
		expect(response).toEqual({
			protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
			id: 'request-1',
			ok: true,
			result: { command: { kind: 'simulators', includeUnavailable: false } },
		});
	});

	it('rejects malformed and non-allowlisted commands without calling the handler', async () => {
		let calls = 0;
		const { socketPath } = await fixture(async () => {
			calls += 1;
			return {};
		});
		const response = await request(socketPath, {
			protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
			id: 'request-2',
			command: { kind: 'shell', command: 'whoami' },
		});
		expect(response).toMatchObject({
			ok: false,
			error: { code: 'invalid_request', retryable: false },
		});
		expect(calls).toBe(0);
	});

	it('rejects a delayed trailing frame before executing the first command', async () => {
		let calls = 0;
		const { socketPath } = await fixture(async () => {
			calls += 1;
			return {};
		});
		const response = await new Promise<AgentCliResponse>((resolve, reject) => {
			const socket = connect(socketPath);
			const chunks: Buffer[] = [];
			socket.once('error', reject);
			socket.on('data', (chunk: Buffer) => chunks.push(chunk));
			socket.once('end', () => {
				try {
					resolve(
						JSON.parse(
							Buffer.concat(chunks).toString('utf8')
						) as AgentCliResponse
					);
				} catch (error) {
					reject(error);
				}
			});
			socket.once('connect', () => {
				socket.write(
					`${JSON.stringify({
						protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
						id: 'first-frame',
						command: { kind: 'doctor' },
					})}\n`
				);
				setTimeout(() => {
					socket.end(
						`${JSON.stringify({
							protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
							id: 'smuggled-frame',
							command: { kind: 'doctor' },
						})}\n`
					);
				}, 10);
			});
		});
		expect(response).toMatchObject({
			ok: false,
			error: { code: 'multiple_requests', retryable: false },
		});
		expect(calls).toBe(0);
	});

	it('tells an agent whose tools are out of date how to recover from an unknown command', async () => {
		const { socketPath } = await fixture();
		const response = await request(socketPath, {
			protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
			id: 'request-stale',
			command: { kind: 'backend', operation: 'up' },
		});
		expect(response).toMatchObject({
			ok: false,
			error: {
				code: 'invalid_request',
				retryable: false,
				recovery:
					'Update RN Devtools, or restart the agent session to reload the rndevtools tools.',
			},
		});
	});

	it('gives lane up, lane launch, and native 230 s, and every other command 60 s', async () => {
		let handlerMs = 0;
		let started: () => void = () => undefined;
		const { socketPath } = await fixture(async (command, context) => {
			started();
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, handlerMs);
				context.signal.addEventListener(
					'abort',
					() => {
						clearTimeout(timer);
						reject(
							new AgentCliError({
								code: 'cancelled',
								message: 'The agent request was cancelled.',
							})
						);
					},
					{ once: true }
				);
			});
			return { kind: command.kind };
		});
		// Only the handler budget is faked; the socket itself stays real.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const run = async (command: unknown, durationMs: number) => {
				handlerMs = durationMs;
				const handlerStarted = new Promise<void>((resolve) => {
					started = resolve;
				});
				const response = request(socketPath, {
					protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
					id: 'request-slow',
					command,
				});
				await handlerStarted;
				await vi.advanceTimersByTimeAsync(durationMs);
				return await response;
			};
			const laneUp = {
				kind: 'lane',
				operation: 'up',
				worktreePath: '/Users/dev/app',
			};
			for (const command of [
				laneUp,
				{ kind: 'lane', operation: 'launch', laneId: LANE_ID },
				{ kind: 'native', operation: 'plan', worktreePath: '/Users/dev/app' },
			]) {
				expect(await run(command, 90_000)).toMatchObject({ ok: true });
			}
			expect(await run(laneUp, 229_000)).toMatchObject({ ok: true });
			expect(await run(laneUp, 231_000)).toMatchObject({
				ok: false,
				error: { code: 'cancelled' },
			});
			for (const command of [
				{ kind: 'doctor' },
				{ kind: 'lane', operation: 'down', laneId: LANE_ID },
			]) {
				expect(await run(command, 61_000)).toMatchObject({
					ok: false,
					error: { code: 'cancelled' },
				});
				expect(await run(command, 59_000)).toMatchObject({ ok: true });
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it('gives supabase up its wait plus 10 s, reads 30 s, destroy and down 40 s, and reset 60 s', async () => {
		let handlerMs = 0;
		let started: () => void = () => undefined;
		const { socketPath } = await fixture(async (command, context) => {
			started();
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, handlerMs);
				context.signal.addEventListener(
					'abort',
					() => {
						clearTimeout(timer);
						reject(
							new AgentCliError({
								code: 'cancelled',
								message: 'The agent request was cancelled.',
							})
						);
					},
					{ once: true }
				);
			});
			return { kind: command.kind };
		});
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const run = async (command: unknown, durationMs: number) => {
				handlerMs = durationMs;
				const handlerStarted = new Promise<void>((resolve) => {
					started = resolve;
				});
				const response = request(socketPath, {
					protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
					id: 'request-supabase',
					command,
				});
				await handlerStarted;
				await vi.advanceTimersByTimeAsync(durationMs);
				return await response;
			};
			const worktreePath = '/Users/dev/example-app';
			const budgets: Array<[Record<string, unknown>, number]> = [
				[{ operation: 'up', worktreePath }, 40_000],
				[{ operation: 'up', worktreePath, waitMs: 45_000 }, 55_000],
				[{ operation: 'up', worktreePath, waitMs: 0 }, 10_000],
				[{ operation: 'ls' }, 30_000],
				[{ operation: 'status', worktreePath }, 30_000],
				[{ operation: 'env', worktreePath }, 30_000],
				[{ operation: 'log', worktreePath, tail: 50 }, 30_000],
				[{ operation: 'reset', worktreePath }, 60_000],
				// Inside the Go CLI's 45 s deadline for both.
				[{ operation: 'destroy', worktreePath }, 40_000],
				[{ operation: 'down', worktreePath }, 40_000],
			];
			for (const [fields, budgetMs] of budgets) {
				const command = { kind: 'supabase', ...fields };
				expect(await run(command, budgetMs - 1_000)).toMatchObject({
					ok: true,
				});
				expect(await run(command, budgetMs + 1_000)).toMatchObject({
					ok: false,
					error: { code: 'cancelled' },
				});
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it('returns bounded typed handler errors without leaking query values', async () => {
		const { socketPath } = await fixture(async () => {
			throw new AgentCliError({
				code: 'approval_required',
				message:
					'Approval is required for https://example.com/path?token=secret',
				recovery: 'Approve the exact action in the desktop app.',
			});
		});
		const response = await request(socketPath, {
			protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
			id: 'request-3',
			command: { kind: 'doctor' },
		});
		expect(response).toMatchObject({
			ok: false,
			error: { code: 'approval_required', retryable: false },
		});
		expect(JSON.stringify(response)).not.toContain('secret');
	});

	it('replaces only stale sockets and refuses a file or symbolic link', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'rndevtools-agent-path-')
		);
		temporaryDirectories.push(directory);
		const socketDirectory = path.join(directory, 'agent');
		const { mkdir } = await import('node:fs/promises');
		await mkdir(socketDirectory);
		const filePath = path.join(socketDirectory, 'rndevtools.sock');
		await writeFile(filePath, 'do not replace');
		const fileService = new AgentCliService({
			socketPath: filePath,
			handler: async () => ({}),
			platform: 'darwin',
		});
		services.push(fileService);
		expect(await fileService.start()).toMatchObject({ status: 'unavailable' });
		expect(await readFile(filePath, 'utf8')).toBe('do not replace');

		const linkPath = path.join(socketDirectory, 'linked.sock');
		await symlink(filePath, linkPath);
		const linkService = new AgentCliService({
			socketPath: linkPath,
			handler: async () => ({}),
			platform: 'darwin',
		});
		services.push(linkService);
		expect(await linkService.start()).toMatchObject({ status: 'unavailable' });
	});

	it('caps serialized command results', async () => {
		const { socketPath } = await fixture(async () => ({
			value: 'x'.repeat(600_000),
		}));
		const response = await request(socketPath, {
			protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
			id: 'request-4',
			command: { kind: 'doctor' },
		});
		expect(response).toMatchObject({
			ok: false,
			error: { code: 'response_too_large', retryable: false },
		});
	});

	it('reports an unsupported state without creating a socket off macOS', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'rndevtools-agent-linux-')
		);
		temporaryDirectories.push(directory);
		const socketPath = path.join(directory, 'rndevtools.sock');
		const service = new AgentCliService({
			socketPath,
			handler: async () => ({}),
			platform: 'linux',
		});
		services.push(service);
		expect(await service.start()).toMatchObject({ status: 'unavailable' });
		await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('does not publish a socket when packaged CLI verification fails', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'rndevtools-agent-untrusted-')
		);
		temporaryDirectories.push(directory);
		const socketPath = path.join(directory, 'agent', 'rndevtools.sock');
		const service = new AgentCliService({
			socketPath,
			handler: async () => ({}),
			platform: 'darwin',
			readiness: async () => {
				throw new Error('Bundled CLI failed trust verification.');
			},
		});
		services.push(service);
		expect(await service.start()).toMatchObject({
			status: 'unavailable',
			error: 'Bundled CLI failed trust verification.',
		});
		await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
	});
});
