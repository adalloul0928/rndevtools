import {
	isSensitiveDiagnosticKey,
	redactDiagnosticText,
	sanitizeDiagnosticValueWithMetadata,
} from '../core/redact';
import { truncateText, utf8ByteLength } from '../core/serialize';

const MAX_CAPTURED_HEADERS = 100;
const MAX_HEADER_NAME_BYTES = 1024;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;

export { formatBytes as formatNetworkBytes } from '../core/format';

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

export function defaultRedactHeader(name: string, value: string): string {
	return isSensitiveDiagnosticKey(name)
		? '[REDACTED]'
		: redactDiagnosticText(value);
}

export function defaultRedactUrl(rawUrl: string): string {
	const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(rawUrl);
	const isProtocolRelative = rawUrl.startsWith('//');
	try {
		const url = new URL(rawUrl, 'https://devtools.invalid');
		if (url.username) url.username = '[REDACTED]';
		if (url.password) url.password = '[REDACTED]';
		for (const name of url.searchParams.keys()) {
			if (isSensitiveDiagnosticKey(name)) {
				url.searchParams.set(name, '[REDACTED]');
			}
		}
		const redacted = isAbsolute
			? url.toString()
			: isProtocolRelative
				? `//${url.host}${url.pathname}${url.search}${url.hash}`
				: `${url.pathname}${url.search}${url.hash}`;
		return redactDiagnosticText(redacted);
	} catch {
		return redactDiagnosticText(rawUrl);
	}
}

/**
 * The diagnostic projection drops object/array entries past its per-level cap
 * and nesting past its depth limit. Those losses leave no in-band evidence, so
 * a projected body that still parses as JSON would otherwise look complete to
 * both the panel and the replay guard. Append an explicit trailer instead.
 */
const BODY_TRUNCATION_MARKER = '[Body truncated by diagnostic capture]';

export function defaultRedactBody(body: string): string {
	try {
		const projection = sanitizeDiagnosticValueWithMetadata(JSON.parse(body));
		const text = JSON.stringify(projection.value, null, 2);
		return projection.truncated ? `${text}\n${BODY_TRUNCATION_MARKER}` : text;
	} catch {
		return redactDiagnosticText(body);
	}
}

export function headersRecord(
	headersInit: HeadersInit | undefined,
	redact: (name: string, value: string) => string,
): Record<string, string> {
	if (!headersInit) return {};
	const output = Object.create(null) as Record<string, string>;
	let capturedCount = 0;
	new Headers(headersInit).forEach((value, name) => {
		if (capturedCount >= MAX_CAPTURED_HEADERS) return;
		capturedCount += 1;
		const safeName = truncateText(name, MAX_HEADER_NAME_BYTES).text;
		try {
			const customValue = redact(name, value);
			output[safeName] =
				typeof customValue === 'string'
					? truncateText(
							defaultRedactHeader(name, customValue),
							MAX_HEADER_VALUE_BYTES,
						).text
					: '[REDACTION FAILED]';
		} catch {
			output[safeName] = '[REDACTION FAILED]';
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
		return '[FormData omitted]';
	}
	if (typeof Blob !== 'undefined' && body instanceof Blob) {
		return `[Binary body omitted: ${body.type || 'Blob'}]`;
	}
	if (
		typeof ArrayBuffer !== 'undefined' &&
		(body instanceof ArrayBuffer || ArrayBuffer.isView(body))
	) {
		return '[Binary body omitted]';
	}
	return '[Unsupported request body omitted]';
}

export function textBytes(value: string | undefined): number | undefined {
	return value === undefined ? undefined : utf8ByteLength(value);
}

export function parseContentLength(value: string | null): number | undefined {
	if (value === null || value.trim() === '') return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseNetworkUrl(rawUrl: string): {
	host: string;
	origin: string;
	path: string;
	pathname: string;
	query: Readonly<Record<string, string | readonly string[]>>;
} {
	try {
		const url = new URL(rawUrl);
		const query = Object.create(null) as Record<string, string | string[]>;
		for (const [key, value] of url.searchParams.entries()) {
			const current = query[key];
			query[key] =
				current === undefined
					? value
					: Array.isArray(current)
						? [...current, value]
						: [current, value];
		}
		return {
			host: url.host,
			origin: url.origin,
			path: `${url.origin}${url.pathname}`,
			pathname: url.pathname,
			query,
		};
	} catch {
		return {
			host: '',
			origin: '',
			path: rawUrl,
			pathname: rawUrl,
			query: {},
		};
	}
}

export async function captureRequestBody(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	maxBytes: number,
	captureUnknownLengthBodies: boolean,
): Promise<string | undefined> {
	const initializedBody = bodyFromInit(init?.body, maxBytes);
	if (initializedBody !== undefined) return initializedBody;
	if (typeof Request === 'undefined' || !(input instanceof Request)) {
		return undefined;
	}
	if (input.method === 'GET' || input.method === 'HEAD') return undefined;
	// `Content-Length` is a forbidden request header, so a `Request` built from a
	// body never carries one. Without the same opt-in the response path uses,
	// every `fetch(new Request(url, { body }))` would report an omitted body —
	// which `UNSAFE_REPLAY_MARKER` then reads as redacted data and blocks replay.
	const contentLength = parseContentLength(input.headers.get('content-length'));
	if (contentLength === undefined && !captureUnknownLengthBodies) {
		return '[Body omitted: unknown content length]';
	}
	if (contentLength !== undefined && contentLength > maxBytes) {
		return `[Body omitted: ${contentLength} bytes]`;
	}
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
	const contentType = (
		response.headers.get('content-type') ?? ''
	).toLowerCase();
	if (
		contentType.startsWith('image/') ||
		contentType.startsWith('audio/') ||
		contentType.startsWith('video/') ||
		contentType.startsWith('font/') ||
		contentType.includes('application/octet-stream') ||
		contentType.includes('application/pdf') ||
		contentType.includes('application/zip') ||
		contentType.includes('application/gzip') ||
		contentType.includes('application/x-protobuf') ||
		contentType.includes('multipart/form-data')
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
