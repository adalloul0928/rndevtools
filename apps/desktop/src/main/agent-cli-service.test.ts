import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { connect, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	type AgentCliResponse,
	type AgentIdentityResolution,
	RNDEVTOOLS_AGENT_CLI_PROTOCOL,
} from '../shared/agent-cli-protocol';
import {
	AgentCliError,
	type AgentCliHandlerContext,
	AgentCliService,
	identityRefusal,
} from './agent-cli-service';

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
	) => ({ command }),
	{
		livenessProbeMs,
		verifyPeer,
		identify,
	}: Pick<
		ConstructorParameters<typeof AgentCliService>[0],
		'livenessProbeMs' | 'verifyPeer' | 'identify'
	> = {}
): Promise<{ service: AgentCliService; socketPath: string }> {
	const directory = await mkdtemp(path.join(tmpdir(), 'rndevtools-agent-cli-'));
	temporaryDirectories.push(directory);
	const socketPath = path.join(directory, 'agent', 'rndevtools.sock');
	const service = new AgentCliService({
		socketPath,
		handler,
		platform: 'darwin',
		...(livenessProbeMs === undefined ? {} : { livenessProbeMs }),
		...(verifyPeer === undefined ? {} : { verifyPeer }),
		...(identify === undefined ? {} : { identify }),
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
	return JSON.parse(
		(await exchangeRaw(socketPath, body)).toString('utf8')
	) as AgentCliResponse;
}

/** Sends one request the way the Go CLI does (write, then half-close). */
async function exchangeRaw(socketPath: string, body: unknown): Promise<Buffer> {
	return await new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		const chunks: Buffer[] = [];
		socket.once('error', reject);
		socket.on('data', (chunk: Buffer) => chunks.push(chunk));
		socket.once('end', () => resolve(Buffer.concat(chunks)));
		socket.once('connect', () => {
			socket.end(`${JSON.stringify(body)}\n`);
		});
	});
}

async function within<T>(
	promise: Promise<T>,
	milliseconds: number,
	what: string
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`timed out waiting for ${what}`)),
					milliseconds
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

describe('agent CLI service', () => {
	it('answers the ninth concurrent connection with a retryable busy response', async () => {
		const releases: (() => void)[] = [];
		let occupied = () => {};
		const ready = new Promise<void>((resolve) => {
			occupied = resolve;
		});
		const { socketPath } = await fixture(async () => {
			await new Promise<void>((resolve) => {
				releases.push(resolve);
				if (releases.length === 8) occupied();
			});
			return {};
		});
		const sockets: Socket[] = [];
		try {
			for (let index = 0; index < 8; index += 1) {
				const socket = connect(socketPath);
				sockets.push(socket);
				socket.on('error', () => {});
				socket.once('connect', () =>
					socket.end(
						`${JSON.stringify({
							protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
							id: `held-${index}`,
							command: { kind: 'simulators', includeUnavailable: false },
						})}\n`
					)
				);
			}
			await within(ready, 5_000, 'eight active handlers');
			const response = await request(socketPath, {
				protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
				id: 'overflow',
				command: { kind: 'simulators', includeUnavailable: false },
			});
			expect(response).toMatchObject({
				ok: false,
				error: { code: 'server_busy', retryable: true },
			});
			expect(releases).toHaveLength(8);
		} finally {
			for (const release of releases) release();
			for (const socket of sockets) socket.destroy();
		}
	});

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

	describe('who sent a request', () => {
		const claim = { kind: 'claude', sessionId: 'claude-session-1' } as const;
		const PEER_PID = 4_242;

		function agentsRequest(extra: Record<string, unknown>) {
			return {
				protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
				id: 'request-who',
				command: { kind: 'agents' },
				...extra,
			};
		}

		/** A handler that records the context of every request it is given. */
		function recordingHandler() {
			const contexts: AgentCliHandlerContext[] = [];
			return {
				contexts,
				handler: async (_command: unknown, context: AgentCliHandlerContext) => {
					contexts.push(context);
					return { ok: true };
				},
			};
		}

		it('leaves a claim without a peer unverified and passes the handler no agent', async () => {
			const { contexts, handler } = recordingHandler();
			const { socketPath } = await fixture(handler);
			// The envelope's word is a claim: a CLI that sends no pid, as one from
			// before the desktop checked, proves nothing.
			const response = await request(
				socketPath,
				agentsRequest({ agent: claim })
			);
			expect(response).toMatchObject({ ok: true });
			expect(contexts).toHaveLength(1);
			expect(contexts[0]?.agent).toBeUndefined();
			expect(contexts[0]?.identity.status).toBe('unverified');
		});

		it('leaves a claim unverified for want of a session when nothing maps processes to sessions', async () => {
			const { contexts, handler } = recordingHandler();
			const { socketPath } = await fixture(handler, {
				verifyPeer: async () => true,
			});
			// Even a proven sender is no session's here: without an identifier
			// nothing can place it.
			await request(
				socketPath,
				agentsRequest({ agent: claim, peer: { pid: PEER_PID } })
			);
			expect(contexts.map((context) => context.identity)).toEqual([
				{
					status: 'unverified',
					cause: 'no-session',
					reason:
						'This desktop does not map requests to agent sessions, so the session named cannot be verified.',
				},
			]);
			expect(contexts[0]?.agent).toBeUndefined();
		});

		it('takes a request that claims nothing for anonymous and verifies no process', async () => {
			const { contexts, handler } = recordingHandler();
			const verifyPeer = vi.fn(async () => true);
			const { socketPath } = await fixture(handler, { verifyPeer });
			await request(socketPath, agentsRequest({}));
			await request(socketPath, agentsRequest({ peer: { pid: PEER_PID } }));
			expect(contexts.map((context) => context.identity)).toEqual([
				{ status: 'anonymous' },
				{ status: 'anonymous' },
			]);
			expect(contexts.map((context) => context.agent)).toEqual([
				undefined,
				undefined,
			]);
			// The proof costs a process spawn, and nothing is to be proven.
			expect(verifyPeer).not.toHaveBeenCalled();
		});

		it('refuses a claim that names another session before any handler runs, and says how to fix a stale MCP server', async () => {
			const { contexts, handler } = recordingHandler();
			const mismatch: AgentIdentityResolution = {
				status: 'mismatch',
				reason:
					'The request names a session other than the one the sending process runs under.',
			};
			const { socketPath } = await fixture(handler, {
				verifyPeer: async () => true,
				identify: async () => mismatch,
			});
			const response = await request(
				socketPath,
				agentsRequest({ agent: claim, peer: { pid: PEER_PID } })
			);
			expect(response).toMatchObject({ ok: false });
			expect(response).toHaveProperty('error', {
				code: 'agent_identity_mismatch',
				message:
					'The request names a session other than the one the sending process runs under.',
				retryable: false,
				recovery:
					'Run the tool from inside your own agent session; an MCP server that predates a /clear is fixed by reconnecting it.',
			});
			expect(contexts).toHaveLength(0);
		});

		it('tells an agent what can fix each way its identity could not be verified', () => {
			const recoveries = [
				[
					'no-proof',
					true,
					'Retry; if it keeps failing, update the tool with "rndevtools setup" and run it from inside the agent session.',
				],
				['no-process-table', true, 'Retry.'],
				[
					'no-session',
					false,
					'Ask the user to act in RN Devtools. A request that names no session may use free Simulators (for the CLI, run it without CODEX_THREAD_ID and RNDEVTOOLS_AGENT_SESSION_ID set).',
				],
			] as const;
			for (const [cause, retryable, recovery] of recoveries) {
				const refusal = identityRefusal({
					status: 'unverified',
					cause,
					reason: `Why it failed: ${cause}.`,
				});
				expect(refusal).toBeInstanceOf(AgentCliError);
				// The reason says what happened; only the recovery depends on the cause.
				expect(refusal).toMatchObject({
					code: 'agent_identity_unverified',
					message: `Why it failed: ${cause}.`,
					retryable,
					recovery,
				});
			}
		});

		it('hands the handler a verified claim as the agent', async () => {
			const { contexts, handler } = recordingHandler();
			const { socketPath } = await fixture(handler, {
				verifyPeer: async () => true,
				identify: async ({ claimed }) =>
					claimed
						? { status: 'verified', agent: claimed, basis: 'process' }
						: { status: 'anonymous' },
			});
			await request(
				socketPath,
				agentsRequest({ agent: claim, peer: { pid: PEER_PID } })
			);
			expect(contexts[0]?.agent).toEqual(claim);
			expect(contexts[0]?.identity).toEqual({
				status: 'verified',
				agent: claim,
				basis: 'process',
			});
		});

		it('hands the identifier the peer pid only once the socket proved it', async () => {
			const identify = vi.fn(
				async (): Promise<AgentIdentityResolution> => ({
					status: 'unverified',
					cause: 'no-proof',
					reason: 'unproven',
				})
			);
			const asked: Array<{ socket: unknown; pid: number }> = [];
			let proves: boolean | 'throws' = true;
			const { socketPath } = await fixture(async () => ({}), {
				// The service swallows what a verifier throws, so what it was asked
				// is recorded and checked below rather than asserted in here.
				verifyPeer: async (socket, pid) => {
					asked.push({ socket, pid });
					if (proves === 'throws') throw new Error('lsof is not here');
					return proves;
				},
				identify,
			});
			const send = () =>
				request(
					socketPath,
					agentsRequest({ agent: claim, peer: { pid: PEER_PID } })
				);

			await send();
			expect(identify).toHaveBeenLastCalledWith({
				claimed: claim,
				peerPid: PEER_PID,
			});
			proves = false;
			await send();
			expect(identify).toHaveBeenLastCalledWith({ claimed: claim });
			// A verifier that fails proves nothing, and the request still answers.
			proves = 'throws';
			expect(await send()).toMatchObject({ ok: true });
			expect(identify).toHaveBeenLastCalledWith({ claimed: claim });
			// It is asked about the pid the request named, over the connection the
			// request arrived on: a socket of its own for each.
			expect(asked.map(({ pid }) => pid)).toEqual([
				PEER_PID,
				PEER_PID,
				PEER_PID,
			]);
			for (const { socket } of asked) expect(socket).toBeInstanceOf(Socket);
			expect(new Set(asked.map(({ socket }) => socket)).size).toBe(3);
		});

		it('asks the verifier about a claim only when it comes with a peer', async () => {
			const verifyPeer = vi.fn(async () => true);
			const { socketPath } = await fixture(async () => ({}), { verifyPeer });
			// With no peer there is no process to prove. This is a good request (a
			// CLI from before the desktop checked sends exactly this), so the
			// verifier stays unasked because there is nothing to ask about.
			expect(
				await request(socketPath, agentsRequest({ agent: claim }))
			).toMatchObject({ ok: true });
			expect(verifyPeer).not.toHaveBeenCalled();
			// With a peer it is asked, about the pid the request names.
			expect(
				await request(
					socketPath,
					agentsRequest({ agent: claim, peer: { pid: PEER_PID } })
				)
			).toMatchObject({ ok: true });
			expect(verifyPeer).toHaveBeenCalledTimes(1);
			expect(verifyPeer).toHaveBeenCalledWith(expect.any(Socket), PEER_PID);
		});

		it('accepts a peer that names a valid pid and refuses one that does not', async () => {
			const { contexts, handler } = recordingHandler();
			const { socketPath } = await fixture(handler, {
				verifyPeer: async () => true,
			});
			expect(
				await request(
					socketPath,
					agentsRequest({ agent: claim, peer: { pid: PEER_PID } })
				)
			).toMatchObject({ ok: true });
			expect(contexts).toHaveLength(1);
			for (const peer of [
				{ pid: 0 },
				{ pid: -1 },
				{ pid: 1.5 },
				{ pid: 4_194_305 },
				{ pid: PEER_PID, extra: true },
				{},
				PEER_PID,
			]) {
				expect(
					await request(socketPath, agentsRequest({ agent: claim, peer }))
				).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
			}
			// None of those reached the handler.
			expect(contexts).toHaveLength(1);
		});
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

	it('aborts the handler and frees its connection when a client that half-closed hangs up', async () => {
		// The Go CLI writes its request, half-closes, and closes the socket when
		// its caller gives up (an MCP client cancelling a tool call). The socket
		// has read its EOF by then, so only a write can show the hang-up.
		const connectionLimit = 8;
		const started = new Set<string>();
		const aborted = new Set<string>();
		let allStarted: () => void = () => undefined;
		let allAborted: () => void = () => undefined;
		const everyHandlerStarted = new Promise<void>((resolve) => {
			allStarted = resolve;
		});
		const everyHandlerAborted = new Promise<void>((resolve) => {
			allAborted = resolve;
		});
		const { socketPath } = await fixture(
			async (command, context) => {
				if (!context.requestId.startsWith('abandoned-')) {
					return { kind: command.kind };
				}
				started.add(context.requestId);
				if (started.size === connectionLimit) allStarted();
				await new Promise<void>((resolve) => {
					context.signal.addEventListener('abort', () => resolve(), {
						once: true,
					});
				});
				aborted.add(context.requestId);
				if (aborted.size === connectionLimit) allAborted();
				throw new AgentCliError({
					code: 'cancelled',
					message: 'The agent request was cancelled.',
				});
			},
			{ livenessProbeMs: 20 }
		);
		// As many as the desktop accepts from all its clients together.
		const sockets = Array.from({ length: connectionLimit }, (_, index) => {
			const socket = connect(socketPath);
			socket.on('error', () => undefined);
			socket.once('connect', () => {
				socket.end(
					`${JSON.stringify({
						protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
						id: `abandoned-${index}`,
						command: { kind: 'doctor' },
					})}\n`
				);
			});
			return socket;
		});
		await within(everyHandlerStarted, 2_000, 'every handler to start');
		for (const socket of sockets) socket.destroy();
		await within(everyHandlerAborted, 2_000, 'the hang-ups to abort them');
		// Their connections are free for the next client at once, not when the
		// handlers' own budgets run out.
		expect(
			await request(socketPath, {
				protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
				id: 'after-the-hang-ups',
				command: { kind: 'doctor' },
			})
		).toMatchObject({ ok: true, result: { kind: 'doctor' } });
	});

	it('leads a slow answer with probe spaces and counts them toward the response limit', async () => {
		const limit = 512 * 1024;
		const bigId = 'request-big';
		// The answer line to this is exactly the limit, so it fits only when
		// nothing goes ahead of it.
		const overhead = Buffer.byteLength(
			`${JSON.stringify({
				protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
				id: bigId,
				ok: true,
				result: { value: '' },
			})}\n`
		);
		const big = { value: 'x'.repeat(limit - overhead) };
		let delayMs = 0;
		const { socketPath } = await fixture(
			async (_command, context) => {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				return context.requestId === bigId ? big : { small: true };
			},
			{ livenessProbeMs: 20 }
		);
		const send = (id: string) =>
			exchangeRaw(socketPath, {
				protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
				id,
				command: { kind: 'doctor' },
			});

		const quick = await send(bigId);
		expect(quick.byteLength).toBe(limit);
		expect(JSON.parse(quick.toString('utf8'))).toMatchObject({ ok: true });

		delayMs = 150;
		const slow = (await send('request-small')).toString('utf8');
		// Still one line: spaces, then the JSON, then its LF.
		expect(slow).toMatch(/^ +\{[^\n]*\}\n$/);
		expect(JSON.parse(slow)).toEqual({
			protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
			id: 'request-small',
			ok: true,
			result: { small: true },
		});

		const slowBig = await send(bigId);
		expect(slowBig.byteLength).toBeLessThanOrEqual(limit);
		expect(slowBig.toString('utf8')).toMatch(/^ +\{/);
		expect(JSON.parse(slowBig.toString('utf8'))).toMatchObject({
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
