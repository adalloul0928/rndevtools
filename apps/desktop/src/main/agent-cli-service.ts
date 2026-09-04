import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { diagnosticErrorText, redactDiagnosticText } from '@pumpd/devtools/redact';
import {
	type AgentCliCommand,
	type AgentCliErrorBody,
	type AgentCliRequest,
	type AgentCliResponse,
	agentCliRequestSchema,
	PUMPD_AGENT_CLI_PROTOCOL,
} from '../shared/agent-cli-protocol';

const MAX_CONNECTIONS = 8;
const MAX_REQUESTS_PER_WINDOW = 120;
const RATE_WINDOW_MS = 10_000;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_ERROR_LENGTH = 4 * 1024;

type AgentCliHandlerContext = {
	requestId: string;
	signal: AbortSignal;
};

export type AgentCliHandler = (
	command: AgentCliCommand,
	context: AgentCliHandlerContext
) => Promise<unknown>;

export type AgentCliServiceState = {
	status: 'stopped' | 'available' | 'unavailable';
	socketPath?: string;
	protocol: typeof PUMPD_AGENT_CLI_PROTOCOL;
	error?: string;
};

export class AgentCliError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly recovery: string | undefined;

	constructor({
		code,
		message,
		retryable = false,
		recovery,
	}: {
		code: string;
		message: string;
		retryable?: boolean;
		recovery?: string;
	}) {
		super(message);
		this.name = 'AgentCliError';
		this.code = code;
		this.retryable = retryable;
		this.recovery = recovery;
	}
}

function safeErrorBody(error: unknown): AgentCliErrorBody {
	const known = error instanceof AgentCliError ? error : undefined;
	const message = redactDiagnosticText(
		known?.message ?? diagnosticErrorText(error)
	).slice(0, MAX_ERROR_LENGTH);
	return {
		code:
			known?.code && /^[a-z][a-z0-9_]{0,63}$/.test(known.code)
				? known.code
				: 'internal_error',
		message: message || 'The agent request failed.',
		retryable: known?.retryable ?? false,
		...(known?.recovery
			? { recovery: redactDiagnosticText(known.recovery).slice(0, MAX_ERROR_LENGTH) }
			: {}),
	};
}

function handlerTimeoutMs(command: AgentCliCommand): number {
	if (command.kind === 'wait') {
		return Math.min(MAX_REQUEST_TIMEOUT_MS, command.timeoutMs + 5_000);
	}
	if (command.kind === 'recipe' && command.operation === 'run') {
		return MAX_REQUEST_TIMEOUT_MS;
	}
	return REQUEST_TIMEOUT_MS;
}

function failureResponse(id: string, error: AgentCliErrorBody): AgentCliResponse {
	return {
		protocol: PUMPD_AGENT_CLI_PROTOCOL,
		id: id.slice(0, 256),
		ok: false,
		error,
	};
}

function encodeResponse(response: AgentCliResponse): Buffer {
	let encoded: Buffer;
	try {
		encoded = Buffer.from(`${JSON.stringify(response)}\n`, 'utf8');
	} catch {
		encoded = Buffer.from(
			`${JSON.stringify(
				failureResponse(response.id, {
					code: 'response_not_serializable',
					message: 'The command result could not be serialized.',
					retryable: false,
				})
			)}\n`,
			'utf8'
		);
	}
	if (encoded.byteLength <= MAX_RESPONSE_BYTES) return encoded;
	return Buffer.from(
		`${JSON.stringify(
			failureResponse(response.id, {
				code: 'response_too_large',
				message: 'The command result exceeded the 512 KiB response limit.',
				retryable: false,
				recovery: 'Narrow the query or request fewer records.',
			})
		)}\n`,
		'utf8'
	);
}

function isMissingFile(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === 'object' &&
			'code' in error &&
			(error as { code?: unknown }).code === 'ENOENT'
	);
}

export class AgentCliService {
	readonly #socketPath: string;
	readonly #socketDirectory: string;
	readonly #handler: AgentCliHandler;
	readonly #platform: NodeJS.Platform;
	readonly #readiness: (() => Promise<void>) | undefined;
	readonly #connections = new Set<Socket>();
	readonly #requestTimestamps: number[] = [];
	#server: Server | undefined;
	#state: AgentCliServiceState = {
		status: 'stopped',
		protocol: PUMPD_AGENT_CLI_PROTOCOL,
	};

	constructor({
		socketPath,
		handler,
		platform = process.platform,
		readiness,
	}: {
		socketPath: string;
		handler: AgentCliHandler;
		platform?: NodeJS.Platform;
		readiness?: () => Promise<void>;
	}) {
		this.#socketPath = path.resolve(socketPath);
		this.#socketDirectory = path.dirname(this.#socketPath);
		this.#handler = handler;
		this.#platform = platform;
		this.#readiness = readiness;
	}

	getState(): AgentCliServiceState {
		return { ...this.#state };
	}

	async start(): Promise<AgentCliServiceState> {
		if (this.#server) return this.getState();
		if (this.#platform !== 'darwin') {
			this.#state = {
				status: 'unavailable',
				protocol: PUMPD_AGENT_CLI_PROTOCOL,
				error: 'The local agent CLI is currently available on macOS only.',
			};
			return this.getState();
		}

		try {
			await this.#readiness?.();
			await mkdir(this.#socketDirectory, { recursive: true, mode: 0o700 });
			await chmod(this.#socketDirectory, 0o700);
			const directoryMetadata = await lstat(this.#socketDirectory);
			if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
				throw new AgentCliError({
					code: 'unsafe_socket_directory',
					message: 'The agent socket directory must be a real private directory.',
				});
			}
			await this.#removeStaleSocket();
			const server = createServer({ allowHalfOpen: true }, (socket) =>
				this.#accept(socket)
			);
			server.maxConnections = MAX_CONNECTIONS;
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					server.off('listening', onListening);
					reject(error);
				};
				const onListening = () => {
					server.off('error', onError);
					resolve();
				};
				server.once('error', onError);
				server.once('listening', onListening);
				server.listen(this.#socketPath);
			});
			this.#server = server;
			await chmod(this.#socketPath, 0o600);
			this.#state = {
				status: 'available',
				protocol: PUMPD_AGENT_CLI_PROTOCOL,
				socketPath: this.#socketPath,
			};
		} catch (error) {
			const server = this.#server;
			this.#server = undefined;
			if (server) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await rm(this.#socketPath, { force: true }).catch(() => undefined);
			}
			for (const socket of this.#connections) socket.destroy();
			this.#connections.clear();
			this.#state = {
				status: 'unavailable',
				protocol: PUMPD_AGENT_CLI_PROTOCOL,
				error: safeErrorBody(error).message,
			};
		}
		return this.getState();
	}

	async stop(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		for (const socket of this.#connections) socket.destroy();
		this.#connections.clear();
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		if (server) {
			await rm(this.#socketPath, { force: true }).catch(() => undefined);
		}
		this.#state = {
			status: 'stopped',
			protocol: PUMPD_AGENT_CLI_PROTOCOL,
		};
	}

	async #removeStaleSocket(): Promise<void> {
		try {
			const metadata = await lstat(this.#socketPath);
			if (!metadata.isSocket()) {
				throw new AgentCliError({
					code: 'unsafe_socket_path',
					message:
						'The configured agent socket path already contains a non-socket file.',
				});
			}
			await rm(this.#socketPath);
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}

	#accept(socket: Socket): void {
		const now = Date.now();
		while (
			this.#requestTimestamps[0] !== undefined &&
			now - (this.#requestTimestamps[0] as number) >= RATE_WINDOW_MS
		) {
			this.#requestTimestamps.shift();
		}
		if (this.#connections.size >= MAX_CONNECTIONS) {
			socket.end(
				encodeResponse(
					failureResponse('', {
						code: 'server_busy',
						message: 'The local agent command limit has been reached.',
						retryable: true,
					})
				)
			);
			return;
		}
		if (this.#requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
			socket.end(
				encodeResponse(
					failureResponse('', {
						code: 'rate_limited',
						message: 'Too many local agent requests were opened.',
						retryable: true,
					})
				)
			);
			return;
		}
		this.#requestTimestamps.push(now);
		this.#connections.add(socket);
		socket.setTimeout(REQUEST_TIMEOUT_MS);
		let buffer = Buffer.alloc(0);
		let handled = false;
		const close = () => this.#connections.delete(socket);
		socket.once('close', close);
		socket.once('error', close);
		socket.once('timeout', () => {
			socket.end(
				encodeResponse(
					failureResponse('', {
						code: 'request_timeout',
						message: 'The local agent request timed out.',
						retryable: true,
					})
				)
			);
		});
		socket.on('data', (chunk: Buffer) => {
			if (handled) return;
			buffer = Buffer.concat([buffer, chunk], buffer.byteLength + chunk.byteLength);
			if (buffer.byteLength > MAX_REQUEST_BYTES) {
				handled = true;
				socket.end(
					encodeResponse(
						failureResponse('', {
							code: 'request_too_large',
							message: 'The local agent request exceeded 256 KiB.',
							retryable: false,
						})
					)
				);
				return;
			}
		});
		socket.once('end', () => {
			if (handled) return;
			handled = true;
			const newline = buffer.indexOf(0x0a);
			if (newline === -1 || newline !== buffer.byteLength - 1) {
				socket.end(
					encodeResponse(
						failureResponse('', {
							code: 'multiple_requests',
							message:
								'Each connection requires exactly one LF-terminated command and no trailing bytes.',
							retryable: false,
						})
					)
				);
				return;
			}
			void this.#handle(socket, buffer.subarray(0, newline));
		});
	}

	async #handle(socket: Socket, raw: Buffer): Promise<void> {
		let request: AgentCliRequest;
		try {
			if (raw.includes(0)) throw new Error('NUL bytes are not valid JSON.');
			request = agentCliRequestSchema.parse(JSON.parse(raw.toString('utf8')));
		} catch {
			socket.end(
				encodeResponse(
					failureResponse('', {
						code: 'invalid_request',
						message: 'The command did not match pumpd-devtools/1.',
						retryable: false,
					})
				)
			);
			return;
		}

		socket.setTimeout(0);
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			handlerTimeoutMs(request.command)
		);
		const onClose = () => controller.abort();
		socket.once('close', onClose);
		try {
			const result = await this.#handler(request.command, {
				requestId: request.id || randomUUID(),
				signal: controller.signal,
			});
			if (!socket.destroyed) {
				socket.end(
					encodeResponse({
						protocol: PUMPD_AGENT_CLI_PROTOCOL,
						id: request.id,
						ok: true,
						result,
					})
				);
			}
		} catch (error) {
			if (!socket.destroyed) {
				socket.end(encodeResponse(failureResponse(request.id, safeErrorBody(error))));
			}
		} finally {
			clearTimeout(timer);
			socket.off('close', onClose);
		}
	}
}
