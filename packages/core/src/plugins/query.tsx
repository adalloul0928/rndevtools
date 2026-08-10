import type { QueryClient } from '@tanstack/react-query';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
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
	PanelMetricStrip,
	PanelScaffold,
	PanelSignalCard,
	PanelStatusBadge,
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

export function formatQueryKey(
	queryKey: readonly unknown[] | undefined,
): string {
	if (!queryKey?.length) return 'Anonymous mutation';
	return queryKey
		.map((part) => {
			if (typeof part === 'string') return part;
			if (
				typeof part === 'number' ||
				typeof part === 'boolean' ||
				typeof part === 'bigint'
			) {
				return String(part);
			}
			return serializeValue(part, 256).text.replace(/\s+/g, ' ');
		})
		.join(' › ');
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
		const presentation = queryStatusPresentation(
			query.status,
			query.fetchStatus,
			query.isStale,
		);
		return (
			<DisclosureCard
				leading={
					<PanelStatusBadge
						label={presentation.label}
						tone={presentation.tone}
					/>
				}
				title={formatQueryKey(query.queryKey)}
				subtitle={`${query.observerCount} observer${query.observerCount === 1 ? '' : 's'} · ${query.fetchStatus === 'idle' ? 'Not fetching' : query.fetchStatus}`}
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
		const presentation = queryStatusPresentation(mutation.status);
		return (
			<DisclosureCard
				leading={
					<PanelStatusBadge
						label={presentation.label}
						tone={presentation.tone}
					/>
				}
				title={formatQueryKey(mutation.mutationKey)}
				subtitle={`${mutation.failureCount} failure${mutation.failureCount === 1 ? '' : 's'}${mutation.isPaused ? ' · Paused' : ''}`}
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
				<PanelSignalCard
					description={`${fetching} fetching · ${stale} stale · ${snapshot.mutations.length} recent mutations`}
					eyebrow="Cache signal"
					systemImage={
						errors > 0
							? 'exclamationmark.triangle.fill'
							: fetching > 0
								? 'arrow.triangle.2.circlepath'
								: 'checkmark.circle.fill'
					}
					title={
						errors > 0
							? `${errors} quer${errors === 1 ? 'y' : 'ies'} need attention`
							: fetching > 0
								? `${fetching} quer${fetching === 1 ? 'y is' : 'ies are'} fetching`
								: snapshot.queries.length > 0
									? 'Query cache is settled'
									: 'Waiting for query activity'
					}
					tone={errors > 0 ? 'danger' : fetching > 0 ? 'info' : 'success'}
				/>
				<PanelMetricStrip
					metrics={[
						{ label: 'Cached', value: snapshot.queries.length },
						{ label: 'Fetching', value: fetching, tone: colors.blue },
						{ label: 'Stale', value: stale, tone: colors.orange },
						{ label: 'Errors', value: errors, tone: colors.red },
					]}
				/>
				<PanelSegmentedControl
					accessibilityLabel="Query inspector"
					onChange={setTab}
					options={[
						{ id: 'queries', label: 'Queries' },
						{ id: 'mutations', label: 'Mutations' },
					]}
					selected={tab}
				/>
				<PanelSearchField
					onChangeText={setSearch}
					placeholder={`Search ${tab}`}
					value={search}
				/>
				{tab === 'queries' ? (
					<PanelSegmentedControl
						accessibilityLabel="Query filter"
						onChange={setFilter}
						options={(
							['all', 'active', 'fetching', 'stale', 'error'] as const
						).map((value) => ({
							id: value,
							label: value.charAt(0).toUpperCase() + value.slice(1),
						}))}
						selected={filter}
					/>
				) : null}
				{tab === 'queries' && visibleQueries.length === 0 ? (
					<EmptyState
						systemImage="square.stack.3d.up"
						title="No queries to show"
					>
						{snapshot.queries.length === 0
							? 'Query cache activity will appear here.'
							: 'No queries match the current filters.'}
					</EmptyState>
				) : null}
				{tab === 'mutations' && visibleMutations.length === 0 ? (
					<EmptyState systemImage="bolt.horizontal" title="No mutations yet">
						Mutation activity will appear here.
					</EmptyState>
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

function queryStatusPresentation(
	status: string,
	fetchStatus?: string,
	stale?: boolean,
): { label: string; tone: 'danger' | 'info' | 'warning' | 'success' } {
	if (status === 'error') return { label: 'ERROR', tone: 'danger' };
	if (fetchStatus === 'fetching' || status === 'pending') {
		return { label: 'ACTIVE', tone: 'info' };
	}
	if (stale) return { label: 'STALE', tone: 'warning' };
	return { label: 'READY', tone: 'success' };
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
	metadata: { gap: 8 },
	detailSection: {
		borderTopColor: colors.separator,
		borderTopWidth: StyleSheet.hairlineWidth,
		gap: 8,
		marginTop: 12,
		paddingTop: 12,
	},
});
