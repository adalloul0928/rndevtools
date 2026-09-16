import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	type AgentCliResponse,
	RNDEVTOOLS_AGENT_CLI_PROTOCOL,
} from '../shared/agent-cli-protocol';
import { AgentCliError, AgentCliService } from './agent-cli-service';

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
