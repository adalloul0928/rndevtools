import type { QueryClient } from '@tanstack/react-query';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
	PanelButton,
	PanelSearchField,
	PanelToolbar,
} from '../components/panel-controls';
import {
	CodeBlock,
	colors,
	DisclosureCard,
	EmptyState,
	PanelScaffold,
	panelStyles,
} from '../components/panel-ui';
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
};

export type QueryPlugin = DevToolsPanelPlugin & {
	refresh: () => void;
	getSnapshot: () => QueryPluginSnapshot;
};

type QueryFilter = 'all' | 'active' | 'fetching' | 'stale' | 'error';
type InspectorTab = 'queries' | 'mutations';
type RunQueryAction = (
	label: string,
	action: () => unknown | Promise<unknown>,
	confirmation?: DevToolsActionConfirmation,
) => void;

function Metric({
	label,
	value,
	tone = colors.label,
}: {
	label: string;
	value: number;
	tone?: typeof colors.label;
}) {
	return (
		<View style={styles.metric}>
			<Text style={[styles.metricValue, { color: tone }]}>{value}</Text>
			<Text style={styles.metricLabel}>{label}</Text>
		</View>
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

	function QueryRow({
		query,
		runAction,
	}: {
		query: QuerySnapshot;
		runAction: RunQueryAction;
	}) {
		return (
			<DisclosureCard
				leading={
					<StatusDot
						status={query.status}
						fetchStatus={query.fetchStatus}
						stale={query.isStale}
					/>
				}
				title={query.key.replace(/\s+/g, ' ')}
				subtitle={`${query.status} · ${query.fetchStatus} · ${query.observerCount} observers${query.isStale ? ' · stale' : ''}`}
				renderDetails={() => {
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
							<PanelToolbar>
								<PanelButton
									label="Refetch"
									onPress={() =>
										runAction('Refetch query', () =>
											queryClient.refetchQueries(filtersFor(query)),
										)
									}
								/>
								<PanelButton
									label="Invalidate"
									onPress={() =>
										runAction('Invalidate query', () =>
											queryClient.invalidateQueries(filtersFor(query)),
										)
									}
								/>
								<PanelButton
									label="Reset"
									onPress={() =>
										runAction(
											'Reset query',
											() => queryClient.resetQueries(filtersFor(query)),
											{
												title: 'Reset query?',
												message: query.key,
												confirmLabel: 'Reset',
											},
										)
									}
								/>
								<PanelButton
									label="Remove"
									tone="danger"
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
								/>
							</PanelToolbar>
							<SnapshotMetadata
								value={{
									hash: query.hash,
									status: query.status,
									fetchStatus: query.fetchStatus,
									observers: query.observerCount,
									stale: query.isStale,
									dataUpdatedAt: query.dataUpdatedAt,
									errorUpdatedAt: query.errorUpdatedAt,
									updateCount: query.dataUpdateCount,
									failureCount: query.fetchFailureCount,
									truncated:
										query.truncated || !!data?.truncated || !!error?.truncated,
								}}
							/>
							<SnapshotValue label="Data" value={data?.text} />
							<SnapshotValue error label="Error" value={error?.text} />
						</>
					);
				}}
			/>
		);
	}

	function MutationRow({ mutation }: { mutation: MutationSnapshot }) {
		return (
			<DisclosureCard
				leading={<StatusDot status={mutation.status} />}
				title={mutation.key.replace(/\s+/g, ' ')}
				subtitle={`${mutation.status} · ${mutation.failureCount} failures${mutation.isPaused ? ' · paused' : ''}`}
				renderDetails={() => {
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
							<SnapshotMetadata
								value={{
									id: mutation.id,
									status: mutation.status,
									submittedAt: mutation.submittedAt,
									failureCount: mutation.failureCount,
									paused: mutation.isPaused,
									truncated:
										mutation.truncated ||
										!!variables?.truncated ||
										!!data?.truncated ||
										!!error?.truncated,
								}}
							/>
							<SnapshotValue label="Variables" value={variables?.text} />
							<SnapshotValue label="Data" value={data?.text} />
							<SnapshotValue error label="Error" value={error?.text} />
						</>
					);
				}}
			/>
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
		const [filter, setFilter] = useState<QueryFilter>('all');
		const needle = search.trim().toLowerCase();
		const visibleQueries = useMemo(
			() =>
				snapshot.queries.filter((query) => {
					if (filter === 'active' && query.observerCount === 0) return false;
					if (filter === 'fetching' && query.fetchStatus !== 'fetching')
						return false;
					if (filter === 'stale' && !query.isStale) return false;
					if (filter === 'error' && query.status !== 'error') return false;
					return !needle || query.key.toLowerCase().includes(needle);
				}),
			[filter, needle, snapshot.queries],
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

		return (
			<PanelScaffold
				onBack={onBack}
				title={title}
				subtitle={`${snapshot.queries.length} queries · ${snapshot.mutations.length} mutations`}
			>
				<View style={styles.metrics}>
					<Metric label="Cached" value={snapshot.queries.length} />
					<Metric label="Fetching" value={fetching} tone={colors.blue} />
					<Metric label="Stale" value={stale} tone={colors.orange} />
					<Metric label="Errors" value={errors} tone={colors.red} />
				</View>
				<PanelToolbar>
					<PanelButton
						label="Queries"
						onPress={() => setTab('queries')}
						selected={tab === 'queries'}
					/>
					<PanelButton
						label="Mutations"
						onPress={() => setTab('mutations')}
						selected={tab === 'mutations'}
					/>
				</PanelToolbar>
				<PanelSearchField
					onChangeText={setSearch}
					placeholder={`Search ${tab}`}
					value={search}
				/>
				{tab === 'queries' ? (
					<PanelToolbar>
						{(['all', 'active', 'fetching', 'stale', 'error'] as const).map(
							(value) => (
								<PanelButton
									key={value}
									label={value.charAt(0).toUpperCase() + value.slice(1)}
									onPress={() => setFilter(value)}
									selected={filter === value}
								/>
							),
						)}
					</PanelToolbar>
				) : null}
				{tab === 'queries' && visibleQueries.length === 0 ? (
					<EmptyState>
						{snapshot.queries.length === 0
							? 'Query cache activity will appear here.'
							: 'No queries match the current filters.'}
					</EmptyState>
				) : null}
				{tab === 'mutations' && visibleMutations.length === 0 ? (
					<EmptyState>Mutation activity will appear here.</EmptyState>
				) : null}
				{tab === 'queries'
					? visibleQueries.map((query) => (
							<QueryRow key={query.hash} query={query} runAction={runAction} />
						))
					: visibleMutations.map((mutation) => (
							<MutationRow key={mutation.id} mutation={mutation} />
						))}
			</PanelScaffold>
		);
	}

	return Object.assign(
		{
			id,
			title,
			description,
			systemImage,
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

function StatusDot({
	status,
	fetchStatus,
	stale,
}: {
	status: string;
	fetchStatus?: string;
	stale?: boolean;
}) {
	const backgroundColor =
		status === 'error'
			? colors.red
			: fetchStatus === 'fetching' || status === 'pending'
				? colors.blue
				: stale
					? colors.orange
					: colors.green;
	return <View style={[styles.statusDot, { backgroundColor }]} />;
}

function SnapshotMetadata({
	value,
}: {
	value: Readonly<Record<string, unknown>>;
}) {
	return (
		<View style={styles.metadata}>
			<Text style={panelStyles.valueKey}>Metadata</Text>
			<CodeBlock>{serializeValue(value, 64 * 1024).text}</CodeBlock>
		</View>
	);
}

function SnapshotValue({
	label,
	value,
	error = false,
}: {
	label: string;
	value?: string;
	error?: boolean;
}) {
	if (value === undefined) return null;
	return (
		<View style={styles.detailSection}>
			<Text style={[panelStyles.valueKey, error && { color: colors.red }]}>
				{label}
			</Text>
			<CodeBlock>{value}</CodeBlock>
		</View>
	);
}

const styles = StyleSheet.create({
	metrics: { flexDirection: 'row', gap: 7 },
	metric: {
		alignItems: 'center',
		backgroundColor: colors.card,
		borderRadius: 13,
		flex: 1,
		paddingVertical: 10,
	},
	metricValue: { fontSize: 19, fontWeight: '700' },
	metricLabel: { color: colors.secondaryLabel, fontSize: 10, marginTop: 2 },
	statusDot: { borderRadius: 5, height: 10, marginRight: 12, width: 10 },
	metadata: { gap: 8 },
	detailSection: {
		borderTopColor: colors.separator,
		borderTopWidth: StyleSheet.hairlineWidth,
		gap: 8,
		marginTop: 12,
		paddingTop: 12,
	},
});
