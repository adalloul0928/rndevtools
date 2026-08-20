import {
	Button,
	ContentUnavailableView,
	DisclosureGroup,
	Host,
	HStack,
	Image,
	Label,
	LabeledContent,
	List,
	Picker,
	Section,
	Spacer,
	TextField,
	Text as UIText,
	useNativeState,
	VStack,
} from '@expo/ui/swift-ui';
import {
	autocorrectionDisabled,
	font,
	foregroundStyle,
	lineLimit,
	listRowBackground,
	listStyle,
	pickerStyle,
	refreshable,
	tag,
} from '@expo/ui/swift-ui/modifiers';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, PlatformColor } from 'react-native';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { assertPositiveFinite } from '../core/options';
import { serializeValue } from '../core/serialize';
import type {
	DevToolsActionConfirmation,
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';
import { formatNetworkBytes } from './network-capture';
import { formatRelativeTime } from './query';
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

/** Plain uppercased section header (SwiftUI headers strip interactivity). */
function SectionInfoHeader({ title }: { title: string }) {
	return (
		<UIText
			modifiers={[
				font({ textStyle: 'footnote' }),
				foregroundStyle('secondary'),
			]}
		>
			{title.toUpperCase()}
		</UIText>
	);
}

type StorageTab = 'stores' | 'activity';

type RunStorageMutation = (
	label: string,
	mutation: () => void | Promise<void>,
	confirmation?: DevToolsActionConfirmation,
) => void;

function describeValueLength(chars: number): string {
	if (chars >= 1024) return formatNetworkBytes(chars);
	return chars === 1 ? '1 char' : `${chars} chars`;
}

function countStorageChars(adapter: StorageAdapterSnapshot): number {
	return adapter.entries.reduce(
		(sum, entry) => sum + (entry.value?.length ?? 0),
		0,
	);
}

function pluralizeKeys(count: number): string {
	return count === 1 ? '1 key' : `${count} keys`;
}

function storageKeyPrefix(key: string): string {
	const separator = key.search(/[/.]/);
	return separator > 0 ? key.slice(0, separator) : 'other';
}

function storageKeyTail(key: string): string {
	const separator = key.search(/[/.]/);
	return separator > 0 ? key.slice(separator + 1) : key;
}

type StorageKeyGroup = {
	prefix: string;
	entries: StorageEntrySnapshot[];
};

function groupStorageEntries(
	entries: readonly StorageEntrySnapshot[],
): StorageKeyGroup[] {
	const groups = new Map<string, StorageEntrySnapshot[]>();
	for (const entry of entries) {
		const prefix = storageKeyPrefix(entry.key);
		const group = groups.get(prefix);
		if (group) group.push(entry);
		else groups.set(prefix, [entry]);
	}
	return [...groups.entries()].map(([prefix, grouped]) => ({
		prefix,
		entries: grouped,
	}));
}

function describeStorageGroup(group: StorageKeyGroup): string {
	const chars = group.entries.reduce(
		(sum, entry) => sum + (entry.value?.length ?? 0),
		0,
	);
	const size = chars >= 1024 ? ` · ${formatNetworkBytes(chars)}` : '';
	return `${group.prefix} · ${pluralizeKeys(group.entries.length)}${size}`;
}

function describeAdapterSnapshot(adapter: StorageAdapterSnapshot): string {
	if (adapter.error) return `Unavailable · ${adapter.error}`;
	const parts = [adapter.description, pluralizeKeys(adapter.entries.length)];
	if (adapter.sensitive) parts.push('values hidden');
	else {
		const chars = countStorageChars(adapter);
		if (chars > 0) parts.push(formatNetworkBytes(chars));
	}
	return parts.filter(Boolean).join(' · ');
}

function describeStorageEntry(entry: StorageEntrySnapshot): string {
	if (entry.valueHidden) return 'Value protected';
	if (entry.readError) return `Read failed · ${entry.readError}`;
	if (entry.binary) return 'Binary value · editing disabled';
	const sized =
		entry.valueType === 'string' ||
		entry.valueType === 'object' ||
		entry.valueType === 'array';
	const size = sized
		? ` · ${describeValueLength(entry.value?.length ?? 0)}`
		: '';
	const truncated = entry.truncated ? ' · too large to edit' : '';
	return `${entry.valueType ?? 'unknown'}${size}${truncated}`;
}

function describeValidationIssue(result: StorageValidationResult): string {
	if (result.status === 'typeMismatch') {
		return `Expected ${result.expectedType}, found ${result.actualType ?? 'unknown'}`;
	}
	return 'Missing';
}

const storageEventPresentation: Record<
	StorageChangeEvent['type'],
	{ verb: string; systemImage: DevToolsSystemImage; color: string }
> = {
	added: { verb: 'Added', systemImage: 'plus', color: 'systemGreenColor' },
	updated: { verb: 'Updated', systemImage: 'pencil', color: 'systemBlueColor' },
	removed: { verb: 'Deleted', systemImage: 'minus', color: 'systemRedColor' },
};

function describeStorageEvent(event: StorageChangeEvent): string {
	const parts = [event.adapterTitle, new Date(event.at).toLocaleTimeString()];
	if (event.valueHidden) parts.push('value never read');
	else {
		const value = event.value ?? event.previousValue;
		if (value !== undefined) parts.push(describeValueLength(value.length));
	}
	return parts.join(' · ');
}

function StorageTabPicker({
	selection,
	onChange,
}: {
	selection: StorageTab;
	onChange: (tab: StorageTab) => void;
}) {
	return (
		<Section>
			<Picker
				label="Storage view"
				modifiers={[pickerStyle('segmented'), listRowBackground('clear')]}
				onSelectionChange={onChange}
				selection={selection}
			>
				<UIText modifiers={[tag('stores')]}>Stores</UIText>
				<UIText modifiers={[tag('activity')]}>Activity</UIText>
			</Picker>
		</Section>
	);
}

/** Verb-tinted icon row shared by recent activity and the activity log. */
function StorageEventLabel({
	event,
	detail,
}: {
	event: StorageChangeEvent;
	detail: string;
}) {
	const presentation = storageEventPresentation[event.type];
	return (
		<Label
			color={PlatformColor(presentation.color)}
			systemImage={presentation.systemImage}
		>
			<VStack alignment="leading" spacing={2}>
				<UIText>
					<UIText>{`${presentation.verb} `}</UIText>
					<UIText
						modifiers={[font({ design: 'monospaced', textStyle: 'footnote' })]}
					>
						{event.key}
					</UIText>
				</UIText>
				<UIText
					modifiers={[
						font({ textStyle: 'footnote' }),
						foregroundStyle('secondary'),
					]}
				>
					{detail}
				</UIText>
			</VStack>
		</Label>
	);
}

/** Activity row; updated events expand to a previous/current diff. */
function ActivityEventRow({ event }: { event: StorageChangeEvent }) {
	const row = (
		<StorageEventLabel detail={describeStorageEvent(event)} event={event} />
	);
	const hasDiff =
		event.type === 'updated' &&
		!event.valueHidden &&
		(event.previousValue !== undefined || event.value !== undefined);
	if (!hasDiff) return row;
	return (
		<DisclosureGroup>
			<DisclosureGroup.Label>{row}</DisclosureGroup.Label>
			{event.previousValue !== undefined ? (
				<UIText
					modifiers={[
						font({ design: 'monospaced', textStyle: 'footnote' }),
						foregroundStyle(PlatformColor('systemRedColor')),
						lineLimit(4),
					]}
				>
					{`- ${event.previousValue}`}
				</UIText>
			) : null}
			{event.value !== undefined ? (
				<UIText
					modifiers={[
						font({ design: 'monospaced', textStyle: 'footnote' }),
						foregroundStyle(PlatformColor('systemGreenColor')),
						lineLimit(4),
					]}
				>
					{`+ ${event.value}`}
				</UIText>
			) : null}
		</DisclosureGroup>
	);
}

/**
 * Expanded key detail: full key, value editor (when the entry is safely
 * editable), and destructive delete. Mounted only while expanded so the
 * draft reseeds from the snapshot on every expansion.
 */
function StorageEntryDetails({
	adapter,
	entry,
	runMutation,
}: {
	adapter: DevToolsStorageAdapter;
	entry: StorageEntrySnapshot;
	runMutation: RunStorageMutation;
}) {
	const [draft, setDraft] = useState(entry.value ?? '');
	const draftSeed = useNativeState(entry.value ?? '');
	const canEdit = isStorageEntryEditable(adapter, entry);
	return (
		<>
			<UIText
				modifiers={[
					font({ design: 'monospaced', textStyle: 'footnote' }),
					foregroundStyle('secondary'),
				]}
			>
				{entry.key}
			</UIText>
			{entry.valueHidden ? (
				<UIText
					modifiers={[
						font({ textStyle: 'footnote' }),
						foregroundStyle('secondary'),
					]}
				>
					This store exposes key metadata only. Its values are never read.
				</UIText>
			) : canEdit ? (
				<TextField
					axis="vertical"
					modifiers={[
						font({ design: 'monospaced', textStyle: 'footnote' }),
						autocorrectionDisabled(),
						lineLimit(8),
					]}
					onTextChange={setDraft}
					placeholder="Value"
					text={draftSeed}
				/>
			) : entry.value !== undefined ? (
				<UIText
					modifiers={[
						font({ design: 'monospaced', textStyle: 'footnote' }),
						lineLimit(8),
					]}
				>
					{entry.value}
				</UIText>
			) : null}
			{canEdit ? (
				<Button
					label="Save"
					onPress={() => {
						runMutation('Save storage value', () => {
							const parsed = adapter.parseValue
								? adapter.parseValue(entry.key, draft, entry.valueType ?? '')
								: parseStorageDraft(draft, entry.valueType ?? '');
							return adapter.setValue?.(entry.key, parsed);
						});
					}}
				/>
			) : null}
			{adapter.removeValue ? (
				// biome-ignore lint/a11y/useValidAriaRole: SwiftUI ButtonRole, not ARIA
				<Button
					label="Delete key"
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
					role="destructive"
				/>
			) : null}
		</>
	);
}

/** Key row in the store browser: mono tail, type · size, small-value badge. */
function StorageEntryRow({
	adapter,
	entry,
	expanded,
	onExpandedChange,
	runMutation,
}: {
	adapter: DevToolsStorageAdapter;
	entry: StorageEntrySnapshot;
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
	runMutation: RunStorageMutation;
}) {
	const smallValue =
		!entry.valueHidden &&
		!entry.readError &&
		!entry.binary &&
		!entry.truncated &&
		entry.value !== undefined &&
		entry.value.length <= 24
			? entry.valueType === 'string'
				? `"${entry.value}"`
				: entry.value
			: undefined;
	return (
		<DisclosureGroup
			isExpanded={expanded}
			onIsExpandedChange={onExpandedChange}
		>
			<DisclosureGroup.Label>
				<HStack spacing={10}>
					<VStack alignment="leading" spacing={2}>
						<UIText
							modifiers={[
								font({ design: 'monospaced', textStyle: 'subheadline' }),
							]}
						>
							{storageKeyTail(entry.key)}
						</UIText>
						<UIText
							modifiers={[
								font({ textStyle: 'footnote' }),
								foregroundStyle('secondary'),
							]}
						>
							{describeStorageEntry(entry)}
						</UIText>
					</VStack>
					<Spacer />
					{smallValue !== undefined ? (
						<UIText
							modifiers={[
								font({ design: 'monospaced', textStyle: 'footnote' }),
								foregroundStyle('secondary'),
								lineLimit(1),
							]}
						>
							{smallValue}
						</UIText>
					) : null}
				</HStack>
			</DisclosureGroup.Label>
			{expanded ? (
				<StorageEntryDetails
					adapter={adapter}
					entry={entry}
					key={`details:${entry.value ?? ''}`}
					runMutation={runMutation}
				/>
			) : null}
		</DisclosureGroup>
	);
}

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

	function StoragePanel({ onBack, actions }: DevToolsPanelProps) {
		const snapshot = useSyncExternalStore(
			store.subscribe,
			store.getSnapshot,
			store.getServerSnapshot,
		);
		const events = useSyncExternalStore(
			eventStore.subscribe,
			eventStore.getSnapshot,
			eventStore.getServerSnapshot,
		);
		const [tab, setTab] = useState<StorageTab>('stores');
		const [openAdapterId, setOpenAdapterId] = useState<string | null>(null);
		const [search, setSearch] = useState('');
		const [expandedKey, setExpandedKey] = useState<string | null>(null);

		const runMutation: RunStorageMutation = (label, mutation, confirmation) => {
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

		const openSnapshot = snapshot.adapters.find(
			(candidate) => candidate.id === openAdapterId,
		);
		const openAdapter = adapters.find(
			(candidate) => candidate.id === openAdapterId,
		);
		const browsing =
			openSnapshot && openAdapter
				? { adapter: openAdapter, snapshot: openSnapshot }
				: undefined;

		const validation = useMemo(
			() => validateStorageSnapshot(snapshot, rules),
			[snapshot],
		);
		const failing = validation.filter(
			(result) =>
				result.status === 'missing' || result.status === 'typeMismatch',
		);

		const openStore = (adapterId: string) => {
			setSearch('');
			setExpandedKey(null);
			setOpenAdapterId(adapterId);
		};

		const now = Date.now();
		const recentEvents = events.slice(-3).reverse();
		const orderedEvents = [...events].reverse();
		const activitySections = [
			{
				title: 'Just now',
				events: orderedEvents.filter((event) => now - event.at < 60_000),
			},
			{
				title: 'Earlier this session',
				events: orderedEvents.filter((event) => now - event.at >= 60_000),
			},
		].filter((ageGroup) => ageGroup.events.length > 0);

		const totalChars = snapshot.adapters.reduce(
			(sum, adapter) => sum + countStorageChars(adapter),
			0,
		);

		const needle = search.trim().toLowerCase();
		const visibleEntries = browsing
			? browsing.snapshot.entries.filter(
					(entry) => !needle || entry.key.toLowerCase().includes(needle),
				)
			: [];
		const groups = groupStorageEntries(visibleEntries);

		return (
			<PanelShell
				backLabel={browsing ? title : undefined}
				onBack={browsing ? () => setOpenAdapterId(null) : onBack}
				title={browsing ? browsing.snapshot.title : title}
				trailing={
					browsing?.adapter.clear ? (
						<NavIconButton
							accessibilityLabel={`Clear ${browsing.snapshot.title}`}
							destructive
							onPress={() =>
								runMutation(
									'Clear storage adapter',
									() => browsing.adapter.clear?.(),
									{
										title: `Clear ${browsing.snapshot.title}?`,
										message: 'This cannot be undone.',
										confirmLabel: 'Clear',
										destructive: true,
									},
								)
							}
							systemImage="trash"
							testID="devtools-storage-clear-store"
						/>
					) : !browsing && tab === 'activity' ? (
						<NavIconButton
							accessibilityLabel="Clear activity"
							destructive
							onPress={() =>
								runMutation('Clear storage activity', eventStore.clear, {
									title: 'Clear recorded activity?',
									message:
										'The captured reads and writes are only held in memory, so this cannot be undone.',
									confirmLabel: 'Clear',
									destructive: true,
								})
							}
							systemImage="trash"
							testID="devtools-storage-clear-activity"
						/>
					) : undefined
				}
			>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						{browsing ? (
							<List
								key={`store:${browsing.snapshot.id}`}
								modifiers={[listStyle('insetGrouped'), refreshable(refresh)]}
							>
								<Section>
									<TextField
										modifiers={[autocorrectionDisabled()]}
										onTextChange={setSearch}
										placeholder={`Search ${pluralizeKeys(browsing.snapshot.entries.length)}`}
									/>
								</Section>
								{browsing.snapshot.error ? (
									<Section>
										<Label
											color={PlatformColor('systemOrangeColor')}
											systemImage="exclamationmark.triangle.fill"
											title="Store unavailable"
										/>
										<UIText
											modifiers={[
												font({ textStyle: 'footnote' }),
												foregroundStyle('secondary'),
											]}
										>
											{browsing.snapshot.error}
										</UIText>
									</Section>
								) : null}
								{groups.length === 0 ? (
									<Section>
										<ContentUnavailableView
											description={
												needle
													? `No keys match "${search.trim()}".`
													: 'This store is empty.'
											}
											systemImage={needle ? 'magnifyingglass' : 'externaldrive'}
											title={needle ? 'No matching keys' : 'No keys'}
										/>
									</Section>
								) : (
									groups.map((group, index) => (
										<Section
											header={
												index === 0 ? (
													<SectionInfoHeader
														title={describeStorageGroup(group)}
													/>
												) : undefined
											}
											key={group.prefix}
											title={
												index === 0 ? undefined : describeStorageGroup(group)
											}
										>
											{group.entries.map((entry) => (
												<StorageEntryRow
													adapter={browsing.adapter}
													entry={entry}
													expanded={expandedKey === entry.key}
													key={entry.key}
													onExpandedChange={(next) =>
														setExpandedKey(next ? entry.key : null)
													}
													runMutation={runMutation}
												/>
											))}
										</Section>
									))
								)}
							</List>
						) : tab === 'stores' ? (
							<List
								modifiers={[listStyle('insetGrouped'), refreshable(refresh)]}
							>
								<StorageTabPicker onChange={setTab} selection={tab} />
								<Section
									header={
										<SectionInfoHeader
											title={
												totalChars > 0
													? `On this device · ${formatNetworkBytes(totalChars)}`
													: 'On this device'
											}
										/>
									}
								>
									{snapshot.adapters.length === 0 ? (
										<ContentUnavailableView
											description="No storage adapters are registered."
											systemImage="externaldrive"
											title="No stores"
										/>
									) : (
										snapshot.adapters.map((adapterSnapshot) => (
											<Button
												key={adapterSnapshot.id}
												onPress={() => openStore(adapterSnapshot.id)}
											>
												<HStack spacing={12}>
													<Image
														color={
															adapterSnapshot.sensitive
																? PlatformColor('systemYellowColor')
																: PlatformColor('systemGrayColor')
														}
														size={20}
														systemName={
															adapterSnapshot.sensitive
																? 'lock.fill'
																: 'externaldrive.fill'
														}
													/>
													<VStack alignment="leading" spacing={2}>
														<UIText
															modifiers={[
																foregroundStyle(PlatformColor('labelColor')),
															]}
														>
															{adapterSnapshot.title}
														</UIText>
														<UIText
															modifiers={[
																font({ textStyle: 'footnote' }),
																foregroundStyle('secondary'),
															]}
														>
															{describeAdapterSnapshot(adapterSnapshot)}
														</UIText>
													</VStack>
													<Spacer />
													<Image
														color={PlatformColor('tertiaryLabelColor')}
														size={13}
														systemName="chevron.right"
													/>
												</HStack>
											</Button>
										))
									)}
								</Section>
								{validation.length > 0 ? (
									<Section title="Health">
										{failing.length === 0 ? (
											<Label
												color={PlatformColor('systemGreenColor')}
												systemImage="checkmark.circle.fill"
												title={`All expected keys present · ${validation.length} ${validation.length === 1 ? 'check' : 'checks'}`}
											/>
										) : (
											<>
												<Label
													color={PlatformColor('systemOrangeColor')}
													systemImage="exclamationmark.triangle.fill"
													title={`${failing.length} of ${validation.length} ${validation.length === 1 ? 'check' : 'checks'} failing`}
												/>
												{failing.map((result) => (
													<DisclosureGroup
														key={`${result.adapterId}:${result.key}`}
														label={`${result.key} — ${describeValidationIssue(result)}`}
													>
														{result.description ? (
															<UIText>{result.description}</UIText>
														) : null}
														<LabeledContent label="Store">
															<UIText>{result.adapterId}</UIText>
														</LabeledContent>
														<LabeledContent label="Expected">
															<UIText>
																{result.expectedType ?? 'present'}
															</UIText>
														</LabeledContent>
														{result.actualType ? (
															<LabeledContent label="Actual">
																<UIText>{result.actualType}</UIText>
															</LabeledContent>
														) : null}
													</DisclosureGroup>
												))}
											</>
										)}
									</Section>
								) : null}
								<Section header={<SectionInfoHeader title="Recent activity" />}>
									{recentEvents.length === 0 ? (
										<UIText
											modifiers={[
												font({ textStyle: 'footnote' }),
												foregroundStyle('secondary'),
											]}
										>
											No changes recorded this session.
										</UIText>
									) : (
										recentEvents.map((event) => (
											<StorageEventLabel
												detail={`${event.adapterTitle} · ${formatRelativeTime(event.at, now)}`}
												event={event}
												key={event.id}
											/>
										))
									)}
									<Button
										label="See all activity"
										onPress={() => setTab('activity')}
									/>
								</Section>
							</List>
						) : (
							<List modifiers={[listStyle('insetGrouped')]}>
								<StorageTabPicker onChange={setTab} selection={tab} />
								{activitySections.length === 0 ? (
									<Section>
										<ContentUnavailableView
											description="Storage mutations will appear here."
											systemImage="clock.arrow.circlepath"
											title="No storage activity"
										/>
									</Section>
								) : (
									activitySections.map((ageGroup, index) => (
										<Section
											header={
												index === 0 ? (
													<SectionInfoHeader title={ageGroup.title} />
												) : undefined
											}
											key={ageGroup.title}
											title={index === 0 ? undefined : ageGroup.title}
										>
											{ageGroup.events.map((event) => (
												<ActivityEventRow event={event} key={event.id} />
											))}
										</Section>
									))
								)}
							</List>
						)}
					</Host>
				) : null}
			</PanelShell>
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
