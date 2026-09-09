import { Button } from '@heroui/react/button';
import {
	ArrowRight,
	FileCode2,
	History,
	Map as MapIcon,
	Navigation2,
	Route as RouteIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
	EmptyPanel,
	KeyValue,
	PanelHeader,
	PanelNotice,
	SearchControl,
	StatusPill,
	Toolbar,
} from '@/components/ui';
import { formatClock, formatRelativeTime } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import type { RouteEntry, RouteEvent } from '../../shared/protocol';

const MAX_RENDERED_ROUTES = 500;
const MAX_RENDERED_ROUTE_EVENTS = 250;

function routeCanNavigate(route: RouteEntry): boolean {
	return route.kind === 'static' || route.kind === 'group';
}

function transitionTone(event: RouteEvent): 'default' | 'success' | 'danger' | 'info' {
	if (event.phase === 'failed') return 'danger';
	if (event.phase === 'focused') return 'success';
	if (event.phase === 'requested') return 'info';
	return 'default';
}

export function RoutesPanel() {
	const { canRunAction, selectedDevice, runAction } = useDesktopRuntime();
	const routes = selectedDevice?.tools.routes ?? [];
	const events = selectedDevice?.tools.routeEvents ?? [];
	const [query, setQuery] = useState('');
	const [selectedId, setSelectedId] = useState<string | null>(
		routes.find((route) => route.isCurrent)?.id ?? routes[0]?.id ?? null
	);
	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return routes.filter(
			(route) =>
				!needle ||
				[route.path, route.name, route.filename, route.kind]
					.join(' ')
					.toLowerCase()
					.includes(needle)
		);
	}, [query, routes]);
	const visibleRoutes = filtered.slice(0, MAX_RENDERED_ROUTES);
	const selected =
		visibleRoutes.find((route) => route.id === selectedId) ?? visibleRoutes[0] ?? null;
	const current = routes.find((route) => route.isCurrent);
	const recentEvents = useMemo(
		() =>
			[...events]
				.sort((left, right) => right.at - left.at)
				.slice(0, MAX_RENDERED_ROUTE_EVENTS),
		[events]
	);

	return (
		<section className="panel-root">
			<PanelHeader
				eyebrow="App"
				title="Routes"
				description="See the current Expo Router stack, browse the generated sitemap, and navigate to explicit static routes."
				meta={
					<span className="flex items-center gap-1.5 text-blue-300">
						<Navigation2 className="h-3 w-3" /> {current?.path ?? 'No active route'}
					</span>
				}
			/>
			<Toolbar>
				<SearchControl
					ariaLabel="Search routes"
					placeholder="Path, screen, file…"
					value={query}
					onChange={setQuery}
				/>
				<span className="ml-auto font-mono text-xs text-(--text-3)">
					{filtered.length} of {routes.length} routes · {events.length} transitions
				</span>
			</Toolbar>
			{filtered.length > visibleRoutes.length || events.length > recentEvents.length ? (
				<PanelNotice title="Desktop list rendering is bounded." tone="info">
					Search still covers every captured route. The list shows up to{' '}
					{MAX_RENDERED_ROUTES} matches and the timeline shows the latest{' '}
					{MAX_RENDERED_ROUTE_EVENTS} transitions.
				</PanelNotice>
			) : null}
			<div className="grid min-h-0 flex-1 grid-cols-[minmax(380px,1fr)_360px]">
				<div className="panel-scroll border-r border-white/8 p-4">
					{filtered.length === 0 ? (
						<EmptyPanel
							icon={<MapIcon className="h-5 w-5" />}
							title="No matching routes"
							description="Try another path or component filename."
						/>
					) : (
						<div className="space-y-1.5">
							{visibleRoutes.map((route) => (
								<button
									aria-pressed={selected?.id === route.id}
									className={`group flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors ${selected?.id === route.id ? 'border-white/18 bg-white/[0.07]' : 'border-transparent hover:border-white/8 hover:bg-white/[0.035]'}`}
									key={route.id}
									type="button"
									onClick={() => setSelectedId(route.id)}
								>
									<div
										className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border ${route.isCurrent ? 'border-blue-400/30 bg-blue-400/10 text-blue-300' : 'border-white/8 bg-white/[0.03] text-(--text-3)'}`}
									>
										<RouteIcon className="h-3.5 w-3.5" />
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="truncate text-xs font-medium text-(--foreground)">
												{route.name}
											</span>
											{route.isCurrent ? (
												<StatusPill tone="info">Current</StatusPill>
											) : null}
										</div>
										<p className="mb-0 mt-1 truncate font-mono text-xs text-(--text-3)">
											{route.path}
										</p>
									</div>
									<ArrowRight className="h-3.5 w-3.5 text-white/15 transition-transform group-hover:translate-x-0.5 group-hover:text-(--muted)" />
								</button>
							))}
						</div>
					)}
				</div>
				<aside className="detail-pane panel-scroll p-4">
					{selected ? (
						<>
							<div className="mb-4 flex items-start justify-between gap-3">
								<div>
									<p className="m-0 text-xs uppercase tracking-[0.08em] text-(--text-3)">
										Route descriptor
									</p>
									<h2 className="mb-0 mt-1 text-sm font-semibold text-(--foreground)">
										{selected.name}
									</h2>
								</div>
								<StatusPill tone={selected.isCurrent ? 'info' : 'default'}>
									{selected.kind}
								</StatusPill>
							</div>
							<div className="mb-4 rounded-md border border-white/8 bg-black/30 p-3 font-mono text-xs text-(--foreground)">
								{selected.path}
							</div>
							<dl className="mb-4">
								<KeyValue label="Kind" value={selected.kind} />
								<KeyValue label="Visible" value={selected.isVisible ? 'Yes' : 'No'} />
								<KeyValue label="Stack depth" value={selected.depth} mono />
								<KeyValue
									label="Source"
									value={selected.filename ?? 'Not reported'}
									mono
								/>
							</dl>
							<Button
								fullWidth
								isDisabled={
									selected.isCurrent ||
									!routeCanNavigate(selected) ||
									!canRunAction('routes', 'navigate')
								}
								variant="primary"
								onPress={() =>
									void runAction(
										'routes',
										'navigate',
										{ path: selected.path },
										`Navigated to ${selected.name}.`
									)
								}
							>
								<Navigation2 className="h-3.5 w-3.5" />
								{selected.isCurrent
									? 'Currently visible'
									: routeCanNavigate(selected)
										? 'Navigate on device'
										: 'Parameters required on device'}
							</Button>
							{selected.filename ? (
								<div className="mt-3 flex items-start gap-2 rounded-md border border-white/8 bg-white/[0.025] p-3 text-xs leading-5 text-(--text-3)">
									<FileCode2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
									<span className="break-all font-mono">{selected.filename}</span>
								</div>
							) : null}
						</>
					) : null}
					<div className="mt-6 border-t border-white/8 pt-4">
						<div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.08em] text-(--text-3)">
							<History className="h-3.5 w-3.5" /> Recent navigation
						</div>
						{events.length === 0 ? (
							<p className="m-0 text-xs leading-5 text-(--text-3)">
								Navigation transitions will appear as the app changes routes.
							</p>
						) : (
							<div className="space-y-2">
								{recentEvents.map((event) => (
									<div
										className="rounded-md border border-white/8 bg-white/[0.025] p-3"
										key={event.id}
									>
										<div className="flex items-center justify-between gap-3">
											<div className="flex min-w-0 items-center gap-2">
												{event.phase ? (
													<StatusPill tone={transitionTone(event)}>
														{event.phase}
													</StatusPill>
												) : null}
												<span className="truncate font-mono text-xs text-(--foreground)">
													{event.route}
												</span>
											</div>
											<span className="shrink-0 font-mono text-xs text-(--text-3)">
												{formatClock(event.at)}
											</span>
										</div>
										<p className="mb-0 mt-1 text-xs text-(--text-3)">
											{[
												event.source,
												event.durationMs === undefined
													? undefined
													: `${event.durationMs} ms`,
												event.correlationId,
												formatRelativeTime(event.at),
											]
												.filter(Boolean)
												.join(' · ')}
										</p>
										{event.error ? (
											<p className="mb-0 mt-2 text-xs leading-4 text-red-300">
												{event.error}
											</p>
										) : null}
									</div>
								))}
							</div>
						)}
					</div>
				</aside>
			</div>
		</section>
	);
}
