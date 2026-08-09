import {
	serializeValue,
	truncateText,
	utf8ByteLength,
} from '../core/serialize';

export type NetworkEventState = 'pending' | 'success' | 'error' | 'aborted';

export type NetworkEvent = {
	id: number;
	startedAt: number;
	method: string;
	url: string;
	state: NetworkEventState;
	status?: number;
	durationMs: number;
	requestHeaders: Readonly<Record<string, string>>;
	requestBody?: string;
	responseHeaders?: Readonly<Record<string, string>>;
	responseBody?: string;
	contentType?: string;
	source: string;
	requestSizeBytes?: number;
	responseSizeBytes?: number;
	error?: string;
};

export type NetworkBodyContext = {
	direction: 'request' | 'response';
	contentType?: string;
	url: string;
};

const DEFAULT_SENSITIVE_FIELD =
	/authorization|cookie|token|secret|password|passcode|session|api[-_]?key/i;

export function defaultRedactHeader(name: string, value: string): string {
	return DEFAULT_SENSITIVE_FIELD.test(name) ? '[REDACTED]' : value;
}

export function defaultRedactUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		for (const name of url.searchParams.keys()) {
			if (DEFAULT_SENSITIVE_FIELD.test(name)) {
				url.searchParams.set(name, '[REDACTED]');
			}
		}
		return url.toString();
	} catch {
		return rawUrl;
	}
}

function redactJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactJson);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			DEFAULT_SENSITIVE_FIELD.test(key) ? '[REDACTED]' : redactJson(entry),
		]),
	);
}

export function defaultRedactBody(body: string): string {
	try {
		return JSON.stringify(redactJson(JSON.parse(body)), null, 2);
	} catch {
		return body.replace(
			/((?:token|secret|password|session|api[-_]?key)=)[^&\s]+/gi,
			'$1[REDACTED]',
		);
	}
}

export function headersRecord(
	headersInit: HeadersInit | undefined,
	redact: (name: string, value: string) => string,
): Record<string, string> {
	if (!headersInit) return {};
	const output: Record<string, string> = {};
	new Headers(headersInit).forEach((value, name) => {
		try {
			output[name] = redact(name, value);
		} catch {
			output[name] = '[REDACTION FAILED]';
		}
	});
	return output;
}

export function requestHeaders(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	redact: (name: string, value: string) => string,
): Record<string, string> {
	const output =
		typeof Request !== 'undefined' && input instanceof Request
			? headersRecord(input.headers, redact)
			: {};
	return { ...output, ...headersRecord(init?.headers, redact) };
}

export function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

export function requestMethod(
	input: RequestInfo | URL,
	init?: RequestInit,
): string {
	if (init?.method) return init.method.toUpperCase();
	if (typeof Request !== 'undefined' && input instanceof Request) {
		return input.method.toUpperCase();
	}
	return 'GET';
}

function bodyFromInit(
	body: BodyInit | null | undefined,
	maxBytes: number,
): string | undefined {
	if (body == null) return undefined;
	if (typeof body === 'string') return truncateText(body, maxBytes).text;
	if (
		typeof URLSearchParams !== 'undefined' &&
		body instanceof URLSearchParams
	) {
		return truncateText(body.toString(), maxBytes).text;
	}
	if (typeof FormData !== 'undefined' && body instanceof FormData) {
		return '[FormData]';
	}
	return serializeValue(body, maxBytes).text;
}

export function textBytes(value: string | undefined): number | undefined {
	return value === undefined ? undefined : utf8ByteLength(value);
}

export function parseContentLength(value: string | null): number | undefined {
	if (value === null || value.trim() === '') return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseNetworkUrl(rawUrl: string): {
	path: string;
	query: Readonly<Record<string, string | readonly string[]>>;
} {
	try {
		const url = new URL(rawUrl);
		const query: Record<string, string | string[]> = {};
		for (const [key, value] of url.searchParams.entries()) {
			const current = query[key];
			query[key] =
				current === undefined
					? value
					: Array.isArray(current)
						? [...current, value]
						: [current, value];
		}
		return { path: `${url.origin}${url.pathname}`, query };
	} catch {
		return { path: rawUrl, query: {} };
	}
}

export function formatNetworkBytes(bytes: number | undefined): string {
	if (bytes === undefined) return '—';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function captureRequestBody(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	maxBytes: number,
): Promise<string | undefined> {
	const initializedBody = bodyFromInit(init?.body, maxBytes);
	if (initializedBody !== undefined) return initializedBody;
	if (typeof Request === 'undefined' || !(input instanceof Request)) {
		return undefined;
	}
	if (input.method === 'GET' || input.method === 'HEAD') return undefined;
	try {
		return truncateText(await input.clone().text(), maxBytes).text;
	} catch {
		return '[Unreadable request body]';
	}
}

export async function captureResponseBody(
	response: Response,
	maxBytes: number,
	captureUnknownLengthBodies: boolean,
): Promise<{ body?: string; capturedBytes?: number }> {
	const contentLength = parseContentLength(
		response.headers.get('content-length'),
	);
	if (contentLength !== undefined && contentLength > maxBytes) {
		return { body: `[Body omitted: ${contentLength} bytes]` };
	}
	const contentType = response.headers.get('content-type') ?? '';
	if (
		contentType.startsWith('image/') ||
		contentType.startsWith('audio/') ||
		contentType.startsWith('video/') ||
		contentType.includes('application/octet-stream')
	) {
		return {
			body: `[Binary body omitted: ${contentType || 'unknown content type'}]`,
		};
	}
	if (contentLength === undefined && !captureUnknownLengthBodies) {
		return { body: '[Body omitted: unknown content length]' };
	}
	try {
		const text = await response.clone().text();
		return {
			body: truncateText(text, maxBytes).text,
			capturedBytes: utf8ByteLength(text),
		};
	} catch {
		return { body: '[Unreadable response body]' };
	}
}
