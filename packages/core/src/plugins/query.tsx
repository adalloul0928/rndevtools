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
	SwipeActions,
	TextField,
	Text as UIText,
	VStack,
} from '@expo/ui/swift-ui';
import {
	autocorrectionDisabled,
	badge,
	font,
	foregroundColor,
	listStyle,
	pickerStyle,
	tag,
	tint,
} from '@expo/ui/swift-ui/modifiers';
import type { QueryClient } from '@tanstack/react-query';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { iosColor, PanelShell } from '../components/panel-shell';
import { ExternalStore } from '../core/external-store';
import { assertPositiveFinite, assertPositiveInteger } from '../core/options';
import { serializeValue } from '../core/serialize';
import type {
	DevToolsActionConfirmation,
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';
import {
	createMutationSnapshot,
	createQuerySnapshot,
	limitQuerySnapshotsByBytes,
	type MutationSnapshot,
	type QueryPluginSnapshot,
	type QuerySnapshot,
} from './query-model';

export type {
	MutationSnapshot,
	QueryPluginSnapshot,
	QuerySnapshot,
} from './query-model';
export {
	createMutationSnapshot,
	createQuerySnapshot,
} from './query-model';

export type QueryPluginOptions = {
	queryClient: QueryClient;
	captureData?: boolean;
	maxQueries?: number;
	maxMutations?: number;
	maxSnapshotBytes?: number;
	maxStoreBytes?: number;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
	tint?: string;
};

export type QueryPlugin = DevToolsPanelPlugin & {
	refresh: () => void;
	getSnapshot: () => QueryPluginSnapshot;
};

type InspectorTab = 'queries' | 'mutations';
type QueryStatusKind = 'error' | 'fetching' | 'stale' | 'fresh';
type RunQueryAction = (
	label: string,
	action: () => unknown | Promise<unknown>,
	confirmation?: DevToolsActionConfirmation,
) => void;

const palette = {
	blue: iosColor('systemBlueColor', '#007AFF'),
	gray: iosColor('systemGrayColor', '#8E8E93'),
	green: iosColor('systemGreenColor', '#34C759'),
	orange: iosColor('systemOrangeColor', '#FF9500'),
	red: iosColor('systemRedColor', '#FF3B30'),
	secondary: iosColor('secondaryLabelColor', 'rgba(60,60,67,0.6)'),
};

const statusDotColors = {
	error: palette.red,
	fetching: palette.blue,
	fresh: palette.green,
	stale: palette.orange,
};

const statusLabels: Record<QueryStatusKind, string> = {
	error: 'error',
	fetching: 'fetching…',
	fresh: 'fresh',
	stale: 'stale',
};

function queryStatusKind(
	query: Pick<QuerySnapshot, 'fetchStatus' | 'isStale' | 'status'>,
): QueryStatusKind {
	if (query.status === 'error') return 'error';
	if (query.fetchStatus === 'fetching' || query.status === 'pending') {
		return 'fetching';
	}
	if (query.isStale) return 'stale';
	return 'fresh';
}

function mutationDotColor(status: string) {
	if (status === 'error') return palette.red;
	if (status === 'pending') return palette.blue;
	if (status === 'success') return palette.green;
	return palette.gray;
}

function formatQueryKeySegment(part: unknown): string {
	if (typeof part === 'string') return part;
	if (
		typeof part === 'number' ||
		typeof part === 'boolean' ||
		typeof part === 'bigint'
	) {
		return String(part);
	}
	return serializeValue(part, 256).text.replace(/\s+/g, ' ');
}

export function formatQueryKey(
	queryKey: readonly unknown[] | undefined,
): string {
	if (!queryKey?.length) return 'Anonymous mutation';
	return queryKey.map(formatQueryKeySegment).join(' › ');
}

/** Row title: every key segment after the grouping segment, ' · ' joined. */
export function formatQueryKeyRemainder(
	queryKey: readonly unknown[] | undefined,
): string {
	const [root, ...rest] = queryKey ?? [];
	if (rest.length > 0) return rest.map(formatQueryKeySegment).join(' · ');
	return formatQueryKeySegment(root);
}

export function groupQueriesByRoot(
	queries: readonly QuerySnapshot[],
): ReadonlyArray<{ segment: string; queries: readonly QuerySnapshot[] }> {
	const groups = new Map<string, QuerySnapshot[]>();
	for (const query of queries) {
		const segment = String(query.queryKey[0]);
		const group = groups.get(segment);
		if (group) group.push(query);
		else groups.set(segment, [query]);
	}
	return [...groups.entries()].map(([segment, grouped]) => ({
		segment,
		queries: grouped,
	}));
}

export function formatRelativeTime(
	timestamp: number,
	now = Date.now(),
): string | undefined {
	if (!timestamp) return undefined;
	const seconds = Math.floor(Math.max(0, now - timestamp) / 1000);
	if (seconds < 1) return 'now';
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function firstLine(text: string): string {
	const index = text.indexOf('\n');
	return index === -1 ? text : text.slice(0, index);
}

function describeLiveError(error: unknown): string | undefined {
	if (error instanceof Error) {
		return error.name ? `${error.name}: ${error.message}` : error.message;
	}
	if (typeof error === 'string' && error) return error;
	return undefined;
}

/** One-line error summary from the live error, else its serialized snapshot. */
export function summarizeError(
	serialized: string | undefined,
	liveError: unknown,
): string | undefined {
	const live = describeLiveError(liveError);
	if (live) return firstLine(live);
	if (!serialized) return undefined;
	try {
		const parsed: unknown = JSON.parse(serialized);
		if (parsed && typeof parsed === 'object') {
			const record = parsed as { message?: unknown; name?: unknown };
			const name = typeof record.name === 'string' ? record.name : undefined;
			const message =
				typeof record.message === 'string' ? record.message : undefined;
			const joined = [name, message].filter(Boolean).join(': ');
			if (joined) return firstLine(joined);
		}
	} catch {
		// Not JSON (for example truncated); fall through to the raw text.
	}
	return firstLine(serialized);
}

function formatTimestamp(timestamp: number): string {
	return timestamp ? new Date(timestamp).toISOString() : 'Never';
}

function secondaryFootnote() {
	return [font({ textStyle: 'footnote' }), foregroundColor(palette.secondary)];
}

function MetadataRow({ label, value }: { label: string; value: string }) {
	return (
		<LabeledContent label={label}>
			<UIText>{value}</UIText>
		</LabeledContent>
	);
}

function SnapshotPreview({
	label,
	text,
	isError = false,
}: {
	label: string;
	text?: string;
	isError?: boolean;
}) {
	if (text === undefined) return null;
	return (
		<VStack alignment="leading" spacing={4}>
			<UIText
				modifiers={[
					font({ textStyle: 'footnote' }),
					foregroundColor(isError ? palette.red : palette.secondary),
				]}
			>
				{label}
			</UIText>
			<UIText modifiers={[font({ design: 'monospaced', size: 12 })]}>
				{text}
			</UIText>
		</VStack>
	);
}

export function createQueryPlugin({
	queryClient,
	captureData = false,
	maxQueries = 100,
	maxMutations = 100,
	maxSnapshotBytes = 64 * 1024,
	maxStoreBytes = 2 * 1024 * 1024,
	title = 'Queries',
	id = 'queries',
	description = 'TanStack Query and mutation cache state',
	section,
	systemImage = 'square.stack.3d.up.fill',
	tint: pluginTint = '#AF52DE',
}: QueryPluginOptions): QueryPlugin {
	assertPositiveInteger(maxQueries, 'maxQueries');
	assertPositiveInteger(maxMutations, 'maxMutations');
	assertPositiveFinite(maxSnapshotBytes, 'maxSnapshotBytes');
	assertPositiveFinite(maxStoreBytes, 'maxStoreBytes');
	const store = new ExternalStore<QueryPluginSnapshot>({
		queries: [],
		mutations: [],
	});
	let installCount = 0;
	let installed = false;
	let unsubscribeQuery: (() => void) | undefined;
	let unsubscribeMutation: (() => void) | undefined;
	let refreshQueued = false;

	const refresh = () => {
		refreshQueued = false;
		if (!installed) return;
		const queryBudget = Math.floor(maxStoreBytes / 2);
		const mutationBudget = maxStoreBytes - queryBudget;
		const queries = queryClient
			.getQueryCache()
			.getAll()
			.slice()
			.sort(
				(left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt,
			)
			.slice(0, maxQueries)
			.map((query) => createQuerySnapshot(query, false, maxSnapshotBytes));
		const mutations = queryClient
			.getMutationCache()
			.getAll()
			.slice()
			.sort((left, right) => right.state.submittedAt - left.state.submittedAt)
			.slice(0, maxMutations)
			.map((mutation) =>
				createMutationSnapshot(mutation, false, maxSnapshotBytes),
			);
		store.set({
			queries: limitQuerySnapshotsByBytes(queries, queryBudget),
			mutations: limitQuerySnapshotsByBytes(mutations, mutationBudget),
		});
	};
	const scheduleRefresh = () => {
		if (refreshQueued) return;
		refreshQueued = true;
		queueMicrotask(refresh);
	};
	const filtersFor = (query: QuerySnapshot) => ({
		queryKey: query.queryKey,
		exact: true,
	});

	function QueryDetails({ query }: { query: QuerySnapshot }) {
		const liveQuery = queryClient.getQueryCache().get(query.hash);
		const data =
			captureData && liveQuery
				? serializeValue(liveQuery.state.data, maxSnapshotBytes)
				: undefined;
		const error = liveQuery?.state.error
			? serializeValue(liveQuery.state.error, maxSnapshotBytes)
			: undefined;
		return (
			<>
				<MetadataRow label="Hash" value={query.hash} />
				<MetadataRow label="Status" value={query.status} />
				<MetadataRow label="Fetch status" value={query.fetchStatus} />
				<MetadataRow label="Observers" value={String(query.observerCount)} />
				<MetadataRow
					label="Updated at"
					value={formatTimestamp(query.dataUpdatedAt)}
				/>
				<MetadataRow
					label="Failure count"
					value={String(query.fetchFailureCount)}
				/>
				<SnapshotPreview label="Data" text={data?.text} />
				<SnapshotPreview isError label="Error" text={error?.text} />
			</>
		);
	}

	function QueryRow({
		query,
		runAction,
	}: {
		query: QuerySnapshot;
		runAction: RunQueryAction;
	}) {
		const [isExpanded, setIsExpanded] = useState(false);
		const kind = queryStatusKind(query);
		const updatedBadge = formatRelativeTime(query.dataUpdatedAt);
		// Row subtitles render from the captured snapshot only; reading the live
		// query cache during render tears against React Compiler caching.
		const errorLine =
			kind === 'error' ? summarizeError(query.error, undefined) : undefined;
		return (
			<SwipeActions>
				<DisclosureGroup
					isExpanded={isExpanded}
					onIsExpandedChange={setIsExpanded}
				>
					<DisclosureGroup.Label>
						<HStack
							modifiers={updatedBadge ? [badge(updatedBadge)] : undefined}
							spacing={12}
						>
							<Image
								color={statusDotColors[kind]}
								size={10}
								systemName="circle.fill"
							/>
							<VStack alignment="leading" spacing={2}>
								<UIText modifiers={[font({ design: 'monospaced', size: 15 })]}>
									{formatQueryKeyRemainder(query.queryKey)}
								</UIText>
								<UIText modifiers={secondaryFootnote()}>
									{`${query.observerCount} observer${query.observerCount === 1 ? '' : 's'} · ${statusLabels[kind]}`}
								</UIText>
								{errorLine ? (
									<UIText
										modifiers={[
											font({ textStyle: 'footnote' }),
											foregroundColor(palette.red),
										]}
									>
										{errorLine}
									</UIText>
								) : null}
							</VStack>
						</HStack>
					</DisclosureGroup.Label>
					{isExpanded ? <QueryDetails query={query} /> : null}
				</DisclosureGroup>
				<SwipeActions.Actions edge="trailing">
					{/* biome-ignore lint/a11y/useValidAriaRole: SwiftUI ButtonRole, not ARIA */}
					<Button
						label="Remove"
						onPress={() =>
							runAction(
								'Remove query',
								() => queryClient.removeQueries(filtersFor(query)),
								{
									title: 'Remove query?',
									message: query.key,
									confirmLabel: 'Remove',
									destructive: true,
								},
							)
						}
						role="destructive"
						systemImage="trash"
					/>
					<Button
						label="Refetch"
						modifiers={[tint(palette.orange)]}
						onPress={() =>
							runAction('Refetch query', () =>
								queryClient.refetchQueries(filtersFor(query)),
							)
						}
						systemImage="arrow.clockwise"
					/>
					<Button
						label="Invalidate"
						modifiers={[tint(palette.blue)]}
						onPress={() =>
							runAction('Invalidate query', () =>
								queryClient.invalidateQueries(filtersFor(query)),
							)
						}
						systemImage="arrow.triangle.2.circlepath"
					/>
				</SwipeActions.Actions>
			</SwipeActions>
		);
	}

	function MutationDetails({ mutation }: { mutation: MutationSnapshot }) {
		const liveMutation = queryClient
			.getMutationCache()
			.getAll()
			.find((candidate) => candidate.mutationId === mutation.id);
		const variables =
			captureData && liveMutation
				? serializeValue(liveMutation.state.variables, maxSnapshotBytes)
				: undefined;
		const data =
			captureData && liveMutation
				? serializeValue(liveMutation.state.data, maxSnapshotBytes)
				: undefined;
		const error = liveMutation?.state.error
			? serializeValue(liveMutation.state.error, maxSnapshotBytes)
			: undefined;
		return (
			<>
				<MetadataRow label="ID" value={String(mutation.id)} />
				<MetadataRow label="Status" value={mutation.status} />
				<MetadataRow
					label="Submitted at"
					value={formatTimestamp(mutation.submittedAt)}
				/>
				<MetadataRow
					label="Failure count"
					value={String(mutation.failureCount)}
				/>
				<MetadataRow label="Paused" value={mutation.isPaused ? 'Yes' : 'No'} />
				<SnapshotPreview label="Variables" text={variables?.text} />
				<SnapshotPreview label="Data" text={data?.text} />
				<SnapshotPreview isError label="Error" text={error?.text} />
			</>
		);
	}

	function MutationRow({ mutation }: { mutation: MutationSnapshot }) {
		const [isExpanded, setIsExpanded] = useState(false);
		return (
			<DisclosureGroup
				isExpanded={isExpanded}
				onIsExpandedChange={setIsExpanded}
			>
				<DisclosureGroup.Label>
					<HStack modifiers={[badge(mutation.status)]} spacing={12}>
						<Image
							color={mutationDotColor(mutation.status)}
							size={10}
							systemName="circle.fill"
						/>
						<VStack alignment="leading" spacing={2}>
							<UIText modifiers={[font({ design: 'monospaced', size: 15 })]}>
								{formatQueryKey(mutation.mutationKey)}
							</UIText>
							<UIText modifiers={secondaryFootnote()}>
								{`${mutation.failureCount} failure${mutation.failureCount === 1 ? '' : 's'}${mutation.isPaused ? ' · paused' : ''}`}
							</UIText>
						</VStack>
					</HStack>
				</DisclosureGroup.Label>
				{isExpanded ? <MutationDetails mutation={mutation} /> : null}
			</DisclosureGroup>
		);
	}

	function QueryPanel({ onBack, actions }: DevToolsPanelProps) {
		const snapshot = useSyncExternalStore(
			store.subscribe,
			store.getSnapshot,
			store.getServerSnapshot,
		);
		const [tab, setTab] = useState<InspectorTab>('queries');
		const [search, setSearch] = useState('');
		const needle = search.trim().toLowerCase();
		const visibleQueries = useMemo(
			() =>
				snapshot.queries.filter(
					(query) => !needle || query.key.toLowerCase().includes(needle),
				),
			[needle, snapshot.queries],
		);
		const visibleMutations = useMemo(
			() =>
				snapshot.mutations.filter(
					(mutation) =>
						!needle ||
						mutation.key.toLowerCase().includes(needle) ||
						mutation.status.includes(needle),
				),
			[needle, snapshot.mutations],
		);
		const queryGroups = useMemo(
			() => groupQueriesByRoot(visibleQueries),
			[visibleQueries],
		);
		const runAction: RunQueryAction = (label, action, confirmation) => {
			void actions.run({ pluginId: id, label, action, confirmation });
		};
		const fetching = snapshot.queries.filter(
			(query) => query.fetchStatus === 'fetching',
		).length;
		const stale = snapshot.queries.filter((query) => query.isStale).length;
		const errors = snapshot.queries.filter(
			(query) => query.status === 'error',
		).length;
		const summary = `${snapshot.queries.length} CACHED · ${fetching} FETCHING · ${stale} STALE · ${errors} ${errors === 1 ? 'ERROR' : 'ERRORS'}`;

		return (
			<PanelShell onBack={onBack} title={title}>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							<Section>
								<Picker
									modifiers={[pickerStyle('segmented')]}
									onSelectionChange={(selection) =>
										setTab(selection === 'mutations' ? 'mutations' : 'queries')
									}
									selection={tab}
								>
									<UIText modifiers={[tag('queries')]}>Queries</UIText>
									<UIText modifiers={[tag('mutations')]}>Mutations</UIText>
								</Picker>
								<TextField
									modifiers={[autocorrectionDisabled()]}
									onTextChange={setSearch}
									placeholder={
										tab === 'queries' ? 'Search query keys' : 'Search mutations'
									}
								/>
							</Section>
							{tab === 'queries' ? (
								<>
									<Section
										header={
											<HStack spacing={5}>
												<UIText modifiers={secondaryFootnote()}>
													{summary}
												</UIText>
												<Image
													color={palette.secondary}
													size={13}
													systemName="info.circle"
												/>
											</HStack>
										}
									>
										{null}
									</Section>
									{queryGroups.length === 0 ? (
										<Section>
											<ContentUnavailableView
												description={
													snapshot.queries.length === 0
														? 'Query cache activity will appear here.'
														: 'No queries match the current search.'
												}
												systemImage="square.stack.3d.up"
												title="No queries to show"
											/>
										</Section>
									) : null}
									{queryGroups.map((group) => (
										<Section
											key={group.segment}
											title={`${group.segment} · ${group.queries.length}`}
										>
											{group.queries.map((query) => (
												<QueryRow
													key={query.hash}
													query={query}
													runAction={runAction}
												/>
											))}
										</Section>
									))}
								</>
							) : null}
							{tab === 'mutations' ? (
								visibleMutations.length === 0 ? (
									<Section>
										<ContentUnavailableView
											description={
												snapshot.mutations.length === 0
													? 'Mutation activity will appear here.'
													: 'No mutations match the current search.'
											}
											systemImage="bolt.horizontal"
											title="No mutations yet"
										/>
									</Section>
								) : (
									<Section title={`recent · ${visibleMutations.length}`}>
										{visibleMutations.map((mutation) => (
											<MutationRow key={mutation.id} mutation={mutation} />
										))}
									</Section>
								)
							) : null}
							<Section>
								<Button
									label="Invalidate all"
									onPress={() =>
										runAction(
											'Invalidate all queries',
											() => queryClient.invalidateQueries(),
											{
												title: 'Invalidate all queries?',
												message: 'Marks every cached query as stale.',
												confirmLabel: 'Invalidate',
											},
										)
									}
								/>
								{/* biome-ignore lint/a11y/useValidAriaRole: SwiftUI ButtonRole, not ARIA */}
								<Button
									label="Clear query cache"
									onPress={() =>
										runAction('Clear query cache', () => queryClient.clear(), {
											title: 'Clear query cache?',
											message: 'Removes every cached query and mutation.',
											confirmLabel: 'Clear',
											destructive: true,
										})
									}
									role="destructive"
								/>
							</Section>
						</List>
					</Host>
				) : null}
			</PanelShell>
		);
	}

	return Object.assign(
		{
			id,
			title,
			description,
			systemImage,
			tint: pluginTint,
			section,
			Panel: QueryPanel,
			install: () => {
				installCount += 1;
				if (installCount === 1) {
					installed = true;
					refresh();
					unsubscribeQuery = queryClient
						.getQueryCache()
						.subscribe(scheduleRefresh);
					unsubscribeMutation = queryClient
						.getMutationCache()
						.subscribe(scheduleRefresh);
				}
				return () => {
					installCount = Math.max(0, installCount - 1);
					if (installCount === 0) {
						installed = false;
						unsubscribeQuery?.();
						unsubscribeMutation?.();
						unsubscribeQuery = undefined;
						unsubscribeMutation = undefined;
					}
				};
			},
		},
		{ refresh, getSnapshot: store.getSnapshot },
	);
}
