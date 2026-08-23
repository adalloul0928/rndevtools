import {
	Button,
	DisclosureGroup,
	Host,
	HStack,
	Image,
	LabeledContent,
	List,
	Section,
	Spacer,
	SwipeActions,
	TextField,
	type TextFieldRef,
	Text as UIText,
	VStack,
} from '@expo/ui/swift-ui';
import {
	autocorrectionDisabled,
	buttonStyle,
	controlSize,
	disabled,
	fixedSize,
	font,
	foregroundStyle,
	keyboardType,
	lineLimit,
	listStyle,
	onSubmit,
	textInputAutocapitalization,
} from '@expo/ui/swift-ui/modifiers';
import { Fragment, useRef, useState, useSyncExternalStore } from 'react';
import { Platform, PlatformColor, View } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSearch,
	AndroidPanelSection,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { serializeValue } from '../core/serialize';
import type {
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';
import { formatRelativeTime } from './query';

export type NavigationEvent = {
	id: number;
	at: number;
	route: string;
	segments?: readonly string[];
	metadata?: Readonly<Record<string, unknown>>;
};
export type NavigationAction = {
	id: string;
	title: string;
	run: () => unknown | Promise<unknown>;
};
export type NavigationRouteKind =
	| 'static'
	| 'dynamic'
	| 'catchAll'
	| 'layout'
	| 'group'
	| 'internal';
export type NavigationRouteDescriptor = {
	id: string;
	path: string;
	kind: NavigationRouteKind;
	filename?: string;
	isInitial?: boolean;
	isInternal?: boolean;
};
export type NavigationStackEntry = {
	key: string;
	name: string;
	path?: string;
	depth: number;
	visible: boolean;
	params?: Readonly<Record<string, unknown>>;
};
export type NavigationPluginOptions = {
	actions?: readonly NavigationAction[];
	maxEvents?: number;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
	tint?: string;
	/**
	 * Jump handler: the host closes the tools and routes to the given path.
	 * When absent the panel renders route rows without tap navigation.
	 */
	onNavigate?: (path: string) => void;
	/** Opens a raw deep link URL. When absent the deep link section is hidden. */
	onOpenDeepLink?: (url: string) => void;
};
export type NavigationPlugin = {
	plugin: DevToolsPanelPlugin;
	record: (
		route: string,
		options?: {
			segments?: readonly string[];
			metadata?: Readonly<Record<string, unknown>>;
		},
	) => void;
	updateRoutes: (routes: readonly NavigationRouteDescriptor[]) => void;
	updateStack: (stack: readonly NavigationStackEntry[]) => void;
	clear: () => void;
	getEvents: () => readonly NavigationEvent[];
	getRoutes: () => readonly NavigationRouteDescriptor[];
	getStack: () => readonly NavigationStackEntry[];
};

type ScreensSessionState = {
	pinnedPaths: readonly string[];
	lastParamValues: Readonly<Record<string, string>>;
};

/**
 * Session-scoped pins and remembered dynamic-route param values. Module-level
 * so both survive panel re-mounts within an app session, and so hosts can
 * mirror pinned routes into pill quick actions.
 */
const screensSessionStore = new ExternalStore<ScreensSessionState>({
	pinnedPaths: [],
	lastParamValues: {},
});

export function getPinnedRoutes(): readonly string[] {
	return screensSessionStore.getSnapshot().pinnedPaths;
}

export function subscribePinnedRoutes(listener: () => void): () => void {
	return screensSessionStore.subscribe(listener);
}

export function setRoutePinned(path: string, pinned: boolean): void {
	const state = screensSessionStore.getSnapshot();
	if (pinned === state.pinnedPaths.includes(path)) return;
	screensSessionStore.set({
		...state,
		pinnedPaths: pinned
			? [...state.pinnedPaths, path]
			: state.pinnedPaths.filter((candidate) => candidate !== path),
	});
}

function rememberParamValues(values: Readonly<Record<string, string>>): void {
	const state = screensSessionStore.getSnapshot();
	screensSessionStore.set({
		...state,
		lastParamValues: { ...state.lastParamValues, ...values },
	});
}

function isParamSegment(segment: string): boolean {
	return segment.startsWith('[') && segment.endsWith(']');
}

function paramNameFromSegment(segment: string): string {
	return segment.replace(/^\[+\.{0,3}|\]+$/g, '');
}

function stripGroupParens(segment: string): string {
	return segment.replace(/^\(+|\)+$/g, '');
}

/** Derives a human name from the last meaningful path segment. */
export function navigationRouteDisplayName(path: string): string {
	const segments = path
		.split('/')
		.filter(
			(segment) => segment && segment !== 'index' && segment !== '_layout',
		);
	const last = segments.at(-1);
	if (!last) return 'Root';
	const words = paramNameFromSegment(stripGroupParens(last))
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[-_.\s]+/)
		.filter(Boolean);
	if (words.length === 0) return 'Root';
	return words
		.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
		.join(' ');
}

function routeGroupLabel(path: string): string {
	const first = path.split('/').find((segment) => segment.length > 0);
	if (!first) return 'ROOT';
	const cleaned = paramNameFromSegment(stripGroupParens(first));
	return cleaned ? cleaned.toUpperCase() : 'ROOT';
}

function routeParamNames(path: string): readonly string[] {
	return path.split('/').filter(isParamSegment).map(paramNameFromSegment);
}

function buildRoutePath(
	path: string,
	values: Readonly<Record<string, string>>,
): string {
	return path
		.split('/')
		.map((segment) =>
			isParamSegment(segment)
				? (values[paramNameFromSegment(segment)] ?? segment)
				: segment,
		)
		.join('/');
}

function routeMatches(path: string, needle: string): boolean {
	if (!needle) return true;
	return (
		path.toLowerCase().includes(needle) ||
		navigationRouteDisplayName(path).toLowerCase().includes(needle)
	);
}

function truncateMiddleValue(value: string, maxLength = 18): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 1)}…`;
}

export function inferNavigationRouteKind(
	path: string,
	isInternal = false,
): NavigationRouteKind {
	if (isInternal) return 'internal';
	if (path.endsWith('/_layout') || path === '_layout') return 'layout';
	if (path.includes('[...') || path.includes('[[...')) return 'catchAll';
	if (path.includes('[')) return 'dynamic';
	if (
		path
			.split('/')
			.some((segment) => segment.startsWith('(') && segment.endsWith(')'))
	)
		return 'group';
	return 'static';
}

const secondaryText = () => [
	font({ textStyle: 'footnote' }),
	foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
];

const monoPathText = () => [
	font({ textStyle: 'footnote', design: 'monospaced' }),
	foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
	lineLimit(1),
];

const groupLabelText = () => [
	font({ textStyle: 'footnote', weight: 'semibold' }),
	foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
];

function SectionHeaderWithInfo({ title }: { title: string }) {
	return <UIText>{title}</UIText>;
}

export function createNavigationPlugin(
	options: NavigationPluginOptions = {},
): NavigationPlugin {
	const title = options.title ?? 'Screens';
	const id = options.id ?? 'navigation';
	const historyStore = new BoundedEventStore<NavigationEvent>({
		maxEvents: options.maxEvents ?? 100,
		maxBytes: 512 * 1024,
		estimateBytes: (event) => serializeValue(event, 64 * 1024).estimatedBytes,
	});
	const routesStore = new ExternalStore<readonly NavigationRouteDescriptor[]>(
		[],
	);
	const stackStore = new ExternalStore<readonly NavigationStackEntry[]>([]);
	let nextId = 1;

	function ScreensPanel({ onBack, actions }: DevToolsPanelProps) {
		const events = useSyncExternalStore(
			historyStore.subscribe,
			historyStore.getSnapshot,
			historyStore.getServerSnapshot,
		);
		const routes = useSyncExternalStore(
			routesStore.subscribe,
			routesStore.getSnapshot,
			routesStore.getServerSnapshot,
		);
		const stack = useSyncExternalStore(
			stackStore.subscribe,
			stackStore.getSnapshot,
			stackStore.getServerSnapshot,
		);
		const session = useSyncExternalStore(
			screensSessionStore.subscribe,
			screensSessionStore.getSnapshot,
			screensSessionStore.getServerSnapshot,
		);
		const [search, setSearch] = useState('');
		const [historyExpanded, setHistoryExpanded] = useState(false);
		const [expandedParamsKey, setExpandedParamsKey] = useState<string | null>(
			null,
		);
		const [paramDrafts, setParamDrafts] = useState<
			Readonly<Record<string, string>>
		>({});
		const [deepLink, setDeepLink] = useState('');
		const deepLinkField = useRef<TextFieldRef>(null);

		const { onNavigate, onOpenDeepLink } = options;
		const needle = search.trim().toLowerCase();
		const current = events.at(-1);
		const mountedCount = stack.length;
		const visibleCount = stack.filter((entry) => entry.visible).length;
		const backAction = options.actions?.find(
			(action) => action.id === 'back' || action.title === 'Go back',
		);
		const currentSummary = `${
			current?.segments?.length
				? `${current.segments.map(stripGroupParens).join(' › ')} — `
				: ''
		}${mountedCount} mounted, ${visibleCount} visible`;

		// The sitemap can expose the same path twice (e.g. a group root and its
		// index route); one jump row per path is enough.
		const seenJumpablePaths = new Set<string>();
		const jumpableRoutes = routes.filter((route) => {
			if (route.kind === 'layout' || route.kind === 'internal') return false;
			if (seenJumpablePaths.has(route.path)) return false;
			seenJumpablePaths.add(route.path);
			return true;
		});
		const visibleJumpable = jumpableRoutes.filter((route) =>
			routeMatches(route.path, needle),
		);
		const visibleInternal = routes.filter(
			(route) =>
				(route.kind === 'layout' || route.kind === 'internal') &&
				routeMatches(route.path, needle),
		);
		const groups: { label: string; routes: NavigationRouteDescriptor[] }[] = [];
		for (const route of visibleJumpable) {
			const label = routeGroupLabel(route.path);
			const group = groups.find((candidate) => candidate.label === label);
			if (group) group.routes.push(route);
			else groups.push({ label, routes: [route] });
		}

		const visiblePinned = session.pinnedPaths.filter((path) =>
			routeMatches(path, needle),
		);
		const recents: NavigationEvent[] = [];
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (!event || event.route === current?.route) continue;
			if (recents.some((existing) => existing.route === event.route)) continue;
			recents.push(event);
			if (recents.length === 5) break;
		}
		const visibleRecents = recents.filter((event) =>
			routeMatches(event.route, needle),
		);

		const draftFor = (path: string, param: string): string => {
			const key = `${path}:${param}`;
			return paramDrafts[key] ?? session.lastParamValues[key] ?? '';
		};

		const navigateWithParams = (path: string) => {
			const values: Record<string, string> = {};
			for (const param of routeParamNames(path)) {
				const value = draftFor(path, param).trim();
				if (!value) return;
				values[param] = value;
			}
			rememberParamValues(
				Object.fromEntries(
					Object.entries(values).map(([param, value]) => [
						`${path}:${param}`,
						value,
					]),
				),
			);
			setExpandedParamsKey(null);
			onNavigate?.(buildRoutePath(path, values));
		};

		const handleRouteTap = (path: string, expandKey: string) => {
			if (!onNavigate) return;
			if (routeParamNames(path).length > 0) {
				setExpandedParamsKey((key) => {
					if (key === expandKey) {
						// Collapsing discards unsubmitted drafts so an invisible value
						// can never drive the next Go.
						setParamDrafts((drafts) => {
							const next = { ...drafts };
							for (const draftKey of Object.keys(next)) {
								if (draftKey.startsWith(`${path}:`)) delete next[draftKey];
							}
							return next;
						});
						return null;
					}
					return expandKey;
				});
				return;
			}
			onNavigate(path);
		};

		const openDeepLink = () => {
			const url = deepLink.trim();
			if (url) onOpenDeepLink?.(url);
		};

		const renderParamEditorRow = (path: string) => {
			const params = routeParamNames(path);
			const canGo = params.every(
				(param) => draftFor(path, param).trim().length > 0,
			);
			const fields = params.map((param) => {
				const key = `${path}:${param}`;
				const remembered = session.lastParamValues[key];
				return (
					<TextField
						key={key}
						modifiers={[
							autocorrectionDisabled(true),
							textInputAutocapitalization('never'),
						]}
						onTextChange={(text) =>
							setParamDrafts((drafts) => ({ ...drafts, [key]: text }))
						}
						placeholder={
							remembered
								? `${param} — last: ${truncateMiddleValue(remembered)}`
								: param
						}
					/>
				);
			});
			const goButton = (
				<Button
					label="Go"
					modifiers={[
						buttonStyle('borderedProminent'),
						controlSize('small'),
						disabled(!canGo),
					]}
					onPress={() => navigateWithParams(path)}
				/>
			);
			return params.length === 1 ? (
				<HStack spacing={8}>
					{fields}
					{goButton}
				</HStack>
			) : (
				<VStack alignment="leading" spacing={8}>
					{fields}
					{goButton}
				</VStack>
			);
		};

		const renderRouteRow = (
			path: string,
			expandKey: string,
			rowOptions?: { star?: boolean; subtitle?: string },
		) => {
			const pinned = session.pinnedPaths.includes(path);
			const expanded =
				expandedParamsKey === expandKey &&
				onNavigate !== undefined &&
				routeParamNames(path).length > 0;
			const content = (
				<HStack spacing={12}>
					{rowOptions?.star ? (
						<Image
							color={PlatformColor('systemOrangeColor')}
							size={14}
							systemName="star.fill"
						/>
					) : null}
					<VStack alignment="leading" spacing={2}>
						<UIText>{navigationRouteDisplayName(path)}</UIText>
						<UIText modifiers={monoPathText()}>
							{rowOptions?.subtitle ?? path}
						</UIText>
					</VStack>
					<Spacer />
					{onNavigate ? (
						<Image
							color={PlatformColor('tertiaryLabelColor')}
							size={12}
							systemName="chevron.right"
						/>
					) : null}
				</HStack>
			);
			return (
				<Fragment key={expandKey}>
					<SwipeActions>
						{onNavigate ? (
							<Button
								modifiers={[buttonStyle('plain')]}
								onPress={() => handleRouteTap(path, expandKey)}
							>
								{content}
							</Button>
						) : (
							content
						)}
						<SwipeActions.Actions edge="trailing">
							<Button
								label={pinned ? 'Unpin' : 'Pin'}
								onPress={() => setRoutePinned(path, !pinned)}
							/>
						</SwipeActions.Actions>
					</SwipeActions>
					{expanded ? renderParamEditorRow(path) : null}
				</Fragment>
			);
		};

		const renderAndroidRouteRow = (path: string, expandKey: string) => {
			const params = routeParamNames(path);
			const expanded =
				expandedParamsKey === expandKey &&
				onNavigate !== undefined &&
				params.length > 0;
			const canGo = params.every(
				(param) => draftFor(path, param).trim().length > 0,
			);

			return (
				<Fragment key={expandKey}>
					<AndroidPanelRow
						label={navigationRouteDisplayName(path)}
						detail={path}
						onPress={
							onNavigate ? () => handleRouteTap(path, expandKey) : undefined
						}
					/>
					{expanded ? (
						<View style={{ gap: 8, padding: 12 }}>
							{params.map((param) => {
								const key = `${path}:${param}`;
								return (
									<AndroidPanelSearch
										key={key}
										onChangeText={(text) =>
											setParamDrafts((drafts) => ({
												...drafts,
												[key]: text,
											}))
										}
										placeholder={param}
										value={draftFor(path, param)}
									/>
								);
							})}
							<AndroidPanelRow
								label="Go"
								onPress={canGo ? () => navigateWithParams(path) : undefined}
							/>
						</View>
					) : null}
				</Fragment>
			);
		};

		return (
			<PanelShell
				onBack={onBack}
				title={title}
				trailing={
					onOpenDeepLink ? (
						<NavIconButton
							accessibilityLabel="Focus deep link field"
							onPress={() => {
								void deepLinkField.current?.focus();
							}}
							systemImage="link"
							testID="devtools-navigation-deeplink"
						/>
					) : undefined
				}
			>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							<Section>
								<TextField
									modifiers={[
										autocorrectionDisabled(true),
										textInputAutocapitalization('never'),
									]}
									onTextChange={setSearch}
									placeholder="Jump to any screen…"
								/>
							</Section>
							<Section title="Current">
								<HStack spacing={12}>
									<Image
										color={PlatformColor(
											current ? 'systemGreenColor' : 'systemGrayColor',
										)}
										size={10}
										systemName="circle.fill"
									/>
									<VStack alignment="leading" spacing={2}>
										<UIText
											modifiers={[
												font({ textStyle: 'body', weight: 'semibold' }),
											]}
										>
											{current
												? navigationRouteDisplayName(current.route)
												: 'No route recorded'}
										</UIText>
										<UIText modifiers={monoPathText()}>
											{current?.route ?? '—'}
										</UIText>
									</VStack>
									<Spacer />
									{backAction ? (
										<Button
											label="Back"
											modifiers={[
												buttonStyle('bordered'),
												controlSize('small'),
												fixedSize(),
											]}
											onPress={() =>
												void actions.run({
													pluginId: id,
													label: backAction.title,
													action: backAction.run,
												})
											}
										/>
									) : null}
								</HStack>
								<UIText modifiers={secondaryText()}>{currentSummary}</UIText>
								<DisclosureGroup label={`Stack · ${stack.length}`}>
									{stack.map((entry) => (
										<LabeledContent
											key={entry.key}
											label={entry.visible ? 'Visible' : 'Mounted'}
										>
											<UIText modifiers={monoPathText()}>
												{entry.path ?? entry.name}
											</UIText>
										</LabeledContent>
									))}
									{stack.length === 0 ? (
										<UIText modifiers={secondaryText()}>
											No stack entries
										</UIText>
									) : null}
								</DisclosureGroup>
							</Section>
							<Section
								footer={<UIText>Swipe any screen to pin it here.</UIText>}
								title="Pinned"
							>
								{visiblePinned.length === 0 ? (
									<UIText modifiers={secondaryText()}>
										{needle
											? 'No pinned screens match.'
											: 'Nothing pinned yet.'}
									</UIText>
								) : (
									visiblePinned.map((path) =>
										renderRouteRow(path, `pinned:${path}`, { star: true }),
									)
								)}
							</Section>
							<Section
								header={
									<SectionHeaderWithInfo
										title={`All screens · ${visibleJumpable.length}`}
									/>
								}
							>
								{groups.map((group) => (
									<Fragment key={group.label}>
										<UIText modifiers={groupLabelText()}>{group.label}</UIText>
										{group.routes.map((route) =>
											renderRouteRow(route.path, `all:${route.id}`),
										)}
									</Fragment>
								))}
								{visibleJumpable.length === 0 ? (
									<UIText modifiers={secondaryText()}>
										{routes.length === 0
											? 'No screens registered yet.'
											: 'No screens match.'}
									</UIText>
								) : null}
								{visibleInternal.length > 0 ? (
									<DisclosureGroup
										label={`Internal & layouts · ${visibleInternal.length}`}
									>
										{visibleInternal.map((route) => (
											<UIText key={route.id} modifiers={monoPathText()}>
												{route.path}
											</UIText>
										))}
									</DisclosureGroup>
								) : null}
							</Section>
							{visibleRecents.length > 0 ? (
								<Section title="Recent">
									{visibleRecents.map((event) =>
										renderRouteRow(event.route, `recent:${event.id}`, {
											subtitle: `${event.route} · ${formatRelativeTime(event.at)}`,
										}),
									)}
								</Section>
							) : null}
							{onOpenDeepLink ? (
								<Section header={<SectionHeaderWithInfo title="Deep link" />}>
									<HStack spacing={8}>
										<TextField
											modifiers={[
												keyboardType('url'),
												autocorrectionDisabled(true),
												textInputAutocapitalization('never'),
												onSubmit(openDeepLink),
											]}
											onTextChange={setDeepLink}
											placeholder="pumpd://…"
											ref={deepLinkField}
										/>
										<Button
											label="Open"
											modifiers={[
												buttonStyle('borderedProminent'),
												controlSize('small'),
												disabled(deepLink.trim().length === 0),
											]}
											onPress={openDeepLink}
										/>
									</HStack>
								</Section>
							) : null}
							<Section>
								<DisclosureGroup
									isExpanded={historyExpanded}
									label={`History · ${events.length}`}
									onIsExpandedChange={setHistoryExpanded}
								>
									{historyExpanded
										? [...events].reverse().map((event) => (
												<LabeledContent key={event.id} label={event.route}>
													<UIText>{formatRelativeTime(event.at)}</UIText>
												</LabeledContent>
											))
										: null}
									{events.length === 0 ? (
										<UIText modifiers={secondaryText()}>
											No route history
										</UIText>
									) : (
										// biome-ignore lint/a11y/useValidAriaRole: SwiftUI ButtonRole, not ARIA
										<Button
											label="Clear history"
											onPress={historyStore.clear}
											role="destructive"
										/>
									)}
								</DisclosureGroup>
							</Section>
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						<AndroidPanelSearch
							onChangeText={setSearch}
							placeholder="Jump to any screen…"
							value={search}
						/>
						<AndroidPanelSection title="Current">
							<AndroidPanelRow
								label={
									current
										? navigationRouteDisplayName(current.route)
										: 'No route recorded'
								}
								detail={current?.route ?? '—'}
								tone={current ? 'success' : 'default'}
								value={`${mountedCount} mounted · ${visibleCount} visible`}
							/>
							{backAction ? (
								<AndroidPanelRow
									label="Go back"
									onPress={() =>
										void actions.run({
											pluginId: id,
											label: backAction.title,
											action: backAction.run,
										})
									}
								/>
							) : null}
						</AndroidPanelSection>
						<AndroidPanelSection title="Pinned">
							{visiblePinned.length === 0 ? (
								<AndroidPanelRow
									label={
										needle ? 'No pinned screens match' : 'Nothing pinned yet'
									}
								/>
							) : (
								visiblePinned.map((path) =>
									renderAndroidRouteRow(path, `pinned:${path}`),
								)
							)}
						</AndroidPanelSection>
						{groups.map((group) => (
							<AndroidPanelSection key={group.label} title={group.label}>
								{group.routes.map((route) =>
									renderAndroidRouteRow(route.path, `all:${route.id}`),
								)}
							</AndroidPanelSection>
						))}
						{onOpenDeepLink ? (
							<AndroidPanelSection title="Deep link">
								<AndroidPanelSearch
									onChangeText={setDeepLink}
									placeholder="pumpd://…"
									value={deepLink}
								/>
								<AndroidPanelRow
									label="Open deep link"
									onPress={openDeepLink}
								/>
							</AndroidPanelSection>
						) : null}
						<AndroidPanelSection title={`History · ${events.length}`}>
							{[...events]
								.reverse()
								.slice(0, 20)
								.map((event) => (
									<AndroidPanelRow
										key={event.id}
										label={navigationRouteDisplayName(event.route)}
										detail={event.route}
										value={formatRelativeTime(event.at)}
									/>
								))}
						</AndroidPanelSection>
					</AndroidPanelScroll>
				)}
			</PanelShell>
		);
	}

	const onNavigate = options.onNavigate;
	return {
		plugin: {
			id,
			title,
			description:
				options.description ??
				'Jump to any screen, pins, live stack, and route history',
			systemImage:
				options.systemImage ?? 'arrow.triangle.turn.up.right.diamond.fill',
			tint: options.tint ?? '#30B0C7',
			section: options.section,
			Panel: ScreensPanel,
			...(onNavigate
				? {
						pillQuickAction: {
							systemImage: 'location.fill' as const,
							openPanelLabel: title,
							subscribe: subscribePinnedRoutes,
							// Dynamic routes need their param editor; the menu's
							// "Open …" item covers them.
							options: () =>
								getPinnedRoutes()
									.filter((path) => routeParamNames(path).length === 0)
									.map((path) => ({
										id: path,
										label: navigationRouteDisplayName(path),
										systemImage: 'arrow.up.forward' as const,
										action: () => onNavigate(path),
									})),
						},
					}
				: {}),
		},
		record: (route, recordOptions) => {
			const previous = historyStore.getSnapshot().at(-1);
			const segments = recordOptions?.segments;
			if (
				previous?.route === route &&
				JSON.stringify(previous.segments) === JSON.stringify(segments) &&
				serializeValue(previous.metadata).text ===
					serializeValue(recordOptions?.metadata).text
			)
				return;
			historyStore.append({
				id: nextId++,
				at: Date.now(),
				route,
				segments,
				metadata: recordOptions?.metadata,
			});
		},
		updateRoutes: (routes) =>
			routesStore.set([...routes].sort((a, b) => a.path.localeCompare(b.path))),
		updateStack: (stack) => stackStore.set([...stack]),
		clear: historyStore.clear,
		getEvents: historyStore.getSnapshot,
		getRoutes: routesStore.getSnapshot,
		getStack: stackStore.getSnapshot,
	};
}
