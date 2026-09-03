import {
	Button,
	ContentUnavailableView,
	DisclosureGroup,
	Host,
	Label,
	LabeledContent,
	List,
	Section,
	TextField,
	Text as UIText,
} from '@expo/ui/swift-ui';
import {
	autocorrectionDisabled,
	font,
	foregroundStyle,
	lineLimit,
	listStyle,
} from '@expo/ui/swift-ui/modifiers';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSearch,
	AndroidPanelSection,
	AndroidPanelTextBlock,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { formatBytes, formatRelativeTime } from '../core/format';
import { assertPositiveFinite, assertPositiveInteger } from '../core/options';
import {
	diagnosticErrorText,
	sanitizeDiagnosticValue,
	sanitizeDiagnosticValueWithMetadata,
} from '../core/redact';
import { serializeValue, truncateText } from '../core/serialize';
import type {
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';

/**
 * A deliberately projected Zustand store. The host owns the projection so the
 * inspector never reaches into a global store registry or serializes raw state.
 */
export type DevToolsZustandAdapter = {
	id: string;
	title: string;
	description?: string;
	getInspectableState: () => unknown;
	subscribe: (listener: () => void) => () => void;
};

export type ZustandStoreSnapshot = {
	id: string;
	title: string;
	description?: string;
	stateText: string;
	stateBytes: number;
	truncated: boolean;
	keys: readonly string[];
	updatedAt: number;
	error?: string;
};

export type ZustandInspectorSnapshot = {
	stores: readonly ZustandStoreSnapshot[];
	totalStoreCount: number;
	omittedStoreCount: number;
	truncated: boolean;
	error?: string;
};

export type ZustandChangeEvent = {
	id: number;
	at: number;
	storeId: string;
	storeTitle: string;
	changedKeys: readonly string[];
	stateText: string;
	truncated: boolean;
	error?: string;
};

export type ZustandPluginOptions = {
	stores:
		| readonly DevToolsZustandAdapter[]
		| (() => readonly DevToolsZustandAdapter[]);
	subscribeToStores?: (listener: () => void) => () => void;
	maxValueBytes?: number;
	maxStores?: number;
	maxSnapshotBytes?: number;
	maxEvents?: number;
	maxEventBytes?: number;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
};

export type ZustandPlugin = {
	plugin: DevToolsPanelPlugin;
	refresh: () => void;
	getSnapshot: () => ZustandInspectorSnapshot;
	getEvents: () => readonly ZustandChangeEvent[];
	clearEvents: () => void;
};

type StoreFingerprints = Readonly<Record<string, string>>;

type ZustandSubscription = {
	adapter: DevToolsZustandAdapter;
	dispose: () => void;
	active: boolean;
	captureQueued: boolean;
};
const MAX_INSPECTABLE_KEYS = 500;
const MAX_INSPECTABLE_STORES = 500;
const MAX_ZUSTAND_VALUE_BYTES = 1024 * 1024;
const MAX_ZUSTAND_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_ZUSTAND_EVENTS = 10_000;
const MAX_ZUSTAND_EVENT_BYTES = 16 * 1024 * 1024;

function errorMessage(error: unknown): string {
	return diagnosticErrorText(error);
}

function inspectableKeys(value: unknown): readonly string[] {
	if (Array.isArray(value))
		return [
			'length',
			...value.slice(0, MAX_INSPECTABLE_KEYS - 1).map((_, index) => `${index}`),
		];
	if (value && typeof value === 'object')
		return Object.keys(value).sort().slice(0, MAX_INSPECTABLE_KEYS);
	return ['value'];
}

function inspectableObjectKeys(value: object): readonly string[] {
	return Object.keys(value).sort().slice(0, MAX_INSPECTABLE_KEYS);
}

/**
 * Fingerprints drive the change log, so a truncated prefix would hide any edit
 * that lands past the cut. Hash the whole projection instead: JSON.stringify
 * materializes the full string regardless of the retained budget, so hashing
 * costs no extra serialization and retains far less per key. Values that
 * exceed `maxValueBytes` still compare on their retained prefix, which the
 * `truncated` flag records.
 */
function fingerprintValue(value: unknown, maxValueBytes: number): string {
	const { text, truncated } = serializeValue(
		sanitizeDiagnosticValue(value),
		maxValueBytes,
	);
	let hash = 2_166_136_261;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return `${text.length}:${(hash >>> 0).toString(36)}${truncated ? ':t' : ''}`;
}

function topLevelFingerprints(
	value: unknown,
	maxValueBytes: number,
): StoreFingerprints {
	if (!value || typeof value !== 'object') {
		return { value: fingerprintValue(value, maxValueBytes) };
	}
	if (Array.isArray(value)) {
		return Object.fromEntries([
			['length', String(value.length)],
			...value
				.slice(0, MAX_INSPECTABLE_KEYS - 1)
				.map((entry, index) => [
					String(index),
					fingerprintValue(entry, maxValueBytes),
				]),
		]);
	}
	return Object.fromEntries(
		inspectableObjectKeys(value).map((key) => [
			key,
			fingerprintValue((value as Record<string, unknown>)[key], maxValueBytes),
		]),
	);
}

export function changedZustandKeys(
	previous: StoreFingerprints | undefined,
	next: StoreFingerprints,
): readonly string[] {
	if (!previous) return Object.keys(next).sort();
	return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
		.filter((key) => previous[key] !== next[key])
		.sort()
		.slice(0, MAX_INSPECTABLE_KEYS);
}

function describeStore(snapshot: ZustandStoreSnapshot): string {
	if (snapshot.error) return `Unavailable · ${snapshot.error}`;
	const keyCount = snapshot.keys.length;
	const keyLabel = keyCount === 1 ? '1 field' : `${keyCount} fields`;
	const truncated = snapshot.truncated ? ' · preview truncated' : '';
	return `${keyLabel} · ${formatBytes(snapshot.stateBytes)}${truncated}`;
}

function changeLabel(event: ZustandChangeEvent): string {
	if (event.error) return event.error;
	if (event.changedKeys.length === 0) return 'Projection refreshed';
	if (event.changedKeys.length <= 3) return event.changedKeys.join(', ');
	return `${event.changedKeys.slice(0, 3).join(', ')} +${event.changedKeys.length - 3}`;
}

export function createZustandPlugin(
	options: ZustandPluginOptions,
): ZustandPlugin {
	const title = options.title ?? 'Zustand';
	const id = options.id ?? 'zustand';
	const maxValueBytes = options.maxValueBytes ?? 64 * 1024;
	const maxStores = options.maxStores ?? 50;
	const maxSnapshotBytes = options.maxSnapshotBytes ?? 2 * 1024 * 1024;
	const maxEvents = options.maxEvents ?? 100;
	const maxEventBytes = options.maxEventBytes ?? 512 * 1024;
	assertPositiveFinite(maxValueBytes, 'maxValueBytes');
	assertPositiveInteger(maxStores, 'maxStores');
	if (maxStores > MAX_INSPECTABLE_STORES) {
		throw new Error(`maxStores cannot exceed ${MAX_INSPECTABLE_STORES}`);
	}
	assertPositiveFinite(maxSnapshotBytes, 'maxSnapshotBytes');
	assertPositiveInteger(maxEvents, 'maxEvents');
	assertPositiveFinite(maxEventBytes, 'maxEventBytes');
	if (maxValueBytes > MAX_ZUSTAND_VALUE_BYTES) {
		throw new Error(`maxValueBytes cannot exceed ${MAX_ZUSTAND_VALUE_BYTES}`);
	}
	if (maxSnapshotBytes > MAX_ZUSTAND_SNAPSHOT_BYTES) {
		throw new Error(
			`maxSnapshotBytes cannot exceed ${MAX_ZUSTAND_SNAPSHOT_BYTES}`,
		);
	}
	if (maxEvents > MAX_ZUSTAND_EVENTS) {
		throw new Error(`maxEvents cannot exceed ${MAX_ZUSTAND_EVENTS}`);
	}
	if (maxEventBytes > MAX_ZUSTAND_EVENT_BYTES) {
		throw new Error(`maxEventBytes cannot exceed ${MAX_ZUSTAND_EVENT_BYTES}`);
	}

	const snapshotStore = new ExternalStore<ZustandInspectorSnapshot>({
		stores: [],
		totalStoreCount: 0,
		omittedStoreCount: 0,
		truncated: false,
	});
	const eventStore = new BoundedEventStore<ZustandChangeEvent>({
		maxEvents,
		maxBytes: maxEventBytes,
		estimateBytes: (event) =>
			serializeValue(event, maxValueBytes + 8 * 1024).estimatedBytes,
	});
	const snapshots = new Map<string, ZustandStoreSnapshot>();
	const snapshotSizes = new Map<string, number>();
	const fingerprints = new Map<string, StoreFingerprints>();
	const subscriptions = new Map<string, ZustandSubscription>();
	let installCount = 0;
	let nextEventId = 1;
	let storeRegistrySubscription:
		| { active: boolean; dispose: () => void }
		| undefined;
	let totalStoreCount = 0;
	const normalizedAdapterCache = new WeakMap<object, DevToolsZustandAdapter>();

	const getAdapters = (): unknown =>
		typeof options.stores === 'function' ? options.stores() : options.stores;
	const adapterField = (adapter: object, key: string): unknown => {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(adapter, key);
		} catch {
			throw new Error(`Zustand adapter field ${key} is unreadable.`);
		}
		if (!descriptor || !('value' in descriptor)) {
			throw new Error(`Zustand adapter field ${key} must be plain data.`);
		}
		return descriptor.value;
	};
	const normalizeAdapter = (candidate: unknown): DevToolsZustandAdapter => {
		if (!candidate || typeof candidate !== 'object') {
			throw new Error('Zustand adapters must be objects.');
		}
		const cached = normalizedAdapterCache.get(candidate);
		if (cached) return cached;
		const id = adapterField(candidate, 'id');
		const title = adapterField(candidate, 'title');
		let description: unknown;
		try {
			const descriptor = Object.getOwnPropertyDescriptor(
				candidate,
				'description',
			);
			if (descriptor && !('value' in descriptor)) {
				throw new Error(
					'Zustand adapter field description must be plain data.',
				);
			}
			description = descriptor?.value;
		} catch (error) {
			if (error instanceof Error) throw error;
			throw new Error('Zustand adapter field description is unreadable.');
		}
		const getInspectableState = adapterField(candidate, 'getInspectableState');
		const subscribe = adapterField(candidate, 'subscribe');
		if (typeof id !== 'string' || !id.trim() || id !== id.trim()) {
			throw new Error(
				'Zustand adapter ids must be non-empty and cannot have surrounding whitespace.',
			);
		}
		if (id.length > 256) {
			throw new Error('Zustand adapter ids cannot exceed 256 characters.');
		}
		if (typeof title !== 'string' || !title.trim() || title.length > 4 * 1024) {
			throw new Error(
				'Zustand adapter titles must be non-empty and at most 4096 characters.',
			);
		}
		if (
			description !== undefined &&
			(typeof description !== 'string' || description.length > 4 * 1024)
		) {
			throw new Error(
				'Zustand adapter descriptions cannot exceed 4096 characters.',
			);
		}
		if (
			typeof getInspectableState !== 'function' ||
			typeof subscribe !== 'function'
		) {
			throw new Error(
				'Zustand adapters require projection and subscription callbacks.',
			);
		}
		const adapter: DevToolsZustandAdapter = {
			id,
			title,
			...(typeof description === 'string' ? { description } : {}),
			getInspectableState: getInspectableState as () => unknown,
			subscribe: subscribe as (listener: () => void) => () => void,
		};
		normalizedAdapterCache.set(candidate, adapter);
		return adapter;
	};

	const validatedAdapters = (): readonly DevToolsZustandAdapter[] => {
		const rawAdapters = getAdapters();
		if (!Array.isArray(rawAdapters)) {
			throw new Error('Zustand adapters must be returned as an array.');
		}
		let rawAdapterCount: number;
		try {
			const descriptor = Object.getOwnPropertyDescriptor(rawAdapters, 'length');
			if (
				!descriptor ||
				!('value' in descriptor) ||
				!Number.isSafeInteger(descriptor.value) ||
				descriptor.value < 0
			) {
				throw new Error('invalid length');
			}
			rawAdapterCount = descriptor.value;
		} catch {
			throw new Error('Zustand adapter list has an invalid length.');
		}
		totalStoreCount = rawAdapterCount;
		const selectedAdapters: DevToolsZustandAdapter[] = [];
		for (
			let index = 0;
			index < Math.min(rawAdapterCount, maxStores);
			index += 1
		) {
			let descriptor: PropertyDescriptor | undefined;
			try {
				descriptor = Object.getOwnPropertyDescriptor(
					rawAdapters,
					String(index),
				);
			} catch {
				throw new Error('Zustand adapter list contains an unreadable item.');
			}
			if (!descriptor || !('value' in descriptor)) {
				throw new Error(
					'Zustand adapter lists cannot contain holes or accessors.',
				);
			}
			selectedAdapters.push(normalizeAdapter(descriptor.value));
		}
		const ids = new Set<string>();
		for (const adapter of selectedAdapters) {
			if (ids.has(adapter.id)) {
				throw new Error(`Duplicate Zustand adapter id: ${adapter.id}`);
			}
			ids.add(adapter.id);
		}
		return selectedAdapters;
	};

	const reportError = (error: unknown): void => {
		snapshotStore.set({
			...snapshotStore.getSnapshot(),
			error: truncateText(errorMessage(error), 8 * 1024).text,
		});
	};
	const retainSnapshot = (snapshot: ZustandStoreSnapshot): void => {
		const serialized = serializeValue(
			snapshot,
			Math.ceil(maxSnapshotBytes) + 1,
		);
		snapshots.set(snapshot.id, snapshot);
		snapshotSizes.set(
			snapshot.id,
			serialized.truncated
				? Math.ceil(maxSnapshotBytes) + 1
				: serialized.estimatedBytes,
		);
	};

	const publish = (adapters: readonly DevToolsZustandAdapter[]) => {
		const stores: ZustandStoreSnapshot[] = [];
		let snapshotBytes = 0;
		for (const adapter of adapters) {
			const snapshot = snapshots.get(adapter.id);
			if (!snapshot) continue;
			const nextBytes =
				snapshotSizes.get(adapter.id) ?? Math.ceil(maxSnapshotBytes) + 1;
			if (snapshotBytes + nextBytes > maxSnapshotBytes) continue;
			snapshotBytes += nextBytes;
			stores.push(snapshot);
		}
		const omittedStoreCount = Math.max(0, totalStoreCount - stores.length);
		snapshotStore.set({
			stores,
			totalStoreCount,
			omittedStoreCount,
			truncated: omittedStoreCount > 0,
		});
	};

	const capture = (
		adapter: DevToolsZustandAdapter,
		recordChange: boolean,
	): void => {
		const at = Date.now();
		let nextFingerprints: StoreFingerprints = {};
		let snapshot: ZustandStoreSnapshot;
		try {
			const projectedState = adapter.getInspectableState();
			const sanitized = sanitizeDiagnosticValueWithMetadata(projectedState);
			const serialized = serializeValue(sanitized.value, maxValueBytes);
			nextFingerprints = topLevelFingerprints(sanitized.value, maxValueBytes);
			snapshot = {
				id: adapter.id,
				title: adapter.title,
				description: adapter.description,
				stateText: serialized.text,
				stateBytes: serialized.estimatedBytes,
				truncated: serialized.truncated || sanitized.truncated,
				keys: inspectableKeys(sanitized.value),
				updatedAt: at,
			};
		} catch (error) {
			const message = truncateText(errorMessage(error), 8 * 1024).text;
			snapshot = {
				id: adapter.id,
				title: adapter.title,
				description: adapter.description,
				stateText: '',
				stateBytes: 0,
				truncated: false,
				keys: [],
				updatedAt: at,
				error: message,
			};
		}

		const previousSnapshot = snapshots.get(adapter.id);
		const changedKeys = changedZustandKeys(
			fingerprints.get(adapter.id),
			nextFingerprints,
		);
		fingerprints.set(adapter.id, nextFingerprints);
		retainSnapshot(snapshot);
		if (
			recordChange &&
			(changedKeys.length > 0 || previousSnapshot?.error !== snapshot.error)
		) {
			eventStore.append({
				id: nextEventId,
				at,
				storeId: adapter.id,
				storeTitle: adapter.title,
				changedKeys,
				stateText: snapshot.stateText,
				truncated: snapshot.truncated,
				error: snapshot.error,
			});
			nextEventId += 1;
		}
	};

	const refresh = (): void => {
		try {
			const adapters = validatedAdapters();
			for (const adapter of adapters) capture(adapter, false);
			const activeIds = new Set(adapters.map((adapter) => adapter.id));
			for (const storeId of snapshots.keys()) {
				if (!activeIds.has(storeId)) {
					snapshots.delete(storeId);
					snapshotSizes.delete(storeId);
					fingerprints.delete(storeId);
				}
			}
			publish(adapters);
		} catch (error) {
			reportError(error);
			throw error;
		}
	};

	const scheduleCapture = (subscription: ZustandSubscription): void => {
		if (subscription.captureQueued) return;
		subscription.captureQueued = true;
		const runCapture = () => {
			subscription.captureQueued = false;
			if (!subscription.active || installCount === 0) return;
			try {
				capture(subscription.adapter, true);
				publish(validatedAdapters());
			} catch (error) {
				reportError(error);
			}
		};
		try {
			queueMicrotask(runCapture);
		} catch (error) {
			subscription.captureQueued = false;
			reportError(error);
		}
	};

	const reconcileSubscriptions = (): void => {
		const adapters = validatedAdapters();
		const activeIds = new Set(adapters.map((adapter) => adapter.id));
		for (const [storeId, subscription] of subscriptions) {
			const nextAdapter = adapters.find((adapter) => adapter.id === storeId);
			if (!activeIds.has(storeId) || nextAdapter !== subscription.adapter) {
				subscription.active = false;
				try {
					subscription.dispose();
				} catch {
					// A diagnostic adapter disposer must not interrupt the host app.
				}
				subscriptions.delete(storeId);
			}
		}
		for (const adapter of adapters) {
			if (subscriptions.has(adapter.id)) continue;
			capture(adapter, false);
			const subscription: ZustandSubscription = {
				adapter,
				dispose: () => {},
				active: true,
				captureQueued: false,
			};
			try {
				const dispose = adapter.subscribe(() => {
					if (!subscription.active || installCount === 0) return;
					// A capture sanitizes and serializes the whole projection several
					// times over. Host stores can call set() many times per frame (a
					// running workout ticks every second plus once per set edit), so
					// coalesce to one capture per task instead of one per set().
					scheduleCapture(subscription);
				});
				if (typeof dispose !== 'function') {
					throw new Error('Subscription did not return a disposer.');
				}
				subscription.dispose = dispose;
				subscriptions.set(adapter.id, subscription);
			} catch (error) {
				subscription.active = false;
				const subscriptionError = truncateText(
					`Subscription failed: ${errorMessage(error)}`,
					8 * 1024,
				).text;
				const snapshot = snapshots.get(adapter.id);
				if (snapshot) {
					retainSnapshot({
						...snapshot,
						updatedAt: Date.now(),
						error: subscriptionError,
					});
				}
				eventStore.append({
					id: nextEventId,
					at: Date.now(),
					storeId: adapter.id,
					storeTitle: adapter.title,
					changedKeys: [],
					stateText: '',
					truncated: false,
					error: subscriptionError,
				});
				nextEventId += 1;
			}
		}
		const activeSnapshots = new Set(adapters.map((adapter) => adapter.id));
		for (const storeId of snapshots.keys()) {
			if (!activeSnapshots.has(storeId)) {
				snapshots.delete(storeId);
				snapshotSizes.delete(storeId);
				fingerprints.delete(storeId);
			}
		}
		publish(adapters);
	};

	function ZustandPanel({ onBack, actions }: DevToolsPanelProps) {
		const snapshot = useSyncExternalStore(
			snapshotStore.subscribe,
			snapshotStore.getSnapshot,
			snapshotStore.getServerSnapshot,
		);
		const events = useSyncExternalStore(
			eventStore.subscribe,
			eventStore.getSnapshot,
			eventStore.getServerSnapshot,
		);
		const [search, setSearch] = useState('');
		const needle = search.trim().toLowerCase();
		const visibleStores = useMemo(
			() =>
				snapshot.stores.filter(
					(store) =>
						!needle ||
						store.title.toLowerCase().includes(needle) ||
						store.id.toLowerCase().includes(needle) ||
						store.keys.some((key) => key.toLowerCase().includes(needle)),
				),
			[snapshot.stores, needle],
		);
		const recentEvents = [...events].reverse().slice(0, 20);
		const now = Date.now();
		const clearRecordedChanges = () => {
			void actions.run({
				pluginId: id,
				label: 'Clear Zustand changes',
				action: eventStore.clear,
			});
		};

		return (
			<PanelShell
				onBack={onBack}
				title={title}
				trailing={
					<NavIconButton
						accessibilityLabel="Refresh Zustand projections"
						onPress={() => {
							void actions.run({
								pluginId: id,
								label: 'Refresh Zustand projections',
								action: refresh,
							});
						}}
						systemImage="arrow.clockwise"
						testID="devtools-zustand-refresh"
					/>
				}
			>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							<Section>
								<TextField
									modifiers={[autocorrectionDisabled()]}
									onTextChange={setSearch}
									placeholder="Search stores or fields"
								/>
							</Section>
							<Section
								footer={
									<UIText>
										Only host-declared projections are captured. Raw Zustand
										stores are never discovered automatically.
									</UIText>
								}
								title={`Stores · ${visibleStores.length}`}
							>
								{snapshot.error ? (
									<Label
										color={PlatformColor('systemOrangeColor')}
										systemImage="exclamationmark.triangle.fill"
										title={`Inspector unavailable · ${snapshot.error}`}
									/>
								) : null}
								{snapshot.truncated ? (
									<Label
										color={PlatformColor('systemOrangeColor')}
										systemImage="exclamationmark.triangle.fill"
										title={`${snapshot.omittedStoreCount} ${snapshot.omittedStoreCount === 1 ? 'store was' : 'stores were'} omitted by safe capture limits`}
									/>
								) : null}
								{visibleStores.length === 0 ? (
									<ContentUnavailableView
										description={
											needle
												? 'No registered projection matches this search.'
												: 'The host has not registered an inspectable store.'
										}
										systemImage="shippingbox"
										title={needle ? 'No matching stores' : 'No stores'}
									/>
								) : (
									visibleStores.map((store) => (
										<DisclosureGroup
											key={store.id}
											label={`${store.title} — ${describeStore(store)}`}
										>
											{store.description ? (
												<UIText>{store.description}</UIText>
											) : null}
											<LabeledContent label="Adapter">
												<UIText>{store.id}</UIText>
											</LabeledContent>
											<LabeledContent label="Updated">
												<UIText>
													{formatRelativeTime(store.updatedAt, now)}
												</UIText>
											</LabeledContent>
											{store.error ? (
												<Label
													color={PlatformColor('systemOrangeColor')}
													systemImage="exclamationmark.triangle.fill"
													title={store.error}
												/>
											) : (
												<UIText
													modifiers={[
														font({
															design: 'monospaced',
															textStyle: 'footnote',
														}),
														foregroundStyle('secondary'),
														lineLimit(20),
													]}
												>
													{store.stateText}
												</UIText>
											)}
										</DisclosureGroup>
									))
								)}
							</Section>
							<Section title={`Recent changes · ${recentEvents.length}`}>
								{recentEvents.length === 0 ? (
									<UIText modifiers={[foregroundStyle('secondary')]}>
										No projected state changes recorded this session.
									</UIText>
								) : (
									recentEvents.map((event) => (
										<DisclosureGroup
											key={event.id}
											label={`${event.storeTitle} — ${changeLabel(event)}`}
										>
											<UIText modifiers={[foregroundStyle('secondary')]}>
												{new Date(event.at).toLocaleTimeString()}
											</UIText>
											{event.stateText ? (
												<UIText
													modifiers={[
														font({
															design: 'monospaced',
															textStyle: 'footnote',
														}),
														lineLimit(12),
													]}
												>
													{event.stateText}
												</UIText>
											) : null}
										</DisclosureGroup>
									))
								)}
								{events.length > 0 ? (
									<Button
										label="Clear recorded changes"
										onPress={clearRecordedChanges}
									/>
								) : null}
							</Section>
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						<AndroidPanelSearch
							onChangeText={setSearch}
							placeholder="Search stores or fields"
							value={search}
						/>
						<AndroidPanelSection
							footer="Only host-declared projections are captured. Raw Zustand stores are never discovered automatically."
							title={`Stores · ${visibleStores.length}`}
						>
							{snapshot.error ? (
								<AndroidPanelRow
									detail={snapshot.error}
									label="Inspector unavailable"
									tone="warning"
								/>
							) : null}
							{snapshot.truncated ? (
								<AndroidPanelRow
									detail={`${snapshot.omittedStoreCount} ${snapshot.omittedStoreCount === 1 ? 'store was' : 'stores were'} omitted by safe capture limits.`}
									label="Capture limited"
									tone="warning"
								/>
							) : null}
							{visibleStores.length === 0 ? (
								<AndroidPanelRow
									detail={
										needle
											? 'No registered projection matches this search.'
											: 'The host has not registered an inspectable store.'
									}
									label={needle ? 'No matching stores' : 'No stores'}
								/>
							) : null}
						</AndroidPanelSection>
						{visibleStores.map((store) => (
							<AndroidPanelSection
								footer={store.description}
								key={store.id}
								title={store.title}
							>
								<AndroidPanelRow label="Adapter" value={store.id} />
								<AndroidPanelRow
									label="Updated"
									value={formatRelativeTime(store.updatedAt, now)}
								/>
								<AndroidPanelRow
									label="Projection"
									value={describeStore(store)}
								/>
								<AndroidPanelTextBlock
									label={store.error ? 'Error' : 'State'}
									tone={store.error ? 'warning' : 'default'}
									value={store.error ?? store.stateText}
								/>
							</AndroidPanelSection>
						))}
						<AndroidPanelSection
							title={`Recent changes · ${recentEvents.length}`}
						>
							{recentEvents.length === 0 ? (
								<AndroidPanelRow label="No projected state changes this session" />
							) : (
								recentEvents.map((event) => (
									<AndroidPanelTextBlock
										key={event.id}
										label={`${event.storeTitle} · ${new Date(event.at).toLocaleTimeString()}`}
										tone={event.error ? 'warning' : 'default'}
										value={`${changeLabel(event)}${event.stateText ? `\n${event.stateText}` : ''}`}
									/>
								))
							)}
							{events.length > 0 ? (
								<AndroidPanelRow
									label="Clear recorded changes"
									onPress={clearRecordedChanges}
								/>
							) : null}
						</AndroidPanelSection>
					</AndroidPanelScroll>
				)}
			</PanelShell>
		);
	}

	const plugin: DevToolsPanelPlugin = {
		id,
		title,
		description:
			options.description ??
			'Inspect explicit, privacy-safe Zustand projections',
		systemImage: options.systemImage ?? 'shippingbox.fill',
		tint:
			Platform.OS === 'ios' ? PlatformColor('systemPurpleColor') : '#AF52DE',
		section: options.section,
		Panel: ZustandPanel,
		install: () => {
			installCount += 1;
			if (installCount === 1) {
				try {
					reconcileSubscriptions();
				} catch (error) {
					reportError(error);
				}
				let pendingRegistrySubscription:
					| { active: boolean; dispose: () => void }
					| undefined;
				try {
					if (options.subscribeToStores) {
						const registrySubscription = {
							active: true,
							dispose: () => {},
						};
						pendingRegistrySubscription = registrySubscription;
						const dispose = options.subscribeToStores(() => {
							if (!registrySubscription.active || installCount === 0) return;
							try {
								reconcileSubscriptions();
							} catch (error) {
								reportError(error);
							}
						});
						if (typeof dispose !== 'function') {
							registrySubscription.active = false;
							throw new Error(
								'Store registry subscription did not return a disposer.',
							);
						}
						registrySubscription.dispose = dispose;
						storeRegistrySubscription = registrySubscription;
					}
				} catch (error) {
					if (pendingRegistrySubscription) {
						pendingRegistrySubscription.active = false;
					}
					storeRegistrySubscription = undefined;
					reportError(error);
				}
			}
			let referenceActive = true;
			return () => {
				if (!referenceActive) return;
				referenceActive = false;
				installCount = Math.max(0, installCount - 1);
				if (installCount !== 0) return;
				const registrySubscription = storeRegistrySubscription;
				storeRegistrySubscription = undefined;
				if (registrySubscription) registrySubscription.active = false;
				try {
					registrySubscription?.dispose();
				} catch {
					// Unmount remains safe when a registry disposer is faulty.
				}
				for (const subscription of subscriptions.values()) {
					subscription.active = false;
					try {
						subscription.dispose();
					} catch {
						// Continue disposing the remaining adapters.
					}
				}
				subscriptions.clear();
			};
		},
	};

	return {
		plugin,
		refresh,
		getSnapshot: snapshotStore.getSnapshot,
		getEvents: eventStore.getSnapshot,
		clearEvents: eventStore.clear,
	};
}
