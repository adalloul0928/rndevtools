import { useMemo, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
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
} from '../components/panel-ui';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { serializeValue } from '../core/serialize';
import type {
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';

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

type NavigationTab = 'history' | 'routes' | 'stack';

function formatRelativeTime(at: number): string {
	const elapsedSeconds = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (elapsedSeconds < 2) return 'Now';
	if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
	const elapsedMinutes = Math.round(elapsedSeconds / 60);
	if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
	return new Date(at).toLocaleTimeString();
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

export function createNavigationPlugin(
	options: NavigationPluginOptions = {},
): NavigationPlugin {
	const title = options.title ?? 'Navigation';
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

	function NavigationPanel({ onBack, actions }: DevToolsPanelProps) {
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
		const [tab, setTab] = useState<NavigationTab>('history');
		const [search, setSearch] = useState('');
		const current = events.at(-1);
		const needle = search.trim().toLowerCase();
		const visibleEvents = useMemo(
			() =>
				[...events]
					.reverse()
					.filter(
						(event) => !needle || event.route.toLowerCase().includes(needle),
					),
			[events, needle],
		);
		const visibleRoutes = useMemo(
			() =>
				routes.filter(
					(route) =>
						!needle ||
						route.path.toLowerCase().includes(needle) ||
						route.kind.toLowerCase().includes(needle),
				),
			[needle, routes],
		);
		const visibleStack = useMemo(
			() =>
				stack.filter(
					(entry) =>
						!needle ||
						entry.name.toLowerCase().includes(needle) ||
						entry.path?.toLowerCase().includes(needle),
				),
			[needle, stack],
		);
		const dynamicCount = routes.filter(
			(route) => route.kind === 'dynamic' || route.kind === 'catchAll',
		).length;

		return (
			<PanelScaffold
				onBack={onBack}
				title={title}
				subtitle={current?.route ?? 'No route recorded'}
			>
				<PanelSignalCard
					description={
						current
							? `${stack.length} mounted stack entries · changed ${formatRelativeTime(current.at).toLowerCase()}`
							: 'Route transitions will appear as the app navigates.'
					}
					eyebrow="Current route"
					systemImage={current ? 'location.fill' : 'location.slash.fill'}
					title={current?.route ?? 'No route recorded'}
					tone={current ? 'info' : 'neutral'}
				/>
				<PanelMetricStrip
					metrics={[
						{ label: 'History', value: events.length },
						{ label: 'Routes', value: routes.length },
						{ label: 'Dynamic', value: dynamicCount, tone: colors.orange },
						{ label: 'Stack', value: stack.length, tone: colors.blue },
					]}
				/>
				{options.actions?.length ? (
					<PanelToolbar>
						{options.actions.map((action) => (
							<PanelButton
								key={action.id}
								label={action.title}
								onPress={() =>
									void actions.run({
										pluginId: id,
										label: action.title,
										action: action.run,
									})
								}
							/>
						))}
					</PanelToolbar>
				) : null}
				<PanelSegmentedControl
					accessibilityLabel="Navigation inspector"
					onChange={setTab}
					options={[
						{ id: 'history', label: 'History' },
						{ id: 'routes', label: 'Routes' },
						{ id: 'stack', label: 'Stack' },
					]}
					selected={tab}
				/>
				<PanelSearchField
					onChangeText={setSearch}
					placeholder={`Search ${tab}`}
					value={search}
				/>
				{tab === 'history' ? (
					<>
						<PanelToolbar>
							<PanelButton
								label="Clear history"
								onPress={historyStore.clear}
								tone="danger"
							/>
						</PanelToolbar>
						{visibleEvents.length === 0 ? (
							<EmptyState
								systemImage="arrow.triangle.turn.up.right.diamond"
								title="No route history"
							>
								{events.length === 0
									? 'Route transitions will appear here.'
									: 'No routes match the current search.'}
							</EmptyState>
						) : (
							visibleEvents.map((event, index) => (
								<DisclosureCard
									key={event.id}
									leading={
										<PanelStatusBadge
											label={index === 0 ? 'NOW' : formatRelativeTime(event.at)}
											tone={index === 0 ? 'info' : 'neutral'}
										/>
									}
									title={event.route}
									subtitle={
										event.segments?.length
											? event.segments.join(' › ')
											: 'Route transition'
									}
								>
									<CodeBlock>
										{serializeValue(event, 128 * 1024).text}
									</CodeBlock>
								</DisclosureCard>
							))
						)}
					</>
				) : tab === 'routes' ? (
					visibleRoutes.length === 0 ? (
						<EmptyState systemImage="map" title="No route inventory">
							The public router route inventory will appear here.
						</EmptyState>
					) : (
						visibleRoutes.map((route) => (
							<DisclosureCard
								key={route.id}
								title={route.path}
								subtitle={`${route.kind}${route.isInitial ? ' · initial' : ''}`}
							>
								<CodeBlock>{serializeValue(route, 64 * 1024).text}</CodeBlock>
							</DisclosureCard>
						))
					)
				) : visibleStack.length === 0 ? (
					<EmptyState systemImage="square.stack.3d.up" title="No live stack">
						The live public navigation stack will appear here.
					</EmptyState>
				) : (
					visibleStack.map((entry) => (
						<DisclosureCard
							key={entry.key}
							leading={
								<View
									style={[
										styles.stackBar,
										{
											marginLeft: Math.min(entry.depth, 5) * 8,
											backgroundColor: entry.visible
												? colors.blue
												: colors.separator,
										},
									]}
								/>
							}
							title={entry.name}
							subtitle={`${entry.visible ? 'Visible' : 'Mounted'}${entry.path ? ` · ${entry.path}` : ''}`}
						>
							<CodeBlock>{serializeValue(entry, 64 * 1024).text}</CodeBlock>
						</DisclosureCard>
					))
				)}
			</PanelScaffold>
		);
	}

	return {
		plugin: {
			id,
			title,
			description:
				options.description ??
				'Route history, inventory, and live public-router stack',
			systemImage:
				options.systemImage ?? 'arrow.triangle.turn.up.right.diamond.fill',
			section: options.section,
			Panel: NavigationPanel,
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

const styles = StyleSheet.create({
	stackBar: { borderRadius: 2, height: 32, marginRight: 10, width: 3 },
});
