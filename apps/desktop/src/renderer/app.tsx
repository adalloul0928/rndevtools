import { Button } from '@heroui/react/button';
import { Tooltip } from '@heroui/react/tooltip';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	Cable,
	ChevronDown,
	Command,
	Cpu,
	PanelLeftClose,
	PanelLeftOpen,
	Radio,
	Settings2,
	Smartphone,
	TerminalSquare,
} from 'lucide-react';
import {
	type ComponentType,
	type LazyExoticComponent,
	lazy,
	memo,
	Suspense,
	useEffect,
	useState,
} from 'react';
import { ActionNotice, StatusPill } from '@/components/status-ui';
import {
	isSimulatorToolId,
	type SimulatorToolId,
	simulatorTools,
} from '@/simulator/simulator-config';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import { useRecipeRuntime } from '@/state/recipe-runtime';
import { useSimulatorRuntime } from '@/state/simulator-runtime';
import { useSlimmingRuntime } from '@/state/slimming-runtime';
import { isToolId, toolGroups } from '@/tool-config';
import type { PerformanceSample, ToolId } from '../shared/protocol';

type WorkspaceId = 'simulator' | 'connected';
type WorkspaceRoute = {
	workspace: WorkspaceId;
	connectedTool: ToolId;
	simulatorTool: SimulatorToolId;
};

const TRACE_BAR_COUNT = 28;
const TRACE_BAR_MAX_HEIGHT = 14;
const TRACE_BAR_MIN_HEIGHT = 2;
const TRACE_SLOTS = Array.from(
	{ length: TRACE_BAR_COUNT },
	(_, index) => `trace-${index}`
);

function sidebarShortcut(platform: string | undefined): string {
	return platform === 'darwin' ? '⌘B' : 'Ctrl+B';
}

function workspaceShortcut(
	platform: string | undefined,
	workspace: WorkspaceId
): string {
	const key = workspace === 'simulator' ? 'S' : 'C';
	return platform === 'darwin' ? `⇧⌘${key}` : `Ctrl+Shift+${key}`;
}

const NetworkPanel = lazy(() =>
	import('@/panels/network-panel').then((module) => ({ default: module.NetworkPanel }))
);
const ConsolePanel = lazy(() =>
	import('@/panels/console-panel').then((module) => ({ default: module.ConsolePanel }))
);
const StoragePanel = lazy(() =>
	import('@/panels/storage-panel').then((module) => ({ default: module.StoragePanel }))
);
const QueryPanel = lazy(() =>
	import('@/panels/query-panel').then((module) => ({ default: module.QueryPanel }))
);
const RoutesPanel = lazy(() =>
	import('@/panels/routes-panel').then((module) => ({ default: module.RoutesPanel }))
);
const EnvironmentPanel = lazy(() =>
	import('@/panels/environment-panel').then((module) => ({
		default: module.EnvironmentPanel,
	}))
);
const ZustandPanel = lazy(() =>
	import('@/panels/zustand-panel').then((module) => ({ default: module.ZustandPanel }))
);
const RestorePanel = lazy(() =>
	import('@/panels/restore-panel').then((module) => ({ default: module.RestorePanel }))
);
const ScenariosPanel = lazy(() =>
	import('@/panels/scenarios-panel').then((module) => ({
		default: module.ScenariosPanel,
	}))
);
const IdentityPanel = lazy(() =>
	import('@/panels/identity-panel').then((module) => ({
		default: module.IdentityPanel,
	}))
);
const PerformancePanel = lazy(() =>
	import('@/panels/performance-panel').then((module) => ({
		default: module.PerformancePanel,
	}))
);
const ComponentsPanel = lazy(() =>
	import('@/panels/components-panel').then((module) => ({
		default: module.ComponentsPanel,
	}))
);
const CameraPanel = lazy(() =>
	import('@/panels/camera-panel').then((module) => ({
		default: module.CameraPanel,
	}))
);
const DiagnosticsPanel = lazy(() =>
	import('@/panels/diagnostics-panel').then((module) => ({
		default: module.DiagnosticsPanel,
	}))
);

const FleetPanel = lazy(() =>
	import('@/panels/simulator/fleet-panel').then((module) => ({
		default: module.FleetPanel,
	}))
);
const AppActionsPanel = lazy(() =>
	import('@/panels/simulator/app-actions-panel').then((module) => ({
		default: module.AppActionsPanel,
	}))
);
const SlimmingPanel = lazy(() =>
	import('@/panels/simulator/slimming-panel').then((module) => ({
		default: module.SlimmingPanel,
	}))
);
const CapturesPanel = lazy(() =>
	import('@/panels/simulator/captures-panel').then((module) => ({
		default: module.CapturesPanel,
	}))
);
const AutomationPanel = lazy(() =>
	import('@/panels/simulator/automation-panel').then((module) => ({
		default: module.AutomationPanel,
	}))
);
const BuildInsightsPanel = lazy(() =>
	import('@/panels/simulator/build-insights-panel').then((module) => ({
		default: module.BuildInsightsPanel,
	}))
);
const SimulatorSettingsPanel = lazy(() =>
	import('@/panels/simulator/settings-panel').then((module) => ({
		default: module.SettingsPanel,
	}))
);

const TOOL_PANELS: Record<ToolId, LazyExoticComponent<ComponentType>> = {
	network: NetworkPanel,
	console: ConsolePanel,
	storage: StoragePanel,
	query: QueryPanel,
	routes: RoutesPanel,
	environment: EnvironmentPanel,
	zustand: ZustandPanel,
	restore: RestorePanel,
	scenarios: ScenariosPanel,
	identity: IdentityPanel,
	performance: PerformancePanel,
	components: ComponentsPanel,
	camera: CameraPanel,
	diagnostics: DiagnosticsPanel,
};

const SIMULATOR_PANELS: Record<SimulatorToolId, LazyExoticComponent<ComponentType>> = {
	fleet: FleetPanel,
	actions: AppActionsPanel,
	slimming: SlimmingPanel,
	captures: CapturesPanel,
	automation: AutomationPanel,
	builds: BuildInsightsPanel,
	settings: SimulatorSettingsPanel,
};

function routeFromHash(): WorkspaceRoute {
	const hash = window.location.hash.slice(1);
	const [workspace, panel] = hash.split('/');
	if (workspace === 'simulator' && panel && isSimulatorToolId(panel)) {
		return { workspace, simulatorTool: panel, connectedTool: 'network' };
	}
	if (workspace === 'connected' && panel && isToolId(panel)) {
		return { workspace, connectedTool: panel, simulatorTool: 'fleet' };
	}
	if (isToolId(hash)) {
		return { workspace: 'connected', connectedTool: hash, simulatorTool: 'fleet' };
	}
	return { workspace: 'simulator', simulatorTool: 'fleet', connectedTool: 'network' };
}

function replaceHash(workspace: WorkspaceId, panel: ToolId | SimulatorToolId): void {
	window.history.replaceState(null, '', `#${workspace}/${panel}`);
}

function isEditableTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		(target instanceof HTMLElement && target.isContentEditable)
	);
}

export function App() {
	const desktop = useDesktopRuntime();
	const recipe = useRecipeRuntime();
	const simulator = useSimulatorRuntime();
	const slimming = useSlimmingRuntime();
	const [route, setRoute] = useState<WorkspaceRoute>(routeFromHash);
	const [sidebarOpen, setSidebarOpen] = useState(true);

	useEffect(() => {
		const successfulClearers = [
			desktop.actionStatus.kind === 'success' ? desktop.clearActionStatus : null,
			recipe.actionStatus.kind === 'success' ? recipe.clearActionStatus : null,
			simulator.actionStatus.kind === 'success' ? simulator.clearActionStatus : null,
			slimming.actionStatus.kind === 'success' ? slimming.clearActionStatus : null,
		].filter((clearer): clearer is () => void => clearer !== null);
		if (successfulClearers.length === 0) return;
		const timer = window.setTimeout(() => {
			for (const clear of successfulClearers) clear();
		}, 3_500);
		return () => window.clearTimeout(timer);
	}, [
		desktop.actionStatus,
		desktop.clearActionStatus,
		recipe.actionStatus,
		recipe.clearActionStatus,
		simulator.actionStatus,
		simulator.clearActionStatus,
		slimming.actionStatus,
		slimming.clearActionStatus,
	]);

	useEffect(() => {
		const onHashChange = () => setRoute(routeFromHash());
		window.addEventListener('hashchange', onHashChange);
		return () => window.removeEventListener('hashchange', onHashChange);
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.repeat ||
				event.altKey ||
				isEditableTarget(event.target)
			) {
				return;
			}
			const hasPlatformModifier =
				desktop.bootstrap?.platform === 'darwin' ? event.metaKey : event.ctrlKey;
			if (!hasPlatformModifier) return;
			if (!event.shiftKey && event.key.toLowerCase() === 'b') {
				event.preventDefault();
				setSidebarOpen((open) => !open);
				return;
			}
			if (event.shiftKey && event.key.toLowerCase() === 's') {
				event.preventDefault();
				setRoute((current) => {
					const next = { ...current, workspace: 'simulator' as const };
					replaceHash('simulator', next.simulatorTool);
					return next;
				});
				return;
			}
			if (event.shiftKey && event.key.toLowerCase() === 'c') {
				event.preventDefault();
				setRoute((current) => {
					const next = { ...current, workspace: 'connected' as const };
					replaceHash('connected', next.connectedTool);
					return next;
				});
				return;
			}
			if (route.workspace !== 'simulator' || event.shiftKey) return;
			const shortcut = Number(event.key);
			const tool = simulatorTools.find((candidate) => candidate.shortcut === shortcut);
			if (!tool) return;
			event.preventDefault();
			setRoute((current) => ({ ...current, simulatorTool: tool.id }));
			replaceHash('simulator', tool.id);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [desktop.bootstrap?.platform, route.workspace]);

	const setWorkspace = (workspace: WorkspaceId) => {
		setRoute((current) => {
			const panel =
				workspace === 'simulator' ? current.simulatorTool : current.connectedTool;
			replaceHash(workspace, panel);
			return { ...current, workspace };
		});
	};
	const setConnectedTool = (tool: ToolId) => {
		setRoute((current) => ({
			...current,
			workspace: 'connected',
			connectedTool: tool,
		}));
		replaceHash('connected', tool);
	};
	const setSimulatorTool = (tool: SimulatorToolId) => {
		setRoute((current) => ({
			...current,
			workspace: 'simulator',
			simulatorTool: tool,
		}));
		replaceHash('simulator', tool);
	};
	const activeActionStatus =
		route.workspace === 'simulator'
			? route.simulatorTool === 'automation'
				? recipe.actionStatus
				: route.simulatorTool === 'slimming'
					? slimming.actionStatus
					: simulator.actionStatus
			: desktop.actionStatus;
	const clearActiveActionStatus =
		route.workspace === 'simulator'
			? route.simulatorTool === 'automation'
				? recipe.clearActionStatus
				: route.simulatorTool === 'slimming'
					? slimming.clearActionStatus
					: simulator.clearActionStatus
			: desktop.clearActionStatus;

	return (
		<div className="desktop-provider" data-workspace={route.workspace}>
			<Titlebar
				connectedTool={route.connectedTool}
				sidebarOpen={sidebarOpen}
				workspace={route.workspace}
				setConnectedTool={setConnectedTool}
				setSidebarOpen={setSidebarOpen}
				setWorkspace={setWorkspace}
			/>
			<div className="desktop-body">
				{sidebarOpen ? (
					route.workspace === 'simulator' ? (
						<SimulatorSidebar
							activeTool={route.simulatorTool}
							setActiveTool={setSimulatorTool}
						/>
					) : (
						<DesktopSidebar
							activeTool={route.connectedTool}
							setActiveTool={setConnectedTool}
						/>
					)
				) : null}
				<main className="desktop-main">
					<div className="desktop-content">
						{route.workspace === 'simulator' ? (
							<SimulatorContent
								activeTool={route.simulatorTool}
								setActiveTool={setSimulatorTool}
							/>
						) : (
							<ConnectedContent activeTool={route.connectedTool} />
						)}
					</div>
				</main>
			</div>
			{activeActionStatus.kind !== 'idle' ? (
				<ActionNotice
					kind={activeActionStatus.kind}
					message={activeActionStatus.message}
					onDismiss={clearActiveActionStatus}
				/>
			) : null}
		</div>
	);
}

function Titlebar({
	workspace,
	connectedTool,
	sidebarOpen,
	setWorkspace,
	setConnectedTool,
	setSidebarOpen,
}: {
	workspace: WorkspaceId;
	connectedTool: ToolId;
	sidebarOpen: boolean;
	setWorkspace: (workspace: WorkspaceId) => void;
	setConnectedTool: (tool: ToolId) => void;
	setSidebarOpen: (open: boolean) => void;
}) {
	const desktop = useDesktopRuntime();
	const recipe = useRecipeRuntime();
	const simulator = useSimulatorRuntime();
	const slimming = useSlimmingRuntime();
	const shortcut = sidebarShortcut(desktop.bootstrap?.platform);
	const latest = desktop.selectedDevice?.tools.performance.samples.at(-1);
	const connected =
		desktop.state?.devices.filter((device) => device.status === 'online').length ?? 0;
	const booted = simulator.state.devices.filter(
		(device) => device.state === 'booted'
	).length;
	const activeJobStatuses = new Set([
		'queued',
		'preflight',
		'running',
		'verifying',
		'rolling-back',
	]);
	const activeJobs =
		simulator.state.jobs.filter((job) => activeJobStatuses.has(job.status)).length +
		slimming.state.jobs.filter((job) => activeJobStatuses.has(job.status)).length +
		recipe.state.runs.filter((run) =>
			['queued', 'needs-approval', 'resolving', 'running', 'cancelling'].includes(
				run.status
			)
		).length;

	return (
		<header
			className={`titlebar ${desktop.bootstrap?.platform === 'darwin' ? 'is-macos' : ''}`}
		>
			<div className="titlebar-safe-area">
				<div className="titlebar-lead">
					<span className="titlebar-title">PUMPD Devtools</span>
					<span aria-hidden="true" className="titlebar-rule" />
					<div className="titlebar-control no-drag">
						<Tooltip delay={500}>
							<Button
								aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
								className="titlebar-icon-button"
								isIconOnly
								variant="ghost"
								onPress={() => setSidebarOpen(!sidebarOpen)}
							>
								{sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
							</Button>
							<Tooltip.Content>
								{sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} · {shortcut}
							</Tooltip.Content>
						</Tooltip>
					</div>
					<WorkspaceSwitcher
						platform={desktop.bootstrap?.platform}
						workspace={workspace}
						setWorkspace={setWorkspace}
					/>
				</div>
				<div className="titlebar-trail">
					{workspace === 'simulator' ? (
						<FleetTrace
							devices={simulator.state.devices}
							metrics={simulator.state.metrics.byDevice}
						/>
					) : (
						<LiveTrace samples={desktop.selectedDevice?.tools.performance.samples} />
					)}
					<div className="titlebar-metrics no-drag">
						{workspace === 'simulator' ? (
							<>
								<Metric label="Booted" value={String(booted)} />
								<Metric label="Jobs" value={String(activeJobs)} />
								<Metric
									label="Xcode"
									value={simulator.state.capability.xcodeVersion ?? '—'}
								/>
								<span aria-hidden="true" className="titlebar-rule" />
								<div className="titlebar-controls">
									<NativeSelect
										className="device-select"
										fullWidth={false}
										variant="secondary"
									>
										<NativeSelect.Trigger
											aria-label="Selected Simulator"
											disabled={simulator.state.devices.length === 0}
											value={simulator.selectedDevice?.udid ?? ''}
											onChange={(event) =>
												simulator.setSelectedDeviceUdid(event.currentTarget.value)
											}
										>
											{simulator.state.devices.length === 0 ? (
												<NativeSelect.Option value="">No Simulator</NativeSelect.Option>
											) : null}
											{simulator.state.devices.map((device) => (
												<NativeSelect.Option key={device.udid} value={device.udid}>
													{device.name} · {device.state}
												</NativeSelect.Option>
											))}
											<NativeSelect.Indicator>
												<ChevronDown className="h-3 w-3" />
											</NativeSelect.Indicator>
										</NativeSelect.Trigger>
									</NativeSelect>
								</div>
							</>
						) : (
							<>
								<Metric
									label="JS"
									value={latest ? `${latest.jsFps.toFixed(0)} fps` : '—'}
								/>
								<Metric
									label="Lag"
									value={latest ? `${latest.eventLoopLagMs.toFixed(1)} ms` : '—'}
								/>
								<Metric
									label="Memory"
									value={
										latest?.memoryMb === undefined
											? '—'
											: `${latest.memoryMb.toFixed(0)} MB`
									}
								/>
								<span aria-hidden="true" className="titlebar-rule" />
								<div className="titlebar-controls">
									<button
										className="connection-button"
										type="button"
										onClick={() => {
											if (connectedTool !== 'diagnostics')
												setConnectedTool('diagnostics');
										}}
									>
										<span
											className={`connection-dot ${desktop.state?.broker.status === 'listening' ? 'is-online' : ''}`}
										/>
										{connected} live
									</button>
									<NativeSelect
										className="device-select"
										fullWidth={false}
										variant="secondary"
									>
										<NativeSelect.Trigger
											aria-label="Selected development device"
											disabled={!desktop.state?.devices.length}
											value={desktop.selectedDevice?.info.id ?? ''}
											onChange={(event) =>
												desktop.setSelectedDeviceId(event.currentTarget.value)
											}
										>
											{!desktop.state?.devices.length ? (
												<NativeSelect.Option value="">No device</NativeSelect.Option>
											) : null}
											{desktop.state?.devices.map((device) => (
												<NativeSelect.Option
													key={device.info.id}
													value={device.info.id}
												>
													{device.info.name} · {device.status}
												</NativeSelect.Option>
											))}
											<NativeSelect.Indicator>
												<ChevronDown className="h-3 w-3" />
											</NativeSelect.Indicator>
										</NativeSelect.Trigger>
									</NativeSelect>
								</div>
							</>
						)}
					</div>
				</div>
			</div>
		</header>
	);
}

function WorkspaceSwitcher({
	workspace,
	platform,
	setWorkspace,
}: {
	workspace: WorkspaceId;
	platform: string | undefined;
	setWorkspace: (workspace: WorkspaceId) => void;
}) {
	return (
		<fieldset className="workspace-switcher no-drag" aria-label="Desktop workspace">
			<Button
				aria-pressed={workspace === 'simulator'}
				className={workspace === 'simulator' ? 'is-current' : ''}
				variant="ghost"
				onPress={() => setWorkspace('simulator')}
			>
				<Smartphone className="h-3 w-3" /> Simulator
				<kbd>{workspaceShortcut(platform, 'simulator')}</kbd>
			</Button>
			<Button
				aria-pressed={workspace === 'connected'}
				className={workspace === 'connected' ? 'is-current' : ''}
				variant="ghost"
				onPress={() => setWorkspace('connected')}
			>
				<Cable className="h-3 w-3" /> Connected App
				<kbd>{workspaceShortcut(platform, 'connected')}</kbd>
			</Button>
		</fieldset>
	);
}

function LiveTrace({ samples }: { samples: readonly PerformanceSample[] | undefined }) {
	const trace = samples?.slice(-TRACE_BAR_COUNT) ?? [];
	const offset = TRACE_BAR_COUNT - trace.length;

	return (
		<div
			className="titlebar-live"
			aria-label="Live JavaScript performance trace"
			role="img"
		>
			<div className="live-bars">
				{TRACE_SLOTS.map((slot, index) => {
					const sample = trace[index - offset];
					return (
						<span
							className={sample ? 'is-live' : ''}
							key={slot}
							style={{
								height: sample
									? Math.max(
											TRACE_BAR_MIN_HEIGHT,
											TRACE_BAR_MAX_HEIGHT - Math.min(12, sample.eventLoopLagMs / 4)
										)
									: TRACE_BAR_MIN_HEIGHT,
							}}
						/>
					);
				})}
			</div>
			<span className="live-label">
				{trace.length > 0 ? 'Live runtime' : 'Awaiting samples'}
			</span>
		</div>
	);
}

function FleetTrace({
	devices,
	metrics,
}: {
	devices: ReturnType<typeof useSimulatorRuntime>['state']['devices'];
	metrics: ReturnType<typeof useSimulatorRuntime>['state']['metrics']['byDevice'];
}) {
	const visible = devices.slice(-TRACE_BAR_COUNT);
	const offset = TRACE_BAR_COUNT - visible.length;
	const booted = devices.filter((device) => device.state === 'booted').length;

	return (
		<div
			className="titlebar-live"
			aria-label={`Live Simulator fleet trace: ${booted} of ${devices.length} booted`}
			role="img"
		>
			<div className="live-bars">
				{TRACE_SLOTS.map((slot, index) => {
					const device = visible[index - offset];
					const sample = device ? metrics[device.udid] : undefined;
					const height =
						device?.state === 'booted'
							? Math.max(
									5,
									Math.min(
										TRACE_BAR_MAX_HEIGHT,
										5 + Math.round((sample?.cpuPercent ?? 0) / 12)
									)
								)
							: TRACE_BAR_MIN_HEIGHT;
					return (
						<span
							className={device?.state === 'booted' ? 'is-live' : ''}
							key={device?.udid ?? slot}
							style={{ height }}
						/>
					);
				})}
			</div>
			<span className="live-label">
				{devices.length > 0 ? `${booted}/${devices.length} fleet live` : 'No targets'}
			</span>
		</div>
	);
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className="titlebar-metric">
			<span>{label}</span>
			<strong>{value}</strong>
		</div>
	);
}

function SimulatorSidebar({
	activeTool,
	setActiveTool,
}: {
	activeTool: SimulatorToolId;
	setActiveTool: (tool: SimulatorToolId) => void;
}) {
	const { state, selectedDevice } = useSimulatorRuntime();
	const { bootstrap } = useDesktopRuntime();
	const recipe = useRecipeRuntime();
	const navigationModifier = bootstrap?.platform === 'darwin' ? '⌘' : 'Ctrl+';
	const coreTools = simulatorTools.filter((tool) => tool.id !== 'settings');
	const settingsTool = simulatorTools.find((tool) => tool.id === 'settings');
	const unavailable = Object.values(state.capability.features).filter(
		(ready) => !ready
	).length;
	return (
		<aside
			className="desktop-sidebar simulator-sidebar"
			aria-label="Simulator workspace"
		>
			<header className="device-summary simulator-summary">
				<div className="device-icon simulator-device-icon">
					<Smartphone className="h-4 w-4" />
				</div>
				<div className="min-w-0 flex-1">
					<p className="device-name">{selectedDevice?.name ?? 'Simulator workspace'}</p>
					<p className="device-meta">
						{selectedDevice
							? `${selectedDevice.state} · ${state.runtimes.length} runtimes`
							: 'No mobile connection required'}
					</p>
				</div>
				<output
					aria-label={`Simulator capability ${state.capability.status}`}
					className={`device-status ${state.capability.status === 'available' ? 'is-online' : 'is-empty'}`}
				/>
			</header>
			<nav className="desktop-sidebar-content" aria-label="Simulator tools">
				<section className="tool-group">
					<h2 className="tool-group-label">Simulator</h2>
					<div className="space-y-0.5">
						{coreTools.map((tool) => {
							const Icon = tool.icon;
							const count = simulatorCount(tool.id, state, recipe.state.recipes.length);
							return (
								<Button
									{...(activeTool === tool.id
										? { 'aria-current': 'page' as const }
										: {})}
									className={`tool-nav-item ${activeTool === tool.id ? 'is-current' : ''}`}
									key={tool.id}
									variant="ghost"
									onPress={() => setActiveTool(tool.id)}
								>
									<Icon className="h-3.5 w-3.5" />
									<span className="flex-1 text-left">{tool.label}</span>
									{count !== undefined ? (
										<span className="tool-count">{count}</span>
									) : null}
									<kbd className="tool-shortcut">
										{navigationModifier}
										{tool.shortcut}
									</kbd>
								</Button>
							);
						})}
					</div>
				</section>
				{settingsTool ? (
					<section className="tool-group">
						<h2 className="tool-group-label">System</h2>
						<Button
							{...(activeTool === settingsTool.id
								? { 'aria-current': 'page' as const }
								: {})}
							className={`tool-nav-item ${activeTool === settingsTool.id ? 'is-current' : ''}`}
							variant="ghost"
							onPress={() => setActiveTool(settingsTool.id)}
						>
							<Settings2 className="h-3.5 w-3.5" />
							<span className="flex-1 text-left">Settings</span>
							{unavailable > 0 ? (
								<span className="tool-count is-warning">{unavailable}</span>
							) : null}
							<kbd className="tool-shortcut">{navigationModifier}7</kbd>
						</Button>
					</section>
				) : null}
			</nav>
			<footer className="desktop-sidebar-footer">
				<button
					className="broker-summary simulator-capability-summary"
					type="button"
					onClick={() => setActiveTool('settings')}
				>
					<Cpu className="h-3.5 w-3.5" />
					<div className="min-w-0 flex-1 text-left">
						<p>{state.capability.status}</p>
						<code>
							{state.capability.xcodeVersion
								? `Xcode ${state.capability.xcodeVersion}`
								: 'Check setup'}
						</code>
					</div>
					<span
						className={`connection-dot ${state.capability.status === 'available' ? 'is-online' : ''}`}
					/>
				</button>
				<div className="shortcut-hint">
					<span>
						{bootstrap?.platform === 'darwin' ? (
							<Command className="h-3 w-3" />
						) : (
							'Ctrl'
						)}{' '}
						1–7
					</span>
					<span>Navigate Simulator</span>
				</div>
			</footer>
		</aside>
	);
}

function simulatorCount(
	tool: SimulatorToolId,
	state: ReturnType<typeof useSimulatorRuntime>['state'],
	recipeCount: number
): number | undefined {
	if (tool === 'fleet') return state.devices.length;
	if (tool === 'captures') return state.captures.length;
	if (tool === 'automation') return recipeCount;
	if (tool === 'actions')
		return state.devices.filter((device) => device.state === 'booted').length;
	return undefined;
}

function DesktopSidebar({
	activeTool,
	setActiveTool,
}: {
	activeTool: ToolId;
	setActiveTool: (tool: ToolId) => void;
}) {
	const { bootstrap, selectedDevice, state } = useDesktopRuntime();
	const shortcut = bootstrap?.platform === 'darwin' ? '⌘ B' : 'Ctrl B';
	return (
		<aside className="desktop-sidebar" aria-label="Connected app developer tools">
			<header className="device-summary">
				<div className="device-icon">
					<Cable className="h-4 w-4" />
				</div>
				<div className="min-w-0 flex-1">
					<p className="device-name">{selectedDevice?.info.name ?? 'No device'}</p>
					<p className="device-meta">
						{selectedDevice
							? `${selectedDevice.info.appVersion ?? 'dev'} · ${selectedDevice.info.platform}`
							: 'Waiting for connection'}
					</p>
				</div>
				<output
					aria-label={selectedDevice ? `Device ${selectedDevice.status}` : 'No device'}
					className={`device-status is-${selectedDevice?.status ?? 'empty'}`}
				/>
			</header>
			<nav className="desktop-sidebar-content" aria-label="Connected app tool panels">
				{toolGroups.map((group) => (
					<section className="tool-group" key={group.label}>
						<h2 className="tool-group-label">{group.label}</h2>
						<div className="space-y-0.5">
							{group.tools.map((tool) => {
								const Icon = tool.icon;
								const count = tool.count(selectedDevice);
								return (
									<Button
										{...(activeTool === tool.id
											? { 'aria-current': 'page' as const }
											: {})}
										className={`tool-nav-item ${activeTool === tool.id ? 'is-current' : ''}`}
										key={tool.id}
										variant="ghost"
										onPress={() => setActiveTool(tool.id)}
									>
										<Icon className="h-3.5 w-3.5" />
										<span className="flex-1 text-left">{tool.label}</span>
										{count !== undefined ? (
											<span className="tool-count">{count}</span>
										) : null}
									</Button>
								);
							})}
						</div>
					</section>
				))}
			</nav>
			<footer className="desktop-sidebar-footer">
				<button
					className="broker-summary"
					type="button"
					onClick={() => setActiveTool('diagnostics')}
				>
					<Radio className="h-3.5 w-3.5" />
					<div className="min-w-0 flex-1 text-left">
						<p>{state?.broker.status ?? 'Starting broker'}</p>
						<code>
							{state ? `${state.broker.host}:${state.broker.port}` : '127.0.0.1'}
						</code>
					</div>
					<span
						className={`connection-dot ${state?.broker.status === 'listening' ? 'is-online' : ''}`}
					/>
				</button>
				<div className="shortcut-hint">
					<span>
						{bootstrap?.platform === 'darwin' ? <Command className="h-3 w-3" /> : null}{' '}
						{shortcut}
					</span>
					<span>Toggle sidebar</span>
				</div>
			</footer>
		</aside>
	);
}

function SimulatorContent({
	activeTool,
	setActiveTool,
}: {
	activeTool: SimulatorToolId;
	setActiveTool: (tool: SimulatorToolId) => void;
}) {
	const { state } = useSimulatorRuntime();
	return (
		<>
			{state.capability.status !== 'available' && activeTool !== 'settings' ? (
				<button
					className="simulator-onboarding-banner"
					type="button"
					onClick={() => setActiveTool('settings')}
				>
					<span className="connection-dot" />
					<strong>Simulator setup needs attention</strong>
					<span>
						{state.capability.error ?? 'Review Xcode and native capability status.'}
					</span>
					<Settings2 className="h-3.5 w-3.5" />
				</button>
			) : null}
			<div className="min-h-0 flex-1">
				<SimulatorToolPanel tool={activeTool} />
			</div>
		</>
	);
}

// Native fleet polling must not rerender the connected app inspector.
const ConnectedContent = memo(function ConnectedContent({
	activeTool,
}: {
	activeTool: ToolId;
}) {
	const { runtimeError, selectedDevice, state } = useDesktopRuntime();
	return (
		<>
			{runtimeError ? <RuntimeBanner message={runtimeError} /> : null}
			{!state ? (
				<DesktopLoading />
			) : selectedDevice ? (
				<>
					{selectedDevice.status === 'offline' ? (
						<output className="offline-banner">
							Showing the last snapshot from an offline device. Remote actions are
							disabled until it reconnects.
						</output>
					) : null}
					<div className="min-h-0 flex-1">
						<ConnectedToolPanel tool={activeTool} />
					</div>
				</>
			) : (
				<WaitingForDevice />
			)}
		</>
	);
});

function ConnectedToolPanel({ tool }: { tool: ToolId }) {
	const Panel = TOOL_PANELS[tool];
	return (
		<Suspense fallback={<PanelLoading />}>
			<Panel />
		</Suspense>
	);
}

function SimulatorToolPanel({ tool }: { tool: SimulatorToolId }) {
	const Panel = SIMULATOR_PANELS[tool];
	return (
		<Suspense fallback={<PanelLoading />}>
			<Panel />
		</Suspense>
	);
}

function PanelLoading() {
	return (
		<output className="panel-loading" aria-label="Loading tool panel">
			<span />
			<span />
			<span />
		</output>
	);
}

function DesktopLoading() {
	return (
		<output className="waiting-state">
			<div className="waiting-icon">
				<TerminalSquare className="h-5 w-5" />
			</div>
			<h1>Starting PUMPD Devtools</h1>
			<p>Initializing the secure renderer bridge and local diagnostics broker.</p>
		</output>
	);
}

function RuntimeBanner({ message }: { message: string }) {
	return (
		<div className="runtime-banner" role="alert">
			<strong>Desktop runtime issue</strong>
			<span>{message}</span>
		</div>
	);
}

function WaitingForDevice() {
	const { state } = useDesktopRuntime();
	const brokerError = state?.broker.status === 'error' ? state.broker.error : undefined;
	return (
		<div className="waiting-state">
			<div className="waiting-icon">
				<TerminalSquare className="h-5 w-5" />
			</div>
			<StatusPill tone={brokerError ? 'danger' : 'warning'} dot>
				{brokerError ? 'Broker error' : 'Listening'}
			</StatusPill>
			<h1>
				{brokerError
					? 'The device broker could not start'
					: 'Waiting for a development device'}
			</h1>
			<p>
				{brokerError ??
					'Open PUMPD in development mode. The local client will discover this desktop broker and publish only registered diagnostic projections.'}
			</p>
		</div>
	);
}
