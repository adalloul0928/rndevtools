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
import { ExternalStore } from '../core/external-store';
import { assertPositiveFinite, assertPositiveInteger } from '../core/options';
import {
	diagnosticErrorText,
	redactDiagnosticText,
	sanitizeDiagnosticValue,
	sanitizeDiagnosticValueWithMetadata,
} from '../core/redact';
import { createRefCountedInstaller } from '../core/ref-counted-installer';
import {
	serializeValue,
	truncateText,
	utf8ByteLength,
} from '../core/serialize';
import type {
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';

export type ComponentTargetBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
};

/** Plain metadata for a component the host has deliberately made inspectable. */
export type ComponentTargetInput = {
	id: string;
	name: string;
	kind?: string;
	feature?: string;
	route?: string;
	testID?: string;
	targetKey?: string;
	sourceFiles?: readonly string[];
	instance?: Readonly<Record<string, unknown>>;
	bounds?: ComponentTargetBounds | null;
	isFocused?: boolean;
};

export type ComponentTargetSnapshot = {
	id: string;
	name: string;
	kind: string;
	feature?: string;
	route?: string;
	testID?: string;
	targetKey?: string;
	sourceFiles: readonly string[];
	instanceText?: string;
	instanceTruncated: boolean;
	bounds: ComponentTargetBounds | null;
	isFocused: boolean;
};

export type ComponentTargetSource = {
	getSnapshot: () => readonly ComponentTargetInput[];
	subscribe: (listener: () => void) => () => void;
	refresh?: () => void | Promise<void>;
	highlight?: (targetId: string) => void | Promise<void>;
};

export type ComponentInspectorPluginOptions = {
	source: ComponentTargetSource;
	maxTargets?: number;
	maxInstanceBytes?: number;
	maxTextBytes?: number;
	maxSnapshotBytes?: number;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
};

export type ComponentInspectorSnapshot = {
	targets: readonly ComponentTargetSnapshot[];
	sourceTargetCount: number;
	omittedTargetCount: number;
	error?: string;
};

export type ComponentInspectorPlugin = {
	plugin: DevToolsPanelPlugin;
	refresh: () => Promise<void>;
	getTargets: () => readonly ComponentTargetSnapshot[];
	getSnapshot: () => ComponentInspectorSnapshot;
	highlight: (targetId: string) => Promise<void>;
};

const MAX_COMPONENT_TARGETS = 5_000;
const MAX_COMPONENT_INSTANCE_BYTES = 1024 * 1024;
const MAX_COMPONENT_TEXT_BYTES = 64 * 1024;
const MAX_COMPONENT_SNAPSHOT_BYTES = 16 * 1024 * 1024;

function componentTargetArrayLength(value: unknown): number | null {
	try {
		if (!Array.isArray(value)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
		return descriptor &&
			'value' in descriptor &&
			Number.isSafeInteger(descriptor.value) &&
			descriptor.value >= 0
			? descriptor.value
			: null;
	} catch {
		return null;
	}
}

function componentErrorText(error: unknown): string {
	return truncateText(diagnosticErrorText(error), 8 * 1024).text;
}

function roundedFinite(value: number): number {
	return Math.round(value * 10) / 10;
}

function normalizeBounds(
	bounds: ComponentTargetBounds | null | undefined,
): ComponentTargetBounds | null {
	if (!bounds || typeof bounds !== 'object') return null;
	if (
		![bounds.x, bounds.y, bounds.width, bounds.height].every(
			(value) => typeof value === 'number' && Number.isFinite(value),
		)
	) {
		return null;
	}
	return {
		x: roundedFinite(bounds.x),
		y: roundedFinite(bounds.y),
		width: Math.max(0, roundedFinite(bounds.width)),
		height: Math.max(0, roundedFinite(bounds.height)),
	};
}

function normalizedText(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = truncateText(
		redactDiagnosticText(value.trim()),
		maxBytes,
	).text;
	return normalized || undefined;
}

function normalizedTextList(
	values: readonly string[] | undefined,
	maxBytes: number,
	maxItems: number,
): readonly string[] {
	if (!Array.isArray(values)) return [];
	const normalized = new Set<string>();
	for (const value of values ?? []) {
		if (typeof value !== 'string') continue;
		const next = normalizedText(value, maxBytes);
		if (next) normalized.add(next);
		if (normalized.size >= maxItems) break;
	}
	return [...normalized];
}

export function normalizeComponentTargets(
	targets: readonly ComponentTargetInput[],
	options: {
		maxTargets: number;
		maxInstanceBytes: number;
		maxTextBytes: number;
		maxSnapshotBytes?: number;
	},
): readonly ComponentTargetSnapshot[] {
	const sourceTargetCount = componentTargetArrayLength(targets);
	if (sourceTargetCount === null) return [];
	const normalized: ComponentTargetSnapshot[] = [];
	const maxSnapshotBytes = options.maxSnapshotBytes ?? Number.POSITIVE_INFINITY;
	let snapshotBytes = 0;
	const ids = new Set<string>();
	for (
		let index = 0;
		index < Math.min(sourceTargetCount, MAX_COMPONENT_TARGETS);
		index += 1
	) {
		if (normalized.length >= options.maxTargets) break;
		let targetDescriptor: PropertyDescriptor | undefined;
		try {
			targetDescriptor = Object.getOwnPropertyDescriptor(
				targets,
				String(index),
			);
		} catch {
			continue;
		}
		if (!targetDescriptor || !('value' in targetDescriptor)) continue;
		const target = targetDescriptor.value;
		if (!target || typeof target !== 'object') continue;
		let descriptors: Record<string, PropertyDescriptor>;
		try {
			descriptors = Object.getOwnPropertyDescriptors(target);
		} catch {
			continue;
		}
		const dataProperty = (key: keyof ComponentTargetInput): unknown => {
			const descriptor = descriptors[key];
			return descriptor && 'value' in descriptor ? descriptor.value : undefined;
		};
		const rawId = dataProperty('id');
		const rawName = dataProperty('name');
		if (typeof rawId !== 'string' || typeof rawName !== 'string') continue;
		const id = rawId;
		const name = normalizedText(rawName, options.maxTextBytes);
		if (
			!id.trim() ||
			id !== id.trim() ||
			name === undefined ||
			id.length > 256 ||
			ids.has(id)
		) {
			continue;
		}
		const rawInstance = dataProperty('instance');
		const sanitizedInstance =
			rawInstance !== undefined
				? sanitizeDiagnosticValueWithMetadata(rawInstance)
				: undefined;
		const instance = sanitizedInstance
			? serializeValue(sanitizedInstance.value, options.maxInstanceBytes)
			: undefined;
		const next: ComponentTargetSnapshot = {
			id,
			name,
			kind:
				normalizedText(dataProperty('kind'), options.maxTextBytes) ??
				'component',
			feature: normalizedText(dataProperty('feature'), options.maxTextBytes),
			route: normalizedText(dataProperty('route'), options.maxTextBytes),
			testID: normalizedText(dataProperty('testID'), options.maxTextBytes),
			targetKey: normalizedText(
				dataProperty('targetKey'),
				options.maxTextBytes,
			),
			sourceFiles: normalizedTextList(
				sanitizeDiagnosticValue(dataProperty('sourceFiles')) as
					| readonly string[]
					| undefined,
				options.maxTextBytes,
				20,
			),
			instanceText: instance?.text,
			instanceTruncated:
				(instance?.truncated ?? false) ||
				(sanitizedInstance?.truncated ?? false),
			bounds: normalizeBounds(
				sanitizeDiagnosticValue(
					dataProperty('bounds'),
				) as ComponentTargetBounds | null,
			),
			isFocused: dataProperty('isFocused') === true,
		};
		const nextBytes = utf8ByteLength(JSON.stringify(next));
		if (snapshotBytes + nextBytes > maxSnapshotBytes) continue;
		snapshotBytes += nextBytes;
		ids.add(id);
		normalized.push(next);
	}
	return normalized;
}

function boundsLabel(bounds: ComponentTargetBounds | null): string {
	if (!bounds) return 'Not measured';
	return `${bounds.width} × ${bounds.height} at (${bounds.x}, ${bounds.y})`;
}

function targetSearchText(target: ComponentTargetSnapshot): string {
	return [
		target.name,
		target.kind,
		target.feature,
		target.route,
		target.testID,
		target.targetKey,
		...target.sourceFiles,
	]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
}

export function createComponentInspectorPlugin(
	options: ComponentInspectorPluginOptions,
): ComponentInspectorPlugin {
	const title = options.title ?? 'Component Inspector';
	const id = options.id ?? 'components';
	const maxTargets = options.maxTargets ?? 500;
	const maxInstanceBytes = options.maxInstanceBytes ?? 8 * 1024;
	const maxTextBytes = options.maxTextBytes ?? 2 * 1024;
	const maxSnapshotBytes = options.maxSnapshotBytes ?? 512 * 1024;
	assertPositiveInteger(maxTargets, 'maxTargets');
	assertPositiveFinite(maxInstanceBytes, 'maxInstanceBytes');
	assertPositiveFinite(maxTextBytes, 'maxTextBytes');
	assertPositiveFinite(maxSnapshotBytes, 'maxSnapshotBytes');
	if (maxTargets > MAX_COMPONENT_TARGETS) {
		throw new Error(`maxTargets cannot exceed ${MAX_COMPONENT_TARGETS}`);
	}
	if (maxInstanceBytes > MAX_COMPONENT_INSTANCE_BYTES) {
		throw new Error(
			`maxInstanceBytes cannot exceed ${MAX_COMPONENT_INSTANCE_BYTES}`,
		);
	}
	if (maxTextBytes > MAX_COMPONENT_TEXT_BYTES) {
		throw new Error(`maxTextBytes cannot exceed ${MAX_COMPONENT_TEXT_BYTES}`);
	}
	if (maxSnapshotBytes > MAX_COMPONENT_SNAPSHOT_BYTES) {
		throw new Error(
			`maxSnapshotBytes cannot exceed ${MAX_COMPONENT_SNAPSHOT_BYTES}`,
		);
	}
	const targetStore = new ExternalStore<ComponentInspectorSnapshot>({
		targets: [],
		sourceTargetCount: 0,
		omittedTargetCount: 0,
	});
	let active = false;
	let lifecycleGeneration = 0;

	const capture = (generation = lifecycleGeneration): void => {
		if (!active || generation !== lifecycleGeneration) return;
		try {
			const sourceTargets = options.source.getSnapshot();
			const sourceTargetCount = componentTargetArrayLength(sourceTargets);
			if (sourceTargetCount === null) {
				throw new Error(
					'Component target source returned an invalid snapshot.',
				);
			}
			const targets = normalizeComponentTargets(sourceTargets, {
				maxTargets,
				maxInstanceBytes,
				maxTextBytes,
				maxSnapshotBytes,
			});
			targetStore.set({
				targets,
				sourceTargetCount,
				omittedTargetCount: Math.max(0, sourceTargetCount - targets.length),
			});
		} catch (error) {
			targetStore.set({
				...targetStore.getSnapshot(),
				error: componentErrorText(error),
			});
		}
	};

	const refresh = async (): Promise<void> => {
		if (!active) return;
		const generation = lifecycleGeneration;
		await options.source.refresh?.();
		capture(generation);
	};
	const highlight = async (targetId: string): Promise<void> => {
		if (!active) {
			throw new Error(
				'Component inspector is unavailable while tools are disabled.',
			);
		}
		if (
			!targetStore
				.getSnapshot()
				.targets.some((target) => target.id === targetId)
		) {
			throw new Error('Component target is no longer available.');
		}
		if (!options.source.highlight) {
			throw new Error('This component source does not support highlighting.');
		}
		await options.source.highlight(targetId);
	};
	const install = createRefCountedInstaller(({ addCleanup }) => {
		active = true;
		lifecycleGeneration += 1;
		const generation = lifecycleGeneration;
		const deactivate = () => {
			if (!active || generation !== lifecycleGeneration) return;
			active = false;
			lifecycleGeneration += 1;
		};
		addCleanup(deactivate);
		capture(generation);
		try {
			const dispose = options.source.subscribe(() => capture(generation));
			if (typeof dispose !== 'function') {
				throw new Error('Subscription did not return a disposer.');
			}
			addCleanup(() => {
				deactivate();
				dispose();
			});
		} catch (error) {
			targetStore.set({
				...targetStore.getSnapshot(),
				error: `Subscription failed: ${componentErrorText(error)}`,
			});
		}
		void refresh().catch((error: unknown) => {
			if (!active || generation !== lifecycleGeneration) return;
			targetStore.set({
				...targetStore.getSnapshot(),
				error: `Refresh failed: ${componentErrorText(error)}`,
			});
		});
	});

	function ComponentInspectorPanel({
		onBack,
		onClose,
		actions,
	}: DevToolsPanelProps) {
		const snapshot = useSyncExternalStore(
			targetStore.subscribe,
			targetStore.getSnapshot,
			targetStore.getServerSnapshot,
		);
		const { targets } = snapshot;
		const [search, setSearch] = useState('');
		const needle = search.trim().toLowerCase();
		const visibleTargets = useMemo(
			() =>
				targets.filter(
					(target) => !needle || targetSearchText(target).includes(needle),
				),
			[targets, needle],
		);
		const groupedTargets = useMemo(() => {
			const groups = new Map<string, ComponentTargetSnapshot[]>();
			for (const target of visibleTargets) {
				const route = target.route ?? 'Unknown route';
				const entries = groups.get(route) ?? [];
				entries.push(target);
				groups.set(route, entries);
			}
			return [...groups.entries()];
		}, [visibleTargets]);
		const highlightTarget = (target: ComponentTargetSnapshot) => {
			onClose();
			void actions.run({
				pluginId: id,
				label: `Highlight ${target.name}`,
				action: () => highlight(target.id),
			});
		};

		return (
			<PanelShell
				onBack={onBack}
				title={title}
				trailing={
					<NavIconButton
						accessibilityLabel="Refresh component measurements"
						onPress={() => {
							void actions.run({
								pluginId: id,
								label: 'Refresh component measurements',
								action: refresh,
							});
						}}
						systemImage="arrow.clockwise"
						testID="devtools-components-refresh"
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
									placeholder="Search targets, routes, or source files"
								/>
							</Section>
							<Section
								footer={
									<UIText>
										Only components explicitly registered by the host appear
										here. The inspector does not traverse React fibers or native
										view hierarchies.
									</UIText>
								}
							>
								{snapshot.error ? (
									<Label
										color={PlatformColor('systemOrangeColor')}
										systemImage="exclamationmark.triangle.fill"
										title={`Capture failed · ${snapshot.error}`}
									/>
								) : null}
								<Label
									color={PlatformColor('systemBlueColor')}
									systemImage="scope"
									title={`${visibleTargets.length} of ${targets.length} registered targets`}
								/>
								{snapshot.omittedTargetCount > 0 ? (
									<Label
										color={PlatformColor('systemOrangeColor')}
										systemImage="exclamationmark.triangle.fill"
										title={`${snapshot.omittedTargetCount} source ${snapshot.omittedTargetCount === 1 ? 'target was' : 'targets were'} invalid, duplicated, or over the safe capture limits`}
									/>
								) : null}
							</Section>
							{groupedTargets.length === 0 ? (
								<Section>
									<ContentUnavailableView
										description={
											needle
												? 'No registered component matches this search.'
												: 'Open a screen containing registered feedback targets, then refresh.'
										}
										systemImage="scope"
										title={needle ? 'No matching targets' : 'No targets'}
									/>
								</Section>
							) : (
								groupedTargets.map(([route, routeTargets]) => (
									<Section
										key={route}
										title={`${route} · ${routeTargets.length}`}
									>
										{routeTargets.map((target) => (
											<DisclosureGroup
												key={target.id}
												label={`${target.name} — ${target.kind}`}
											>
												<Label
													color={PlatformColor(
														target.isFocused
															? 'systemGreenColor'
															: 'systemGrayColor',
													)}
													systemImage={
														target.isFocused ? 'viewfinder' : 'eye.slash'
													}
													title={target.isFocused ? 'Focused' : 'Not focused'}
												/>
												<LabeledContent label="Bounds">
													<UIText>{boundsLabel(target.bounds)}</UIText>
												</LabeledContent>
												{target.feature ? (
													<LabeledContent label="Feature">
														<UIText>{target.feature}</UIText>
													</LabeledContent>
												) : null}
												{target.testID ? (
													<LabeledContent label="Test id">
														<UIText>{target.testID}</UIText>
													</LabeledContent>
												) : null}
												{target.targetKey ? (
													<LabeledContent label="Target key">
														<UIText>{target.targetKey}</UIText>
													</LabeledContent>
												) : null}
												{target.sourceFiles.length > 0 ? (
													<LabeledContent label="Source">
														<UIText modifiers={[lineLimit(8)]}>
															{target.sourceFiles.join('\n')}
														</UIText>
													</LabeledContent>
												) : null}
												{target.instanceText ? (
													<UIText
														modifiers={[
															font({
																design: 'monospaced',
																textStyle: 'footnote',
															}),
															foregroundStyle('secondary'),
															lineLimit(12),
														]}
													>
														{target.instanceText}
													</UIText>
												) : null}
												{options.source.highlight && target.bounds ? (
													<Button
														label="Highlight target"
														onPress={() => highlightTarget(target)}
													/>
												) : null}
											</DisclosureGroup>
										))}
									</Section>
								))
							)}
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						<AndroidPanelSearch
							onChangeText={setSearch}
							placeholder="Search targets, routes, or source files"
							value={search}
						/>
						<AndroidPanelSection
							footer="Only explicitly registered targets appear here; React fibers and native view hierarchies are not traversed."
							title="Overview"
						>
							<AndroidPanelRow
								label="Registered targets"
								value={`${visibleTargets.length} of ${targets.length}`}
							/>
							{snapshot.error ? (
								<AndroidPanelRow
									detail={snapshot.error}
									label="Capture failed"
									tone="warning"
								/>
							) : null}
							{snapshot.omittedTargetCount > 0 ? (
								<AndroidPanelRow
									detail={`${snapshot.omittedTargetCount} source ${snapshot.omittedTargetCount === 1 ? 'target was' : 'targets were'} invalid, duplicated, or over the safe capture limits.`}
									label="Targets omitted"
									tone="warning"
								/>
							) : null}
							{visibleTargets.length === 0 ? (
								<AndroidPanelRow
									detail={
										needle
											? 'No registered component matches this search.'
											: 'Open a screen containing registered feedback targets, then refresh.'
									}
									label={needle ? 'No matching targets' : 'No targets'}
								/>
							) : null}
						</AndroidPanelSection>
						{visibleTargets.map((target) => (
							<AndroidPanelSection
								key={target.id}
								title={`${target.route ?? 'Unscoped'} · ${target.name}`}
							>
								<AndroidPanelRow label="Kind" value={target.kind} />
								<AndroidPanelRow
									label="Focus"
									tone={target.isFocused ? 'success' : 'default'}
									value={target.isFocused ? 'Focused' : 'Not focused'}
								/>
								<AndroidPanelRow
									label="Bounds"
									value={boundsLabel(target.bounds)}
								/>
								{target.feature ? (
									<AndroidPanelRow label="Feature" value={target.feature} />
								) : null}
								{target.testID ? (
									<AndroidPanelRow label="Test id" value={target.testID} />
								) : null}
								{target.targetKey ? (
									<AndroidPanelRow
										label="Target key"
										value={target.targetKey}
									/>
								) : null}
								{target.sourceFiles.length > 0 ? (
									<AndroidPanelTextBlock
										label="Source"
										value={target.sourceFiles.join('\n')}
									/>
								) : null}
								{target.instanceText ? (
									<AndroidPanelTextBlock
										label="Instance"
										value={target.instanceText}
									/>
								) : null}
								{options.source.highlight && target.bounds ? (
									<AndroidPanelRow
										label="Highlight target"
										onPress={() => highlightTarget(target)}
									/>
								) : null}
							</AndroidPanelSection>
						))}
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
			'Inspect explicit component targets and measurements',
		systemImage: options.systemImage ?? 'scope',
		tint: Platform.OS === 'ios' ? PlatformColor('systemBlueColor') : '#007AFF',
		section: options.section,
		Panel: ComponentInspectorPanel,
		install,
	};

	return {
		plugin,
		refresh,
		getTargets: () => targetStore.getSnapshot().targets,
		getSnapshot: targetStore.getSnapshot,
		highlight,
	};
}
