import { useMemo, useState, useSyncExternalStore } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import {
	PanelButton,
	PanelSearchField,
	PanelSegmentedControl,
	PanelToolbar,
} from '../components/panel-controls';
import {
	CodeBlock,
	colors,
	DisclosureCard,
	EmptyState,
	PanelList,
	PanelMetricStrip,
	PanelScaffold,
	PanelSignalCard,
	PanelStatusBadge,
} from '../components/panel-ui';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { assertPositiveFinite } from '../core/options';
import { serializeValue } from '../core/serialize';
import type { DevToolsPanelPlugin, DevToolsSystemImage } from '../types';
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

function NetworkEventCard({ event }: { event: NetworkEvent }) {
	const parsedUrl = parseNetworkUrl(event.url);
	const endpoint =
		parsedUrl.pathname.split('/').filter(Boolean).at(-1) ||
		parsedUrl.host ||
		parsedUrl.path;
	const status = event.status ?? event.state.toUpperCase();
	const statusTone =
		event.state === 'pending'
			? 'info'
			: event.state !== 'success'
				? 'danger'
				: (event.status ?? 0) >= 400
					? 'warning'
					: 'success';
	return (
		<DisclosureCard
			leading={<PanelStatusBadge label={String(status)} tone={statusTone} />}
			title={`${event.method} · ${endpoint}`}
			subtitle={`${parsedUrl.host || parsedUrl.path} · ${Math.round(event.durationMs)} ms · ${event.source}`}
			renderDetails={() => (
				<>
					<PanelToolbar>
						<PanelButton
							label="Share request"
							onPress={() => {
								void Share.share({
									title: `${event.method} ${parsedUrl.path}`,
									message: serializeValue(event, 512 * 1024).text,
								}).catch(() => undefined);
							}}
						/>
					</PanelToolbar>
					<View style={styles.detailGrid}>
						{[
							['Duration', `${Math.round(event.durationMs)} ms`],
							['Source', event.source],
							['Request', formatNetworkBytes(event.requestSizeBytes)],
							['Response', formatNetworkBytes(event.responseSizeBytes)],
						].map(([label, value]) => (
							<View key={label} style={styles.detailMetric}>
								<Text style={styles.detailLabel}>{label}</Text>
								<Text style={styles.detailValue}>{value}</Text>
							</View>
						))}
					</View>
					<View style={styles.detailSection}>
						<Text style={styles.detailTitle}>URL</Text>
						<CodeBlock>{parsedUrl.path}</CodeBlock>
					</View>
					{Object.keys(parsedUrl.query).length ? (
						<View style={styles.detailSection}>
							<Text style={styles.detailTitle}>Query parameters</Text>
							<CodeBlock>
								{serializeValue(parsedUrl.query, 64 * 1024).text}
							</CodeBlock>
						</View>
					) : null}
					<View style={styles.detailSection}>
						<Text style={styles.detailTitle}>Request headers</Text>
						<CodeBlock>
							{serializeValue(event.requestHeaders, 128 * 1024).text}
						</CodeBlock>
					</View>
					{event.requestBody !== undefined ? (
						<View style={styles.detailSection}>
							<Text style={styles.detailTitle}>Request body</Text>
							<CodeBlock>{event.requestBody}</CodeBlock>
						</View>
					) : null}
					{event.responseHeaders ? (
						<View style={styles.detailSection}>
							<Text style={styles.detailTitle}>Response headers</Text>
							<CodeBlock>
								{serializeValue(event.responseHeaders, 128 * 1024).text}
							</CodeBlock>
						</View>
					) : null}
					{event.responseBody !== undefined ? (
						<View style={styles.detailSection}>
							<Text style={styles.detailTitle}>Response body</Text>
							<CodeBlock>{event.responseBody}</CodeBlock>
						</View>
					) : null}
					{event.error ? (
						<View style={styles.detailSection}>
							<Text style={[styles.detailTitle, { color: colors.red }]}>
								Error
							</Text>
							<CodeBlock>{event.error}</CodeBlock>
						</View>
					) : null}
				</>
			)}
		/>
	);
}

type NetworkFilter = 'all' | 'pending' | 'errors' | 'success';

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

	function NetworkPanel({ onBack }: { onBack: () => void }) {
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
		const [search, setSearch] = useState('');
		const [filter, setFilter] = useState<NetworkFilter>('all');
		const visibleEvents = useMemo(() => {
			const needle = search.trim().toLowerCase();
			return [...events].reverse().filter((event) => {
				if (filter === 'pending' && event.state !== 'pending') return false;
				if (
					filter === 'errors' &&
					event.state !== 'error' &&
					event.state !== 'aborted' &&
					(event.status ?? 0) < 400
				) {
					return false;
				}
				if (
					filter === 'success' &&
					(event.state !== 'success' || (event.status ?? 0) >= 400)
				) {
					return false;
				}
				return (
					!needle ||
					event.url.toLowerCase().includes(needle) ||
					event.method.toLowerCase().includes(needle) ||
					String(event.status ?? '').includes(needle)
				);
			});
		}, [events, filter, search]);
		const pendingCount = events.filter(
			(event) => event.state === 'pending',
		).length;
		const errorCount = events.filter(
			(event) =>
				event.state === 'error' ||
				event.state === 'aborted' ||
				(event.status ?? 0) >= 400,
		).length;
		const successCount = events.filter(
			(event) => event.state === 'success' && (event.status ?? 0) < 400,
		).length;

		return (
			<PanelScaffold
				onBack={onBack}
				scrollable={false}
				title={title}
				subtitle={`${events.length} recent requests${paused ? ' · paused' : ''}`}
			>
				<PanelList
					data={visibleEvents}
					empty={
						<EmptyState>
							{events.length === 0
								? 'Captured requests will appear here.'
								: 'No requests match the current filters.'}
						</EmptyState>
					}
					header={
						<>
							<PanelSignalCard
								description={
									paused
										? `${events.length} requests remain available while new traffic is ignored.`
										: `${visibleEvents.length} of ${events.length} captured requests are visible.`
								}
								eyebrow="Capture status"
								systemImage={
									paused
										? 'pause.circle.fill'
										: errorCount > 0
											? 'exclamationmark.triangle.fill'
											: events.length > 0
												? 'checkmark.circle.fill'
												: 'network'
								}
								title={
									paused
										? 'Capture is paused'
										: errorCount > 0
											? `${errorCount} request${errorCount === 1 ? '' : 's'} need attention`
											: events.length > 0
												? 'Traffic looks healthy'
												: 'Waiting for app traffic'
								}
								tone={
									paused ? 'warning' : errorCount > 0 ? 'danger' : 'success'
								}
							/>
							<PanelMetricStrip
								metrics={[
									{ label: 'Total', value: events.length },
									{ label: 'Pending', value: pendingCount, tone: colors.blue },
									{ label: 'Success', value: successCount, tone: colors.green },
									{ label: 'Errors', value: errorCount, tone: colors.red },
								]}
							/>
							<PanelSearchField
								onChangeText={setSearch}
								placeholder="Search URL, method, or status"
								value={search}
							/>
							<PanelSegmentedControl
								accessibilityLabel="Network request filter"
								onChange={setFilter}
								options={(['all', 'pending', 'errors', 'success'] as const).map(
									(value) => ({
										id: value,
										label: value.charAt(0).toUpperCase() + value.slice(1),
									}),
								)}
								selected={filter}
							/>
							<PanelToolbar>
								<PanelButton
									label={paused ? 'Resume' : 'Pause'}
									onPress={() => pausedStore.set(!paused)}
								/>
								<PanelButton
									label="Clear"
									onPress={store.clear}
									tone="danger"
								/>
							</PanelToolbar>
						</>
					}
					keyExtractor={(event) => String(event.id)}
					renderItem={({ item }) => <NetworkEventCard event={item} />}
				/>
			</PanelScaffold>
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

const styles = StyleSheet.create({
	detailGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
	detailMetric: {
		backgroundColor: colors.groupedFill,
		borderColor: colors.separator,
		borderRadius: 8,
		borderWidth: StyleSheet.hairlineWidth,
		minWidth: '46%',
		padding: 10,
	},
	detailLabel: { color: colors.secondaryLabel, fontSize: 10, marginBottom: 3 },
	detailValue: { color: colors.label, fontSize: 13, fontWeight: '600' },
	detailSection: {
		borderTopColor: colors.separator,
		borderTopWidth: StyleSheet.hairlineWidth,
		gap: 8,
		marginTop: 12,
		paddingTop: 12,
	},
	detailTitle: { color: colors.label, fontSize: 13, fontWeight: '600' },
});
