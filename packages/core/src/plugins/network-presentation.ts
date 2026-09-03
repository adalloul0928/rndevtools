import { formatDuration as formatNetworkDuration } from '../core/format';
import {
	formatNetworkBytes,
	type NetworkEvent,
	parseNetworkUrl,
} from './network-capture';

export type NetworkSegment = 'all' | 'supabase' | 'errors' | 'slow';

/**
 * The fields request classification actually needs. The on-device `NetworkEvent`
 * and the desktop wire `NetworkEntry` both satisfy this, so both surfaces can
 * share one set of rules instead of each re-deriving them and drifting.
 */
export type ClassifiableNetworkRequest = {
	url: string;
	state: NetworkEvent['state'];
	// Spelled with explicit `undefined` so the desktop's wire entries satisfy
	// this under `exactOptionalPropertyTypes`.
	status?: number | undefined;
	durationMs?: number | undefined;
};

export type NetworkStatusTone = 'success' | 'danger' | 'warning' | 'info';

export type CollapsedNetworkEvent = {
	event: NetworkEvent;
	count: number;
};

const SLOW_REQUEST_MS = 1000;
export const MAX_BODY_PREVIEW_BYTES = 32 * 1024;
export const MAX_NETWORK_BODY_BYTES = 1024 * 1024;
export const MAX_NETWORK_EVENTS = 10_000;
export const MAX_NETWORK_STORE_BYTES = 32 * 1024 * 1024;
/** Placeholders the collector writes in place of a captured secret. */
// Every marker the capture and projection layers can leave behind. Replay sends
// a real request built from the captured text, so anything the projection
// altered must block it: `[Depth limit]`, `[Circular]`, and `[Accessor
// omitted]` survive as literal JSON values, and entry-cap losses are announced
// by the explicit truncation trailer because they leave no in-band evidence.
const UNSAFE_REPLAY_MARKER =
	/(?:redacted|redaction failed|body omitted|binary body omitted|unreadable|formdata omitted|url omitted|truncated|depth limit|circular|accessor omitted)/i;
export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SUPABASE_PATH_PREFIXES = ['/rest/', '/functions/', '/storage/', '/auth/'];
const STORAGE_OBJECT_MODES = new Set([
	'authenticated',
	'copy',
	'info',
	'list',
	'move',
	'public',
	'sign',
	'upload',
]);

function hostParts(host: string): { hostname: string; port: number } {
	const lowered = host.toLowerCase();
	// `URL.host` brackets IPv6 authorities, so splitting on the first colon would
	// yield '[' as the hostname and lose the port entirely.
	const bracketed = /^\[(?<address>[^\]]*)\](?::(?<port>\d+))?$/.exec(lowered);
	if (bracketed?.groups) {
		const { address = '', port = '' } = bracketed.groups;
		return { hostname: address, port: Number(port) };
	}
	const separator = lowered.lastIndexOf(':');
	if (separator === -1) return { hostname: lowered, port: Number('') };
	return {
		hostname: lowered.slice(0, separator),
		port: Number(lowered.slice(separator + 1)),
	};
}

export function networkEventLabel(event: NetworkEvent): {
	label: string;
	sourceKind?: 'rest' | 'edge function' | 'storage' | 'auth';
} {
	const parsed = parseNetworkUrl(event.url);
	const segments = parsed.pathname.split('/').filter(Boolean);
	const last = segments.at(-1);
	if (segments[0] === 'rest') {
		return { label: segments[2] ?? last ?? 'rest', sourceKind: 'rest' };
	}
	if (segments[0] === 'functions') {
		return {
			label: segments[2] ?? last ?? 'functions',
			sourceKind: 'edge function',
		};
	}
	if (segments[0] === 'storage') {
		const objectIndex = segments.indexOf('object');
		let label = last ?? 'storage';
		if (objectIndex >= 0) {
			const mode = segments[objectIndex + 1];
			label =
				(STORAGE_OBJECT_MODES.has(mode ?? '')
					? segments[objectIndex + 2]
					: mode) ?? label;
		}
		return { label, sourceKind: 'storage' };
	}
	if (segments[0] === 'auth') {
		return { label: last ?? 'auth', sourceKind: 'auth' };
	}
	return { label: last || parsed.host || parsed.path };
}

export function isSupabaseNetworkEvent(
	event: ClassifiableNetworkRequest,
): boolean {
	const parsed = parseNetworkUrl(event.url);
	if (hostParts(parsed.host).hostname.includes('supabase')) return true;
	return SUPABASE_PATH_PREFIXES.some((prefix) =>
		parsed.pathname.startsWith(prefix),
	);
}

function isFailedNetworkEvent(event: ClassifiableNetworkRequest): boolean {
	return (
		event.state === 'error' ||
		event.state === 'aborted' ||
		(event.status ?? 0) >= 400
	);
}

export function networkReplayBlockReason(
	event: NetworkEvent,
): string | undefined {
	if (UNSAFE_REPLAY_MARKER.test(event.url)) {
		return 'The captured URL contains omitted or redacted data.';
	}
	if (
		Object.values(event.requestHeaders).some((value) =>
			UNSAFE_REPLAY_MARKER.test(value),
		)
	) {
		return 'One or more request headers were redacted.';
	}
	if (
		event.requestBody !== undefined &&
		UNSAFE_REPLAY_MARKER.test(event.requestBody)
	) {
		return 'The captured request body contains omitted or redacted data.';
	}
	// Byte-capped bodies are cut mid-value and marked only with a trailing
	// ellipsis, so replaying one would send a malformed prefix of the original.
	if (event.requestBody?.endsWith('…')) {
		return 'The captured request body was truncated at the capture size limit.';
	}
	return undefined;
}

/**
 * Connectivity checks, Sentry ingest, and the Metro dev server are ambient
 * traffic the panel hides by default. Analytics such as PostHog stay visible
 * because the app sends them deliberately.
 */
export function isSystemNetworkEvent(
	event: ClassifiableNetworkRequest,
): boolean {
	const parsed = parseNetworkUrl(event.url);
	const { hostname, port } = hostParts(parsed.host);
	const pathname = parsed.pathname.toLowerCase();
	if (pathname.includes('generate_204') || pathname.includes('generate204')) {
		return true;
	}
	if (/^clients\d*\.google\.com$/.test(hostname)) return true;
	if (hostname === 'gstatic.com' || hostname.endsWith('.gstatic.com')) {
		return true;
	}
	if (hostname === 'captive.apple.com') return true;
	if (hostname === 'sentry.io' || hostname.endsWith('.sentry.io')) return true;
	if (
		(hostname === 'localhost' ||
			hostname === '127.0.0.1' ||
			hostname === '::1') &&
		port >= 8081 &&
		port <= 8090
	) {
		return true;
	}
	return false;
}

export function matchesNetworkSegment(
	event: ClassifiableNetworkRequest,
	segment: NetworkSegment,
): boolean {
	if (segment === 'supabase') return isSupabaseNetworkEvent(event);
	if (segment === 'errors') return isFailedNetworkEvent(event);
	if (segment === 'slow') {
		return (
			event.state !== 'pending' && (event.durationMs ?? 0) >= SLOW_REQUEST_MS
		);
	}
	return true;
}

export function matchesNetworkSearch(
	event: NetworkEvent,
	needle: string,
): boolean {
	if (!needle) return true;
	return (
		event.url.toLowerCase().includes(needle) ||
		event.method.toLowerCase().includes(needle) ||
		String(event.status ?? '').includes(needle) ||
		networkEventLabel(event).label.toLowerCase().includes(needle)
	);
}

export function collapseNetworkEvents(
	events: readonly NetworkEvent[],
): CollapsedNetworkEvent[] {
	const collapsed: CollapsedNetworkEvent[] = [];
	for (const event of events) {
		const previous = collapsed.at(-1);
		if (
			previous &&
			previous.event.method === event.method &&
			previous.event.url === event.url &&
			previous.event.status === event.status &&
			previous.event.state === event.state
		) {
			previous.count += 1;
		} else {
			collapsed.push({ event, count: 1 });
		}
	}
	return collapsed;
}

export function summarizeNetworkEvents(
	events: readonly NetworkEvent[],
	nowMs: number,
): string {
	if (events.length === 0) return 'No requests';
	const oldest = events.reduce(
		(minimum, event) => Math.min(minimum, event.startedAt),
		Number.POSITIVE_INFINITY,
	);
	const minutes = Math.max(1, Math.ceil((nowMs - oldest) / 60_000));
	const window =
		minutes < 60 ? `Last ${minutes} min` : `Last ${Math.ceil(minutes / 60)} hr`;
	const failed = events.filter(isFailedNetworkEvent).length;
	const bytes = events.reduce(
		(total, event) =>
			total + (event.requestSizeBytes ?? 0) + (event.responseSizeBytes ?? 0),
		0,
	);
	const parts = [
		window,
		`${events.length} request${events.length === 1 ? '' : 's'}`,
	];
	if (failed > 0) parts.push(`${failed} failed`);
	if (bytes > 0) parts.push(formatNetworkBytes(bytes));
	return parts.join(' · ');
}

export function networkStatusPresentation(event: NetworkEvent): {
	text: string;
	tone: NetworkStatusTone;
} {
	if (event.state === 'pending') return { text: '…', tone: 'info' };
	if (event.state === 'aborted') {
		return {
			text: event.status ? String(event.status) : 'ABORTED',
			tone: 'warning',
		};
	}
	if (event.state === 'error') {
		return {
			text: event.status ? String(event.status) : 'ERROR',
			tone: 'danger',
		};
	}
	const status = event.status ?? 0;
	if (status >= 500) return { text: String(status), tone: 'danger' };
	if (status >= 400) return { text: String(status), tone: 'warning' };
	return { text: event.status ? String(event.status) : 'OK', tone: 'success' };
}

function hostToken(host: string): string | undefined {
	const { hostname } = hostParts(host);
	if (!hostname) return undefined;
	if (hostname === 'localhost' || /^[\d.]+$/.test(hostname)) return host;
	const parts = hostname.split('.');
	return parts.length >= 2 ? parts[parts.length - 2] : hostname;
}

export { formatNetworkDuration };

export function networkRowSubtitle(event: NetworkEvent): string {
	const parsed = parseNetworkUrl(event.url);
	const source =
		networkEventLabel(event).sourceKind ??
		hostToken(parsed.host) ??
		event.source;
	const tokens = [source];
	if (event.state === 'pending') {
		tokens.push('pending');
		if (event.requestSizeBytes !== undefined) {
			tokens.push(`${formatNetworkBytes(event.requestSizeBytes)} ↑`);
		}
	} else {
		tokens.push(formatNetworkDuration(event.durationMs));
		if (event.state === 'error' || event.state === 'aborted') {
			const reason = event.error ?? event.state;
			tokens.push(reason.length > 48 ? `${reason.slice(0, 47)}…` : reason);
		} else if (event.responseSizeBytes !== undefined) {
			tokens.push(formatNetworkBytes(event.responseSizeBytes));
		}
	}
	return tokens.join(' · ');
}

export function formatNetworkClock(epochMs: number): string {
	const date = new Date(epochMs);
	const pad = (value: number, size = 2) => String(value).padStart(size, '0');
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
		date.getSeconds(),
	)}.${pad(date.getMilliseconds(), 3)}`;
}

export function networkRequestPath(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.pathname}${parsed.search}` || url;
	} catch {
		return url;
	}
}

export function prettyNetworkBody(body: string): string {
	try {
		return JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		return body;
	}
}

export function detailStatusText(event: NetworkEvent): string {
	if (event.state === 'pending') return 'Pending…';
	if (event.state === 'aborted') return 'Aborted';
	if (event.status === undefined) {
		return event.state === 'error' ? 'Failed' : 'Unknown';
	}
	return event.status === 200 ? '200 OK' : String(event.status);
}

export function responseBodySummaryText(event: NetworkEvent): string {
	if (event.responseBody === undefined) {
		return event.state === 'pending' ? 'Pending' : 'Empty';
	}
	const kind = event.contentType?.toLowerCase().includes('json')
		? 'JSON'
		: (event.contentType?.split(';')[0]?.trim() ?? 'Text');
	return event.responseSizeBytes === undefined
		? kind
		: `${kind} · ${formatNetworkBytes(event.responseSizeBytes)}`;
}

export function buildCurlCommand(event: NetworkEvent): string {
	const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
	const parts = [`curl -X ${event.method} ${quote(event.url)}`];
	for (const [name, value] of Object.entries(event.requestHeaders)) {
		parts.push(`-H ${quote(`${name}: ${value}`)}`);
	}
	if (
		event.requestBody !== undefined &&
		event.method !== 'GET' &&
		event.method !== 'HEAD'
	) {
		parts.push(`--data ${quote(event.requestBody)}`);
	}
	return parts.join(' \\\n  ');
}
