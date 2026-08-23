import {
	Button,
	ContentUnavailableView,
	DisclosureGroup,
	Host,
	HStack,
	Image,
	LabeledContent,
	List,
	Picker,
	Section,
	Spacer,
	TextField,
	Toggle,
	Text as UIText,
	VStack,
} from '@expo/ui/swift-ui';
import {
	autocorrectionDisabled,
	badge,
	buttonStyle,
	font,
	foregroundStyle,
	frame,
	listStyle,
	pickerStyle,
	tag,
	textSelection,
} from '@expo/ui/swift-ui/modifiers';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, PlatformColor, Share } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSearch,
	AndroidPanelSection,
	AndroidPanelTabs,
	AndroidPanelTextBlock,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { assertPositiveFinite } from '../core/options';
import { serializeValue, truncateText } from '../core/serialize';
import type {
	DevToolsActionServices,
	DevToolsPanelPlugin,
	DevToolsSystemImage,
} from '../types';
import {
	captureRequestBody,
	captureResponseBody,
	defaultRedactBody,
	defaultRedactHeader,
	defaultRedactUrl,
	formatNetworkBytes,
	headersRecord,
	type NetworkBodyContext,
	type NetworkEvent,
	parseContentLength,
	parseNetworkUrl,
	requestHeaders,
	requestMethod,
	requestUrl,
	textBytes,
} from './network-capture';

export type {
	NetworkBodyContext,
	NetworkEvent,
	NetworkEventState,
} from './network-capture';
export { formatNetworkBytes, parseNetworkUrl } from './network-capture';

type FetchImplementation = typeof fetch;

export type NetworkPluginOptions = {
	captureBody?: boolean;
	maxBodyBytes?: number;
	maxEvents?: number;
	maxStoreBytes?: number;
	patchGlobalFetch?: boolean;
	captureUnknownLengthBodies?: boolean;
	sourceLabel?: string;
	redactHeader?: (name: string, value: string) => string;
	redactUrl?: (url: string) => string;
	redactBody?: (body: string, context: NetworkBodyContext) => string;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
};

export type NetworkPlugin = {
	plugin: DevToolsPanelPlugin;
	instrumentFetch: (
		fetchImplementation: FetchImplementation,
	) => FetchImplementation;
	clear: () => void;
	pause: () => void;
	resume: () => void;
	isPaused: () => boolean;
	getEvents: () => readonly NetworkEvent[];
};

export type NetworkSegment = 'all' | 'supabase' | 'errors' | 'slow';

export type NetworkStatusTone = 'success' | 'danger' | 'warning' | 'info';

export type CollapsedNetworkEvent = {
	event: NetworkEvent;
	count: number;
};

const SLOW_REQUEST_MS = 1000;
const MAX_BODY_PREVIEW_BYTES = 32 * 1024;
/** Placeholders the collector writes in place of a captured secret. */
const REDACTED_VALUES = new Set(['[REDACTED]', '[REDACTION FAILED]']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
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
	const [hostname = '', portText = ''] = host.toLowerCase().split(':');
	return { hostname, port: Number(portText) };
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

export function isSupabaseNetworkEvent(event: NetworkEvent): boolean {
	const parsed = parseNetworkUrl(event.url);
	if (hostParts(parsed.host).hostname.includes('supabase')) return true;
	return SUPABASE_PATH_PREFIXES.some((prefix) =>
		parsed.pathname.startsWith(prefix),
	);
}

export function isFailedNetworkEvent(event: NetworkEvent): boolean {
	return (
		event.state === 'error' ||
		event.state === 'aborted' ||
		(event.status ?? 0) >= 400
	);
}

/**
 * Connectivity checks, Sentry ingest, and the Metro dev server are ambient
 * traffic the panel hides by default. Analytics such as PostHog stay visible
 * because the app sends them deliberately.
 */
export function isSystemNetworkEvent(event: NetworkEvent): boolean {
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
		(hostname === 'localhost' || hostname === '127.0.0.1') &&
		port >= 8081 &&
		port <= 8090
	) {
		return true;
	}
	return false;
}

export function matchesNetworkSegment(
	event: NetworkEvent,
	segment: NetworkSegment,
): boolean {
	if (segment === 'supabase') return isSupabaseNetworkEvent(event);
	if (segment === 'errors') return isFailedNetworkEvent(event);
	if (segment === 'slow') {
		return event.state !== 'pending' && event.durationMs >= SLOW_REQUEST_MS;
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

export function formatNetworkDuration(durationMs: number): string {
	if (!Number.isFinite(durationMs) || durationMs < 0) return '—';
	if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
	return `${(durationMs / 1000).toFixed(1)} s`;
}

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

function statusColor(tone: NetworkStatusTone) {
	if (tone === 'success') return PlatformColor('systemGreenColor');
	if (tone === 'danger') return PlatformColor('systemRedColor');
	if (tone === 'warning') return PlatformColor('systemOrangeColor');
	return PlatformColor('systemBlueColor');
}

const monoSmall = () => font({ design: 'monospaced', size: 12 });
const secondarySmall = () => [
	font({ size: 13 }),
	foregroundStyle(PlatformColor('secondaryLabelColor')),
];

function HeaderRows({
	entries,
}: {
	entries: ReadonlyArray<readonly [string, string]>;
}) {
	return (
		<>
			{entries.map(([name, value]) => (
				<LabeledContent key={name} label={name}>
					<UIText modifiers={[monoSmall()]}>{value}</UIText>
				</LabeledContent>
			))}
		</>
	);
}

function NetworkEventDetail({
	actions,
	event,
	listTitle,
	maxBodyBytes,
	onBack,
	pluginId,
}: {
	actions: DevToolsActionServices;
	event: NetworkEvent;
	listTitle: string;
	maxBodyBytes: number;
	onBack: () => void;
	pluginId: string;
}) {
	const { label } = networkEventLabel(event);
	const status = networkStatusPresentation(event);
	const path = networkRequestPath(event.url);
	const requestHeaderEntries = Object.entries(event.requestHeaders);
	const responseHeaderEntries = Object.entries(event.responseHeaders ?? {});
	// Pretty-printing can chew through 256 KB bodies; cache per event so live
	// capture ticks don't re-parse while the detail is open.
	const requestBody = useMemo(
		() =>
			event.requestBody === undefined
				? undefined
				: truncateText(
						prettyNetworkBody(event.requestBody),
						MAX_BODY_PREVIEW_BYTES,
					).text,
		[event],
	);
	const responseBody = useMemo(
		() =>
			event.responseBody === undefined
				? undefined
				: truncateText(
						prettyNetworkBody(event.responseBody),
						MAX_BODY_PREVIEW_BYTES,
					).text,
		[event],
	);
	const shareEvent = () => {
		void Share.share({
			title: `${event.method} ${path}`,
			message: serializeValue(event, 512 * 1024).text,
		}).catch(() => undefined);
	};
	// expo-clipboard is not a dependency; the share sheet's Copy action is the
	// sanctioned way to get text onto the pasteboard from here.
	const copyCurl = () => {
		void Share.share({ message: buildCurlCommand(event) }).catch(
			() => undefined,
		);
	};
	const resendRequest = () => {
		// The store only ever holds the redacted copy of a request, so a replay
		// cannot carry the original credentials. Drop the placeholder headers
		// instead of sending `Authorization: [REDACTED]` upstream, and say what
		// will actually leave the device before it does.
		const headers = Object.fromEntries(
			requestHeaderEntries.filter(([, value]) => !REDACTED_VALUES.has(value)),
		);
		const droppedHeaders =
			requestHeaderEntries.length - Object.keys(headers).length;
		void actions.run({
			pluginId,
			label: 'Re-send request',
			confirmation: {
				title: 'Re-send this request?',
				message: `A real ${event.method} goes to ${parseNetworkUrl(event.url).host}. Redacted values are never replayed${
					droppedHeaders > 0
						? ` (${droppedHeaders} header${droppedHeaders === 1 ? '' : 's'} dropped)`
						: ''
				}, so the response can differ from the captured one.`,
				confirmLabel: 'Re-send',
				destructive: MUTATING_METHODS.has(event.method),
			},
			action: async () => {
				const init: RequestInit = { method: event.method, headers };
				if (
					event.requestBody !== undefined &&
					event.method !== 'GET' &&
					event.method !== 'HEAD'
				) {
					init.body = event.requestBody;
				}
				// The instrumented global fetch captures the replay as a new event.
				await globalThis.fetch(event.url, init);
			},
		});
	};

	return (
		<PanelShell
			backLabel={listTitle}
			onBack={onBack}
			title={`${event.method} ${label}`}
			trailing={
				<NavIconButton
					accessibilityLabel="Share request"
					onPress={shareEvent}
					systemImage="square.and.arrow.up"
					testID="devtools-network-share"
				/>
			}
		>
			{Platform.OS === 'ios' ? (
				<Host style={{ flex: 1 }}>
					<List modifiers={[listStyle('insetGrouped')]}>
						<Section title="Overview">
							<LabeledContent label="Status">
								<UIText
									modifiers={[
										font({ design: 'monospaced', weight: 'semibold' }),
										foregroundStyle(statusColor(status.tone)),
									]}
								>
									{detailStatusText(event)}
								</UIText>
							</LabeledContent>
							<LabeledContent label="Duration">
								<UIText>
									{event.state === 'pending'
										? 'Pending'
										: formatNetworkDuration(event.durationMs)}
								</UIText>
							</LabeledContent>
							<LabeledContent label="Started">
								<UIText>{formatNetworkClock(event.startedAt)}</UIText>
							</LabeledContent>
							<LabeledContent label="Size">
								<UIText>{`↑ ${formatNetworkBytes(event.requestSizeBytes)} · ↓ ${formatNetworkBytes(event.responseSizeBytes)}`}</UIText>
							</LabeledContent>
							<LabeledContent label="Source">
								<UIText>{event.source}</UIText>
							</LabeledContent>
							{event.error ? (
								<LabeledContent label="Error">
									<UIText
										modifiers={[
											foregroundStyle(PlatformColor('systemRedColor')),
										]}
									>
										{event.error}
									</UIText>
								</LabeledContent>
							) : null}
						</Section>
						<Section title="Request">
							<VStack alignment="leading" spacing={3}>
								<UIText modifiers={secondarySmall()}>URL</UIText>
								<UIText modifiers={[monoSmall(), textSelection(true)]}>
									{path}
								</UIText>
							</VStack>
							<DisclosureGroup
								label={`Headers (${requestHeaderEntries.length})`}
							>
								<HeaderRows entries={requestHeaderEntries} />
							</DisclosureGroup>
							<LabeledContent label="Body">
								<UIText>
									{event.requestBody === undefined
										? 'Empty'
										: formatNetworkBytes(event.requestSizeBytes)}
								</UIText>
							</LabeledContent>
							{requestBody !== undefined ? (
								<UIText modifiers={[monoSmall(), textSelection(true)]}>
									{requestBody}
								</UIText>
							) : null}
						</Section>
						<Section
							footer={
								<UIText>
									{`Bodies over ${Math.round(maxBodyBytes / 1024)} KB are truncated at capture time.`}
								</UIText>
							}
							title="Response"
						>
							{responseHeaderEntries.length > 0 ? (
								<DisclosureGroup
									label={`Headers (${responseHeaderEntries.length})`}
								>
									<HeaderRows entries={responseHeaderEntries} />
								</DisclosureGroup>
							) : null}
							<LabeledContent label="Body">
								<UIText>{responseBodySummaryText(event)}</UIText>
							</LabeledContent>
							{responseBody !== undefined ? (
								<UIText modifiers={[monoSmall(), textSelection(true)]}>
									{responseBody}
								</UIText>
							) : null}
						</Section>
						<Section>
							<Button
								label="Copy as cURL"
								onPress={copyCurl}
								testID="devtools-network-copy-curl"
							/>
							<Button
								label="Re-send request"
								onPress={resendRequest}
								testID="devtools-network-resend"
							/>
							<Button
								label="Share…"
								onPress={shareEvent}
								testID="devtools-network-share-action"
							/>
						</Section>
					</List>
				</Host>
			) : (
				<AndroidPanelScroll>
					<AndroidPanelSection title="Overview">
						<AndroidPanelRow label="Status" value={detailStatusText(event)} />
						<AndroidPanelRow
							label="Duration"
							value={
								event.state === 'pending'
									? 'Pending'
									: formatNetworkDuration(event.durationMs)
							}
						/>
						<AndroidPanelRow
							label="Started"
							value={formatNetworkClock(event.startedAt)}
						/>
						<AndroidPanelRow
							label="Size"
							value={`↑ ${formatNetworkBytes(event.requestSizeBytes)} · ↓ ${formatNetworkBytes(event.responseSizeBytes)}`}
						/>
						<AndroidPanelRow label="Source" value={event.source} />
						{event.error ? (
							<AndroidPanelTextBlock
								label="Error"
								tone="danger"
								value={event.error}
							/>
						) : null}
					</AndroidPanelSection>
					<AndroidPanelSection title="Request">
						<AndroidPanelTextBlock label="URL" value={path} />
						<AndroidPanelRow
							label="Headers"
							value={String(requestHeaderEntries.length)}
						/>
						{requestHeaderEntries.map(([name, value]) => (
							<AndroidPanelTextBlock key={name} label={name} value={value} />
						))}
						<AndroidPanelRow
							label="Body"
							value={
								event.requestBody === undefined
									? 'Empty'
									: formatNetworkBytes(event.requestSizeBytes)
							}
						/>
						{requestBody !== undefined ? (
							<AndroidPanelTextBlock label="Payload" value={requestBody} />
						) : null}
					</AndroidPanelSection>
					<AndroidPanelSection
						title="Response"
						footer={`Bodies over ${Math.round(maxBodyBytes / 1024)} KB are truncated at capture time.`}
					>
						<AndroidPanelRow
							label="Headers"
							value={String(responseHeaderEntries.length)}
						/>
						{responseHeaderEntries.map(([name, value]) => (
							<AndroidPanelTextBlock key={name} label={name} value={value} />
						))}
						<AndroidPanelRow
							label="Body"
							value={responseBodySummaryText(event)}
						/>
						{responseBody !== undefined ? (
							<AndroidPanelTextBlock label="Payload" value={responseBody} />
						) : null}
					</AndroidPanelSection>
					<AndroidPanelSection title="Actions">
						<AndroidPanelRow label="Copy as cURL" onPress={copyCurl} />
						<AndroidPanelRow label="Re-send request" onPress={resendRequest} />
						<AndroidPanelRow label="Share…" onPress={shareEvent} />
					</AndroidPanelSection>
				</AndroidPanelScroll>
			)}
		</PanelShell>
	);
}

export function createNetworkPlugin(
	options: NetworkPluginOptions = {},
): NetworkPlugin {
	const captureBody = options.captureBody ?? false;
	const captureUnknownLengthBodies =
		options.captureUnknownLengthBodies ?? false;
	const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
	assertPositiveFinite(maxBodyBytes, 'maxBodyBytes');
	const redactHeader = options.redactHeader ?? defaultRedactHeader;
	const redactUrl = options.redactUrl ?? defaultRedactUrl;
	const redactBody = options.redactBody ?? defaultRedactBody;
	const title = options.title ?? 'Network';
	const pluginId = options.id ?? 'network';
	const source =
		options.sourceLabel ??
		(options.patchGlobalFetch ? 'Global fetch' : 'Instrumented fetch');
	const store = new BoundedEventStore<NetworkEvent>({
		maxEvents: options.maxEvents ?? 200,
		maxBytes: options.maxStoreBytes ?? 8 * 1024 * 1024,
		estimateBytes: (event) =>
			serializeValue(event, Number.MAX_SAFE_INTEGER).estimatedBytes,
	});
	const pausedStore = new ExternalStore(false);
	let installCount = 0;
	let nextEventId = 1;
	let originalGlobalFetch: FetchImplementation | undefined;
	let installedGlobalFetch: FetchImplementation | undefined;

	const redactCapturedBody = (
		body: string | undefined,
		context: NetworkBodyContext,
	): string | undefined => {
		if (body === undefined) return undefined;
		try {
			return redactBody(body, context);
		} catch {
			return '[Body omitted: redaction failed]';
		}
	};
	const redactCapturedUrl = (url: string): string => {
		try {
			return redactUrl(url);
		} catch {
			return '[URL omitted: redaction failed]';
		}
	};

	const instrumentFetch = (
		fetchImplementation: FetchImplementation,
	): FetchImplementation => {
		const wrappedFetch: FetchImplementation = async (input, init) => {
			if (installCount === 0 || pausedStore.getSnapshot()) {
				return fetchImplementation(input, init);
			}

			const id = nextEventId++;
			const startedAt = Date.now();
			const startedAtMs = globalThis.performance?.now?.() ?? startedAt;
			const rawUrl = requestUrl(input);
			const url = redactCapturedUrl(rawUrl);
			const method = requestMethod(input, init);
			const capturedRequestHeaders = requestHeaders(input, init, redactHeader);
			const requestContentType =
				capturedRequestHeaders['content-type'] ??
				capturedRequestHeaders['Content-Type'];
			const requestBodyPromise = captureBody
				? captureRequestBody(input, init, maxBodyBytes).then((body) =>
						redactCapturedBody(body, {
							direction: 'request',
							contentType: requestContentType,
							url,
						}),
					)
				: Promise.resolve(undefined);
			store.append({
				id,
				startedAt,
				method,
				url,
				state: 'pending',
				durationMs: 0,
				requestHeaders: capturedRequestHeaders,
				source,
			});

			try {
				const response = await fetchImplementation(input, init);
				const durationMs =
					(globalThis.performance?.now?.() ?? Date.now()) - startedAtMs;
				const contentType = response.headers.get('content-type') ?? undefined;
				void Promise.all([
					requestBodyPromise,
					captureBody
						? captureResponseBody(
								response,
								maxBodyBytes,
								captureUnknownLengthBodies,
							)
						: Promise.resolve<{
								body?: string;
								capturedBytes?: number;
							}>({}),
				]).then(([requestBody, capturedResponse]) => {
					const responseBody = redactCapturedBody(capturedResponse.body, {
						direction: 'response',
						contentType,
						url,
					});
					const responseLength = parseContentLength(
						response.headers.get('content-length'),
					);
					store.replace((event) => event.id === id, {
						id,
						startedAt,
						method,
						url,
						state: 'success',
						status: response.status,
						durationMs,
						requestHeaders: capturedRequestHeaders,
						requestBody,
						responseHeaders: headersRecord(response.headers, redactHeader),
						responseBody,
						contentType,
						source,
						requestSizeBytes: textBytes(requestBody),
						responseSizeBytes:
							responseLength !== undefined
								? responseLength
								: capturedResponse.capturedBytes,
					});
				});
				return response;
			} catch (error) {
				const durationMs =
					(globalThis.performance?.now?.() ?? Date.now()) - startedAtMs;
				void requestBodyPromise.then((requestBody) => {
					const aborted = error instanceof Error && error.name === 'AbortError';
					store.replace((event) => event.id === id, {
						id,
						startedAt,
						method,
						url,
						state: aborted ? 'aborted' : 'error',
						durationMs,
						requestHeaders: capturedRequestHeaders,
						requestBody,
						error: error instanceof Error ? error.message : String(error),
						source,
						requestSizeBytes: textBytes(requestBody),
					});
				});
				throw error;
			}
		};
		return wrappedFetch;
	};

	function NetworkPanel({
		actions,
		onBack,
	}: {
		actions: DevToolsActionServices;
		onBack: () => void;
	}) {
		const events = useSyncExternalStore(
			store.subscribe,
			store.getSnapshot,
			store.getServerSnapshot,
		);
		const paused = useSyncExternalStore(
			pausedStore.subscribe,
			pausedStore.getSnapshot,
			pausedStore.getServerSnapshot,
		);
		const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
		const [search, setSearch] = useState('');
		const [segment, setSegment] = useState<NetworkSegment>('all');
		const [hideSystemTraffic, setHideSystemTraffic] = useState(true);

		// URL parsing per event is the hot path here; recompute only when the
		// inputs actually change instead of on every render. Hooks stay above
		// the detail early-return.
		const { systemCount, rows, summary } = useMemo(() => {
			const needle = search.trim().toLowerCase();
			const matching = [...events]
				.reverse()
				.filter(
					(candidate) =>
						matchesNetworkSegment(candidate, segment) &&
						matchesNetworkSearch(candidate, needle),
				);
			const systemEvents: NetworkEvent[] = [];
			const appEvents: NetworkEvent[] = [];
			for (const candidate of matching) {
				(isSystemNetworkEvent(candidate) ? systemEvents : appEvents).push(
					candidate,
				);
			}
			const visibleEvents = hideSystemTraffic ? appEvents : matching;
			return {
				systemCount: systemEvents.length,
				rows: collapseNetworkEvents(visibleEvents),
				summary: summarizeNetworkEvents(visibleEvents, Date.now()),
			};
		}, [events, search, segment, hideSystemTraffic]);

		// The search field is native-owned and unmounts with the list, so a query
		// that outlived it would filter the list behind an empty search box.
		const openEvent = (eventId: number) => {
			setSearch('');
			setSelectedEventId(eventId);
		};

		const selectedEvent =
			selectedEventId === null
				? undefined
				: events.find((event) => event.id === selectedEventId);
		if (selectedEvent) {
			return (
				<NetworkEventDetail
					actions={actions}
					event={selectedEvent}
					listTitle={title}
					maxBodyBytes={maxBodyBytes}
					onBack={() => setSelectedEventId(null)}
					pluginId={pluginId}
				/>
			);
		}
		const headerText = paused ? `Paused · ${summary}` : summary;
		const clearRequests = () => {
			void actions.run({
				pluginId,
				label: 'Clear requests',
				confirmation: {
					title: 'Clear captured requests?',
					message: 'Removes all captured requests from this session.',
					confirmLabel: 'Clear',
					destructive: true,
				},
				action: store.clear,
			});
		};

		return (
			<PanelShell
				onBack={onBack}
				title={title}
				trailing={
					<>
						<NavIconButton
							accessibilityLabel={paused ? 'Resume capture' : 'Pause capture'}
							onPress={() => pausedStore.set(!paused)}
							systemImage={paused ? 'play.fill' : 'pause.fill'}
							testID="devtools-network-pause"
						/>
						<NavIconButton
							accessibilityLabel="Clear requests"
							destructive
							onPress={clearRequests}
							systemImage="trash"
							testID="devtools-network-clear"
						/>
					</>
				}
			>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							<Section>
								<TextField
									modifiers={[autocorrectionDisabled()]}
									onTextChange={setSearch}
									placeholder="Search URL, table, or status"
									testID="devtools-network-search"
								/>
								<Picker
									modifiers={[pickerStyle('segmented')]}
									onSelectionChange={(value) => setSegment(value)}
									selection={segment}
									testID="devtools-network-filter"
								>
									<UIText modifiers={[tag('all')]}>All</UIText>
									<UIText modifiers={[tag('supabase')]}>Supabase</UIText>
									<UIText modifiers={[tag('errors')]}>Errors</UIText>
									<UIText modifiers={[tag('slow')]}>Slow</UIText>
								</Picker>
							</Section>
							{rows.length === 0 ? (
								<Section>
									<ContentUnavailableView
										description={
											events.length === 0
												? 'Captured requests will appear here.'
												: 'No requests match the current filters.'
										}
										systemImage="network"
										testID="devtools-network-empty"
										title={events.length === 0 ? 'No requests' : 'No matches'}
									/>
								</Section>
							) : (
								<Section title={headerText}>
									{rows.map(({ event, count }) => {
										const status = networkStatusPresentation(event);
										const rowModifiers =
											count > 1
												? [buttonStyle('plain'), badge(`×${count}`)]
												: [buttonStyle('plain')];
										return (
											<Button
												key={event.id}
												modifiers={rowModifiers}
												onPress={() => openEvent(event.id)}
												testID={`devtools-network-row-${event.id}`}
											>
												<HStack alignment="center" spacing={12}>
													<UIText
														modifiers={[
															font({
																design: 'monospaced',
																size: 13,
																weight: 'semibold',
															}),
															foregroundStyle(statusColor(status.tone)),
															frame({ minWidth: 36, alignment: 'leading' }),
														]}
													>
														{status.text}
													</UIText>
													<VStack alignment="leading" spacing={2}>
														<HStack alignment="firstTextBaseline" spacing={5}>
															<UIText
																modifiers={[
																	font({
																		design: 'monospaced',
																		size: 15,
																		weight: 'bold',
																	}),
																	foregroundStyle(PlatformColor('labelColor')),
																]}
															>
																{event.method}
															</UIText>
															<UIText
																modifiers={[
																	foregroundStyle(PlatformColor('labelColor')),
																]}
															>
																{networkEventLabel(event).label}
															</UIText>
														</HStack>
														<UIText modifiers={secondarySmall()}>
															{networkRowSubtitle(event)}
														</UIText>
													</VStack>
													<Spacer />
													<Image
														color={PlatformColor('tertiaryLabelColor')}
														size={12}
														systemName="chevron.right"
													/>
												</HStack>
											</Button>
										);
									})}
								</Section>
							)}
							<Section>
								<Toggle
									isOn={hideSystemTraffic}
									onIsOnChange={setHideSystemTraffic}
									testID="devtools-network-hide-system"
								>
									<UIText>Hide system traffic</UIText>
									<UIText>
										{hideSystemTraffic
											? `${systemCount} hidden`
											: `${systemCount} shown`}
									</UIText>
								</Toggle>
							</Section>
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						<AndroidPanelSearch
							onChangeText={setSearch}
							placeholder="Search URL, table, or status"
							value={search}
						/>
						<AndroidPanelTabs
							onSelect={setSegment}
							options={[
								{ label: 'All', value: 'all' },
								{ label: 'Supabase', value: 'supabase' },
								{ label: 'Errors', value: 'errors' },
								{ label: 'Slow', value: 'slow' },
							]}
							selected={segment}
						/>
						<AndroidPanelSection title={headerText}>
							{rows.length === 0 ? (
								<AndroidPanelRow
									label={events.length === 0 ? 'No requests' : 'No matches'}
									detail="Captured app requests appear here."
								/>
							) : (
								rows.map(({ event, count }) => {
									const status = networkStatusPresentation(event);
									return (
										<AndroidPanelRow
											key={event.id}
											label={`${event.method} ${networkEventLabel(event).label}`}
											detail={networkRowSubtitle(event)}
											onPress={() => openEvent(event.id)}
											tone={status.tone === 'info' ? 'default' : status.tone}
											value={`${status.text}${count > 1 ? ` ×${count}` : ''}`}
										/>
									);
								})
							)}
						</AndroidPanelSection>
						<AndroidPanelSection>
							<AndroidPanelRow
								label={
									hideSystemTraffic
										? 'Show system traffic'
										: 'Hide system traffic'
								}
								detail={`${systemCount} system request${systemCount === 1 ? '' : 's'}`}
								onPress={() => setHideSystemTraffic((hidden) => !hidden)}
							/>
						</AndroidPanelSection>
					</AndroidPanelScroll>
				)}
			</PanelShell>
		);
	}

	const plugin: DevToolsPanelPlugin = {
		id: pluginId,
		title,
		description:
			options.description ??
			(options.patchGlobalFetch
				? 'Requests made through global and explicit fetch clients'
				: 'Requests made through explicit fetch clients'),
		systemImage: options.systemImage ?? 'network',
		section: options.section,
		Panel: NetworkPanel,
		install: () => {
			installCount += 1;
			if (
				installCount === 1 &&
				options.patchGlobalFetch &&
				typeof globalThis.fetch === 'function'
			) {
				originalGlobalFetch = globalThis.fetch;
				installedGlobalFetch = instrumentFetch(originalGlobalFetch);
				globalThis.fetch = installedGlobalFetch;
			}
			return () => {
				installCount = Math.max(0, installCount - 1);
				if (installCount === 0 && installedGlobalFetch) {
					if (
						globalThis.fetch === installedGlobalFetch &&
						originalGlobalFetch
					) {
						globalThis.fetch = originalGlobalFetch;
					}
					installedGlobalFetch = undefined;
					originalGlobalFetch = undefined;
				}
			};
		},
	};

	return {
		plugin,
		clear: store.clear,
		getEvents: store.getSnapshot,
		instrumentFetch,
		isPaused: pausedStore.getSnapshot,
		pause: () => pausedStore.set(true),
		resume: () => pausedStore.set(false),
	};
}
