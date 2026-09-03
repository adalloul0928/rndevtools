import {
	Button,
	ContentUnavailableView,
	Host,
	HStack,
	Image,
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
} from '@expo/ui/swift-ui/modifiers';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSearch,
	AndroidPanelSection,
	AndroidPanelTabs,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { assertPositiveFinite, assertPositiveInteger } from '../core/options';
import { diagnosticErrorText, redactDiagnosticText } from '../core/redact';
import { createRefCountedInstaller } from '../core/ref-counted-installer';
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
	headersRecord,
	type NetworkBodyContext,
	type NetworkEvent,
	parseContentLength,
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
type FetchLayer = (base: FetchImplementation) => FetchImplementation;

const globalFetchLayers = new Map<symbol, FetchLayer>();
let globalFetchBase: FetchImplementation | undefined;
let installedGlobalFetch: FetchImplementation | undefined;

function rebuildGlobalFetch(): void {
	if (!globalFetchBase) return;
	let next = globalFetchBase;
	for (const layer of globalFetchLayers.values()) next = layer(next);
	globalThis.fetch = next;
	installedGlobalFetch = next;
}

/** Installs composable fetch instrumentation without leaking middle wrappers. */
function installGlobalFetchLayer(layer: FetchLayer): () => void {
	if (typeof globalThis.fetch !== 'function') return () => {};
	if (globalFetchLayers.size > 0 && globalThis.fetch !== installedGlobalFetch) {
		throw new Error('Global fetch changed while diagnostics were installed.');
	}
	const previousBase = globalFetchBase;
	const previousInstalled = installedGlobalFetch;
	if (globalFetchLayers.size === 0) globalFetchBase = globalThis.fetch;
	const token = Symbol('devtools-fetch-layer');
	globalFetchLayers.set(token, layer);
	try {
		rebuildGlobalFetch();
	} catch (error) {
		globalFetchLayers.delete(token);
		globalFetchBase = previousBase;
		installedGlobalFetch = previousInstalled;
		throw error;
	}
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		globalFetchLayers.delete(token);
		try {
			if (globalThis.fetch === installedGlobalFetch) {
				if (globalFetchLayers.size > 0) rebuildGlobalFetch();
				else if (globalFetchBase) globalThis.fetch = globalFetchBase;
			}
		} finally {
			if (globalFetchLayers.size === 0) {
				globalFetchBase = undefined;
				installedGlobalFetch = undefined;
			}
		}
	};
}

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

import {
	NetworkEventDetail,
	secondarySmall,
	statusColor,
} from './network-detail';
import {
	collapseNetworkEvents,
	isSystemNetworkEvent,
	MAX_NETWORK_BODY_BYTES,
	MAX_NETWORK_EVENTS,
	MAX_NETWORK_STORE_BYTES,
	matchesNetworkSearch,
	matchesNetworkSegment,
	type NetworkSegment,
	networkEventLabel,
	networkRowSubtitle,
	networkStatusPresentation,
	summarizeNetworkEvents,
} from './network-presentation';

export * from './network-presentation';

export function createNetworkPlugin(
	options: NetworkPluginOptions = {},
): NetworkPlugin {
	const captureBody = options.captureBody ?? false;
	const captureUnknownLengthBodies =
		options.captureUnknownLengthBodies ?? false;
	const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
	assertPositiveFinite(maxBodyBytes, 'maxBodyBytes');
	const maxEvents = options.maxEvents ?? 200;
	const maxStoreBytes = options.maxStoreBytes ?? 8 * 1024 * 1024;
	assertPositiveInteger(maxEvents, 'maxEvents');
	assertPositiveFinite(maxStoreBytes, 'maxStoreBytes');
	if (maxBodyBytes > MAX_NETWORK_BODY_BYTES) {
		throw new Error(`maxBodyBytes cannot exceed ${MAX_NETWORK_BODY_BYTES}`);
	}
	if (maxEvents > MAX_NETWORK_EVENTS) {
		throw new Error(`maxEvents cannot exceed ${MAX_NETWORK_EVENTS}`);
	}
	if (maxStoreBytes > MAX_NETWORK_STORE_BYTES) {
		throw new Error(`maxStoreBytes cannot exceed ${MAX_NETWORK_STORE_BYTES}`);
	}
	const redactHeader = options.redactHeader ?? defaultRedactHeader;
	const redactUrl = options.redactUrl ?? defaultRedactUrl;
	const redactBody = options.redactBody ?? defaultRedactBody;
	const title = options.title ?? 'Network';
	const pluginId = options.id ?? 'network';
	const source = truncateText(
		redactDiagnosticText(
			options.sourceLabel ??
				(options.patchGlobalFetch ? 'Global fetch' : 'Instrumented fetch'),
		),
		4 * 1024,
	).text;
	const store = new BoundedEventStore<NetworkEvent>({
		maxEvents,
		maxBytes: maxStoreBytes,
		estimateBytes: (event) =>
			serializeValue(event, Number.MAX_SAFE_INTEGER).estimatedBytes,
	});
	const pausedStore = new ExternalStore(false);
	let collectorActive = false;
	let collectorGeneration = 0;
	let nextEventId = 1;

	const redactCapturedBody = (
		body: string | undefined,
		context: NetworkBodyContext,
	): string | undefined => {
		if (body === undefined) return undefined;
		try {
			const redacted = redactBody(body, context);
			if (typeof redacted !== 'string') {
				return '[Body omitted: invalid redaction result]';
			}
			return truncateText(redactDiagnosticText(redacted), maxBodyBytes).text;
		} catch {
			return '[Body omitted: redaction failed]';
		}
	};
	const redactCapturedUrl = (url: string): string => {
		if (url === '[URL unavailable]') return url;
		try {
			const redacted = redactUrl(url);
			return typeof redacted === 'string'
				? truncateText(redactDiagnosticText(redacted), 16 * 1024).text
				: '[URL omitted: invalid redaction result]';
		} catch {
			return '[URL omitted: redaction failed]';
		}
	};

	const instrumentFetch = (
		fetchImplementation: FetchImplementation,
	): FetchImplementation => {
		const wrappedFetch: FetchImplementation = async (input, init) => {
			if (!collectorActive || pausedStore.getSnapshot()) {
				return fetchImplementation(input, init);
			}
			const generation = collectorGeneration;

			const id = nextEventId++;
			const startedAt = Date.now();
			const monotonicNow = (): number => {
				try {
					const value = globalThis.performance?.now?.();
					if (typeof value === 'number' && Number.isFinite(value)) return value;
				} catch {
					// A replaced performance implementation cannot break app requests.
				}
				return Date.now();
			};
			const startedAtMs = monotonicNow();
			let rawUrl = '[URL unavailable]';
			let method = 'GET';
			let capturedRequestHeaders: Record<string, string> = Object.create(null);
			try {
				rawUrl = requestUrl(input);
			} catch {
				// Continue the real fetch even when its diagnostic projection is hostile.
			}
			try {
				method = requestMethod(input, init).slice(0, 16) || 'GET';
			} catch {
				// The underlying fetch remains the authority for invalid inputs.
			}
			try {
				capturedRequestHeaders = requestHeaders(input, init, redactHeader);
			} catch {
				// Header capture is optional and must not change fetch behavior.
			}
			const url = redactCapturedUrl(rawUrl);
			const requestContentType =
				capturedRequestHeaders['content-type'] ??
				capturedRequestHeaders['Content-Type'];
			const requestBodyPromise: Promise<string | undefined> = captureBody
				? captureRequestBody(
						input,
						init,
						maxBodyBytes,
						captureUnknownLengthBodies,
					)
						.then((body) =>
							redactCapturedBody(body, {
								direction: 'request',
								contentType: requestContentType,
								url,
							}),
						)
						.catch(() => '[Body omitted: diagnostics capture failed]')
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
				const durationMs = Math.max(0, monotonicNow() - startedAtMs);
				let contentType: string | undefined;
				let responseLength: number | undefined;
				let responseStatus: number | undefined;
				let responseHeaders: Record<string, string> = Object.create(null);
				try {
					contentType = response.headers.get('content-type') ?? undefined;
					responseLength = parseContentLength(
						response.headers.get('content-length'),
					);
					responseHeaders = headersRecord(response.headers, redactHeader);
					responseStatus =
						typeof response.status === 'number' &&
						Number.isInteger(response.status) &&
						response.status >= 0 &&
						response.status <= 999
							? response.status
							: undefined;
				} catch {
					// A non-standard response remains usable even if it cannot be inspected.
				}
				const responseBodyPromise: Promise<{
					body?: string;
					capturedBytes?: number;
				}> = captureBody
					? captureResponseBody(
							response,
							maxBodyBytes,
							captureUnknownLengthBodies,
						).catch(() => ({
							body: '[Body omitted: diagnostics capture failed]',
						}))
					: Promise.resolve<{ body?: string; capturedBytes?: number }>({});
				void Promise.all([requestBodyPromise, responseBodyPromise])
					.then(([requestBody, capturedResponse]) => {
						if (!collectorActive || generation !== collectorGeneration) return;
						const responseBody = redactCapturedBody(capturedResponse.body, {
							direction: 'response',
							contentType,
							url,
						});
						store.replace((event) => event.id === id, {
							id,
							startedAt,
							method,
							url,
							state: 'success',
							status: responseStatus,
							durationMs,
							requestHeaders: capturedRequestHeaders,
							requestBody,
							responseHeaders,
							responseBody,
							contentType,
							source,
							requestSizeBytes: textBytes(requestBody),
							responseSizeBytes:
								responseLength !== undefined
									? responseLength
									: capturedResponse.capturedBytes,
						});
					})
					.catch(() => undefined);
				return response;
			} catch (error) {
				const durationMs = Math.max(0, monotonicNow() - startedAtMs);
				let aborted = false;
				try {
					aborted = error instanceof Error && error.name === 'AbortError';
				} catch {
					// Hostile thrown values are ordinary request errors.
				}
				const errorText = redactCapturedBody(diagnosticErrorText(error), {
					direction: 'response',
					contentType: 'text/plain',
					url,
				});
				void requestBodyPromise
					.then((requestBody) => {
						if (!collectorActive || generation !== collectorGeneration) return;
						store.replace((event) => event.id === id, {
							id,
							startedAt,
							method,
							url,
							state: aborted ? 'aborted' : 'error',
							durationMs,
							requestHeaders: capturedRequestHeaders,
							requestBody,
							error: errorText,
							source,
							requestSizeBytes: textBytes(requestBody),
						});
					})
					.catch(() => undefined);
				throw error;
			}
		};
		return wrappedFetch;
	};
	const install = createRefCountedInstaller(({ addCleanup }) => {
		collectorGeneration += 1;
		collectorActive = true;
		addCleanup(() => {
			const stoppedAt = Date.now();
			for (const event of store.getSnapshot()) {
				if (event.state !== 'pending') continue;
				store.replace((candidate) => candidate.id === event.id, {
					...event,
					state: 'aborted',
					durationMs: Math.max(0, stoppedAt - event.startedAt),
					error: '[Capture stopped before response]',
				});
			}
			collectorActive = false;
			collectorGeneration += 1;
		});
		if (!options.patchGlobalFetch || typeof globalThis.fetch !== 'function') {
			return;
		}
		addCleanup(installGlobalFetchLayer(instrumentFetch));
	});

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
		install,
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
