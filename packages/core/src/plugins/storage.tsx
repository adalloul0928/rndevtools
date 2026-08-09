import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import {
	PanelButton,
	PanelSearchField,
	PanelToolbar,
} from '../components/panel-controls';
import {
	colors,
	DisclosureCard,
	EmptyState,
	PanelList,
	PanelScaffold,
} from '../components/panel-ui';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { assertPositiveFinite } from '../core/options';
import { serializeValue } from '../core/serialize';
import type {
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';
import {
	type DevToolsStorageAdapter,
	isStorageEntryEditable,
	parseStorageDraft,
	type StorageAdapterSnapshot,
	type StorageChangeEvent,
	type StorageEntrySnapshot,
	type StorageKeyRule,
	type StorageSnapshot,
	type StorageValidationResult,
	snapshotStorageAdapter,
	validateStorageSnapshot,
} from './storage-model';

export type {
	DevToolsStorageAdapter,
	StorageAdapterSnapshot,
	StorageChangeEvent,
	StorageEntrySnapshot,
	StorageKeyRule,
	StorageSnapshot,
	StorageValidationResult,
} from './storage-model';
export {
	isStorageEntryEditable,
	parseStorageDraft,
	validateStorageSnapshot,
} from './storage-model';

export type StoragePluginOptions = {
	adapters: readonly DevToolsStorageAdapter[];
	rules?: readonly StorageKeyRule[];
	maxValueBytes?: number;
	maxEvents?: number;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
};

export type StoragePlugin = {
	plugin: DevToolsPanelPlugin;
	refresh: () => Promise<void>;
	getSnapshot: () => StorageSnapshot;
	getEvents: () => readonly StorageChangeEvent[];
	clearEvents: () => void;
};

type StoragePanelRow =
	| { kind: 'event'; event: StorageChangeEvent }
	| {
			kind: 'adapter';
			adapter: DevToolsStorageAdapter;
			snapshot: StorageAdapterSnapshot;
	  }
	| {
			kind: 'entry';
			adapter: DevToolsStorageAdapter;
			entry: StorageEntrySnapshot;
	  }
	| { kind: 'empty'; id: string; message: string }
	| { kind: 'validationHeader' }
	| { kind: 'validation'; result: StorageValidationResult };

export function createStoragePlugin({
	adapters,
	rules = [],
	maxValueBytes = 256 * 1024,
	maxEvents = 200,
	title = 'Storage',
	id = 'storage',
	description = 'Registered application storage adapters',
	section,
	systemImage = 'externaldrive.fill',
}: StoragePluginOptions): StoragePlugin {
	assertPositiveFinite(maxValueBytes, 'maxValueBytes');
	const store = new ExternalStore<StorageSnapshot>({
		loading: false,
		adapters: [],
	});
	const eventStore = new BoundedEventStore<StorageChangeEvent>({
		maxEvents,
		maxBytes: 2 * 1024 * 1024,
		estimateBytes: (event) => serializeValue(event, 128 * 1024).estimatedBytes,
	});
	let installCount = 0;
	let subscriptions: Array<() => void> = [];
	let lifecycleGeneration = 0;
	let nextEventId = 1;
	const adapterBaselines = new Set<string>();
	let refreshInFlight: Promise<void> | undefined;
	let refreshRequested = false;

	const recordChanges = (previous: StorageSnapshot, next: StorageSnapshot) => {
		for (const adapter of next.adapters) {
			const oldAdapter = previous.adapters.find(
				(candidate) => candidate.id === adapter.id,
			);
			if (adapter.error || oldAdapter?.error) continue;
			if (!adapterBaselines.has(adapter.id)) {
				adapterBaselines.add(adapter.id);
				continue;
			}
			const oldEntries = new Map(
				(oldAdapter?.entries ?? []).map((entry) => [entry.key, entry]),
			);
			const newEntries = new Map(
				adapter.entries.map((entry) => [entry.key, entry]),
			);
			for (const entry of adapter.entries) {
				const old = oldEntries.get(entry.key);
				if (
					!old ||
					old.value !== entry.value ||
					old.valueHidden !== entry.valueHidden ||
					old.readError !== entry.readError
				) {
					eventStore.append({
						id: nextEventId++,
						at: Date.now(),
						adapterId: adapter.id,
						adapterTitle: adapter.title,
						key: entry.key,
						type: old ? 'updated' : 'added',
						previousValue: entry.valueHidden ? undefined : old?.value,
						value: entry.valueHidden ? undefined : entry.value,
						valueHidden: entry.valueHidden,
					});
				}
			}
			for (const old of oldEntries.values()) {
				if (!newEntries.has(old.key))
					eventStore.append({
						id: nextEventId++,
						at: Date.now(),
						adapterId: adapter.id,
						adapterTitle: adapter.title,
						key: old.key,
						type: 'removed',
						previousValue: old.valueHidden ? undefined : old.value,
						valueHidden: old.valueHidden,
					});
			}
		}
	};

	const performRefresh = async (generation: number): Promise<void> => {
		store.set({ ...store.getSnapshot(), loading: true });
		const snapshots = await Promise.all(
			adapters.map((adapter) => snapshotStorageAdapter(adapter, maxValueBytes)),
		);
		if (generation !== lifecycleGeneration) return;
		const next = { loading: false, adapters: snapshots };
		recordChanges(store.getSnapshot(), next);
		store.set(next);
	};

	const refresh = async (): Promise<void> => {
		if (refreshInFlight) {
			refreshRequested = true;
			return refreshInFlight;
		}
		refreshInFlight = (async () => {
			do {
				refreshRequested = false;
				await performRefresh(lifecycleGeneration);
			} while (refreshRequested);
		})();
		try {
			await refreshInFlight;
		} finally {
			refreshInFlight = undefined;
		}
	};

	const scheduleRefresh = (): void => {
		if (refreshRequested) return;
		refreshRequested = true;
		const scheduledGeneration = lifecycleGeneration;
		queueMicrotask(() => {
			if (scheduledGeneration !== lifecycleGeneration || installCount === 0) {
				refreshRequested = false;
				return;
			}
			void refresh();
		});
	};

	function StorageEntry({
		adapter,
		entry,
		runMutation,
	}: {
		adapter: DevToolsStorageAdapter;
		entry: StorageEntrySnapshot;
		runMutation: (
			label: string,
			mutation: () => void | Promise<void>,
			confirmation?: {
				title: string;
				message?: string;
				confirmLabel?: string;
				destructive?: boolean;
			},
		) => void;
	}) {
		const [draft, setDraft] = useState(entry.value ?? '');
		useEffect(() => {
			setDraft(entry.value ?? '');
		}, [entry.value]);
		const canEdit = isStorageEntryEditable(adapter, entry);
		const subtitle = entry.valueHidden
			? 'Value protected'
			: entry.readError
				? `Read failed · ${entry.readError}`
				: entry.binary
					? 'Binary value · editing disabled'
					: `${entry.value?.length ?? 0} displayed characters${entry.truncated ? ' · truncated · editing disabled' : ''}`;
		return (
			<DisclosureCard title={entry.key} subtitle={subtitle}>
				{entry.valueHidden ? (
					<Text style={styles.protectedText}>
						This adapter exposes key metadata only. Its values are never read.
					</Text>
				) : (
					<TextInput
						accessibilityLabel={`${entry.key} value`}
						editable={canEdit}
						multiline
						onChangeText={setDraft}
						style={styles.editor}
						value={draft}
					/>
				)}
				<PanelToolbar>
					{canEdit ? (
						<PanelButton
							label="Save"
							onPress={() => {
								runMutation('Save storage value', () => {
									const parsed = adapter.parseValue
										? adapter.parseValue(
												entry.key,
												draft,
												entry.valueType ?? '',
											)
										: parseStorageDraft(draft, entry.valueType ?? '');
									return adapter.setValue?.(entry.key, parsed);
								});
							}}
						/>
					) : null}
					{adapter.removeValue ? (
						<PanelButton
							label="Delete"
							onPress={() =>
								runMutation(
									'Delete storage value',
									() => adapter.removeValue?.(entry.key),
									{
										title: 'Delete storage value?',
										message: entry.key,
										confirmLabel: 'Delete',
										destructive: true,
									},
								)
							}
							tone="danger"
						/>
					) : null}
				</PanelToolbar>
			</DisclosureCard>
		);
	}

	function StoragePanel({ onBack, actions }: DevToolsPanelProps) {
		const runMutation = (
			label: string,
			mutation: () => void | Promise<void>,
			confirmation?: {
				title: string;
				message?: string;
				confirmLabel?: string;
				destructive?: boolean;
			},
		): void => {
			void actions.run({
				pluginId: id,
				label,
				confirmation,
				action: async () => {
					await mutation();
					await refresh();
				},
			});
		};
		const snapshot = useSyncExternalStore(
			store.subscribe,
			store.getSnapshot,
			store.getServerSnapshot,
		);
		const [search, setSearch] = useState('');
		const [tab, setTab] = useState<'browser' | 'events'>('browser');
		const events = useSyncExternalStore(
			eventStore.subscribe,
			eventStore.getSnapshot,
			eventStore.getServerSnapshot,
		);
		const needle = search.trim().toLowerCase();
		const visibleAdapters = useMemo(
			() =>
				snapshot.adapters.map((adapter) => ({
					...adapter,
					entries: adapter.entries.filter((entry) =>
						entry.key.toLowerCase().includes(needle),
					),
				})),
			[needle, snapshot.adapters],
		);
		const validation = useMemo(
			() => validateStorageSnapshot(snapshot, rules),
			[snapshot],
		);
		const validCount = validation.filter(
			(result) => result.status === 'valid' || result.status === 'protected',
		).length;
		const issueCount = validation.length - validCount;
		const keyCount = snapshot.adapters.reduce(
			(sum, adapter) => sum + adapter.entries.length,
			0,
		);
		const rows = useMemo<readonly StoragePanelRow[]>(() => {
			if (tab === 'events') {
				const filteredEvents = [...events]
					.reverse()
					.filter(
						(event) =>
							!needle ||
							event.key.toLowerCase().includes(needle) ||
							event.adapterTitle.toLowerCase().includes(needle),
					);
				return filteredEvents.length
					? filteredEvents.map((event) => ({ kind: 'event', event }))
					: [
							{
								kind: 'empty',
								id: 'events-empty',
								message: 'Storage mutations will appear here.',
							},
						];
			}

			const browserRows: StoragePanelRow[] = [];
			if (visibleAdapters.length === 0) {
				browserRows.push({
					kind: 'empty',
					id: 'adapters-empty',
					message: 'No storage adapters are registered.',
				});
			} else {
				for (const adapterSnapshot of visibleAdapters) {
					const adapter = adapters.find(
						(candidate) => candidate.id === adapterSnapshot.id,
					);
					if (!adapter) continue;
					browserRows.push({
						kind: 'adapter',
						adapter,
						snapshot: adapterSnapshot,
					});
					if (adapterSnapshot.entries.length === 0) {
						browserRows.push({
							kind: 'empty',
							id: `adapter-empty:${adapter.id}`,
							message: needle ? 'No matching keys.' : 'This adapter is empty.',
						});
					} else {
						for (const entry of adapterSnapshot.entries) {
							browserRows.push({ kind: 'entry', adapter, entry });
						}
					}
				}
			}
			if (validation.length) {
				browserRows.push({ kind: 'validationHeader' });
				for (const result of validation) {
					browserRows.push({ kind: 'validation', result });
				}
			}
			return browserRows;
		}, [events, needle, tab, validation, visibleAdapters]);

		return (
			<PanelScaffold
				onBack={onBack}
				scrollable={false}
				title={title}
				subtitle={`${snapshot.adapters.reduce((sum, adapter) => sum + adapter.entries.length, 0)} registered keys${snapshot.loading ? ' · refreshing' : ''}`}
			>
				<PanelList
					data={rows}
					header={
						<View style={styles.panelHeader}>
							<View style={styles.metrics}>
								<View style={styles.metric}>
									<Text style={styles.metricValue}>
										{snapshot.adapters.length}
									</Text>
									<Text style={styles.metricLabel}>Adapters</Text>
								</View>
								<View style={styles.metric}>
									<Text style={styles.metricValue}>{keyCount}</Text>
									<Text style={styles.metricLabel}>Keys</Text>
								</View>
								<View style={styles.metric}>
									<Text style={[styles.metricValue, { color: colors.green }]}>
										{validCount}
									</Text>
									<Text style={styles.metricLabel}>Checks</Text>
								</View>
								<View style={styles.metric}>
									<Text style={[styles.metricValue, { color: colors.red }]}>
										{issueCount}
									</Text>
									<Text style={styles.metricLabel}>Issues</Text>
								</View>
							</View>
							<PanelToolbar>
								<PanelButton
									label="Browser"
									onPress={() => setTab('browser')}
									selected={tab === 'browser'}
								/>
								<PanelButton
									label="Events"
									onPress={() => setTab('events')}
									selected={tab === 'events'}
								/>
							</PanelToolbar>
							<PanelSearchField
								onChangeText={setSearch}
								placeholder="Search storage keys"
								value={search}
							/>
							<PanelToolbar>
								<PanelButton label="Refresh" onPress={() => void refresh()} />
								{tab === 'events' ? (
									<PanelButton
										label="Clear events"
										onPress={eventStore.clear}
										tone="danger"
									/>
								) : null}
							</PanelToolbar>
						</View>
					}
					keyExtractor={(row) => {
						switch (row.kind) {
							case 'event':
								return `event:${row.event.id}`;
							case 'adapter':
								return `adapter:${row.adapter.id}`;
							case 'entry':
								return `entry:${row.adapter.id}:${row.entry.key}`;
							case 'empty':
								return row.id;
							case 'validationHeader':
								return 'validation-header';
							case 'validation':
								return `validation:${row.result.adapterId}:${row.result.key}`;
						}
					}}
					renderItem={({ item: row }) => {
						switch (row.kind) {
							case 'empty':
								return <EmptyState>{row.message}</EmptyState>;
							case 'adapter':
								return (
									<View style={styles.adapterHeader}>
										<View style={styles.adapterCopy}>
											<Text style={styles.adapterTitle}>
												{row.adapter.title}
											</Text>
											<Text style={styles.adapterDescription}>
												{row.snapshot.error ??
													row.adapter.description ??
													`${row.snapshot.entries.length} keys`}
											</Text>
										</View>
										{row.adapter.clear ? (
											<PanelButton
												label="Clear"
												onPress={() =>
													runMutation(
														'Clear storage adapter',
														() => row.adapter.clear?.(),
														{
															title: `Clear ${row.adapter.title}?`,
															message: 'This cannot be undone.',
															confirmLabel: 'Clear',
															destructive: true,
														},
													)
												}
												tone="danger"
											/>
										) : null}
									</View>
								);
							case 'entry':
								return (
									<StorageEntry
										adapter={row.adapter}
										entry={row.entry}
										runMutation={runMutation}
									/>
								);
							case 'event':
								return (
									<DisclosureCard
										leading={
											<View
												style={[
													styles.eventDot,
													{
														backgroundColor:
															row.event.type === 'removed'
																? colors.red
																: row.event.type === 'added'
																	? colors.green
																	: colors.blue,
													},
												]}
											/>
										}
										title={row.event.key}
										subtitle={`${row.event.type} · ${row.event.adapterTitle} · ${new Date(row.event.at).toLocaleTimeString()}`}
									>
										<Text style={styles.protectedText}>
											{row.event.valueHidden
												? 'This protected value was never read.'
												: 'Captured by the registered adapter subscription.'}
										</Text>
										{row.event.previousValue !== undefined ? (
											<Text selectable style={styles.eventValue}>
												Previous: {row.event.previousValue}
											</Text>
										) : null}
										{row.event.value !== undefined ? (
											<Text selectable style={styles.eventValue}>
												Current: {row.event.value}
											</Text>
										) : null}
									</DisclosureCard>
								);
							case 'validationHeader':
								return <Text style={styles.adapterTitle}>Expected keys</Text>;
							case 'validation':
								return (
									<DisclosureCard
										leading={
											<View
												style={[
													styles.eventDot,
													{
														backgroundColor:
															row.result.status === 'valid' ||
															row.result.status === 'protected'
																? colors.green
																: colors.red,
													},
												]}
											/>
										}
										title={row.result.key}
										subtitle={`${row.result.adapterId} · ${row.result.status}`}
									>
										{row.result.description ? (
											<Text style={styles.protectedText}>
												{row.result.description}
											</Text>
										) : null}
										<Text style={styles.eventValue}>
											Expected: {row.result.expectedType ?? 'present'}
											{row.result.actualType
												? ` · Actual: ${row.result.actualType}`
												: ''}
										</Text>
									</DisclosureCard>
								);
						}
					}}
				/>
			</PanelScaffold>
		);
	}

	const plugin: DevToolsPanelPlugin = {
		id,
		title,
		description,
		systemImage,
		section,
		Panel: StoragePanel,
		install: () => {
			installCount += 1;
			if (installCount === 1) {
				lifecycleGeneration += 1;
				void refresh();
				const installedSubscriptions: Array<() => void> = [];
				try {
					for (const adapter of adapters) {
						if (adapter.subscribe) {
							installedSubscriptions.push(adapter.subscribe(scheduleRefresh));
						}
					}
					subscriptions = installedSubscriptions;
				} catch (error) {
					for (const unsubscribe of installedSubscriptions) {
						try {
							unsubscribe();
						} catch {
							// Continue rollback so one broken adapter cannot leak others.
						}
					}
					installCount = 0;
					lifecycleGeneration += 1;
					throw error;
				}
			}
			return () => {
				installCount = Math.max(0, installCount - 1);
				if (installCount === 0) {
					lifecycleGeneration += 1;
					for (const unsubscribe of subscriptions) {
						try {
							unsubscribe();
						} catch {
							// Dispose every adapter even if one listener throws.
						}
					}
					subscriptions = [];
					refreshRequested = false;
				}
			};
		},
	};

	return {
		plugin,
		refresh,
		getSnapshot: store.getSnapshot,
		getEvents: eventStore.getSnapshot,
		clearEvents: eventStore.clear,
	};
}

const styles = StyleSheet.create({
	panelHeader: { gap: 10 },
	metrics: { flexDirection: 'row', gap: 7 },
	metric: {
		alignItems: 'center',
		backgroundColor: colors.card,
		borderRadius: 13,
		flex: 1,
		paddingVertical: 10,
	},
	metricValue: { color: colors.label, fontSize: 19, fontWeight: '700' },
	metricLabel: { color: colors.secondaryLabel, fontSize: 10, marginTop: 2 },
	eventDot: { borderRadius: 5, height: 10, marginRight: 12, width: 10 },
	eventValue: {
		color: colors.label,
		fontFamily: 'Menlo',
		fontSize: 11,
		lineHeight: 17,
		marginTop: 8,
	},
	adapterHeader: {
		alignItems: 'center',
		flexDirection: 'row',
		gap: 10,
		paddingHorizontal: 4,
	},
	adapterCopy: {
		flex: 1,
		gap: 2,
	},
	adapterTitle: {
		color: colors.label,
		fontSize: 16,
		fontWeight: '700',
	},
	adapterDescription: {
		color: colors.secondaryLabel,
		fontSize: 12,
	},
	protectedText: {
		color: colors.secondaryLabel,
		fontSize: 13,
		lineHeight: 19,
	},
	editor: {
		backgroundColor: colors.background,
		borderColor: colors.separator,
		borderRadius: 10,
		borderWidth: StyleSheet.hairlineWidth,
		color: colors.label,
		fontFamily: 'Menlo',
		fontSize: 11,
		marginBottom: 10,
		maxHeight: 240,
		minHeight: 72,
		padding: 10,
		textAlignVertical: 'top',
	},
});
