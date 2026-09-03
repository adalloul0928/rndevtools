import { Button } from '@heroui/react/button';
import { Tooltip } from '@heroui/react/tooltip';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	Cable,
	ChevronDown,
	PanelLeftClose,
	PanelLeftOpen,
	Radio,
	TerminalSquare,
} from 'lucide-react';
import {
	type ComponentType,
	type LazyExoticComponent,
	lazy,
	Suspense,
	useEffect,
	useState,
} from 'react';
import { ActionNotice, StatusPill } from '@/components/status-ui';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import { isToolId, toolGroups } from '@/tool-config';
import type { PerformanceSample, ToolId } from '../shared/protocol';

const TRACE_BAR_COUNT = 28;
const TRACE_BAR_MAX_HEIGHT = 14;
const TRACE_BAR_MIN_HEIGHT = 2;

/** Stable keys for the fixed-width trace, which is a shape rather than a list. */
const TRACE_SLOTS = Array.from(
	{ length: TRACE_BAR_COUNT },
	(_, index) => `trace-${index}`
);

/** One spelling of the sidebar shortcut for the tooltip and the sidebar footer. */
function sidebarShortcut(platform: string | undefined): string {
	return platform === 'darwin' ? '⌘B' : 'Ctrl+B';
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
const DiagnosticsPanel = lazy(() =>
	import('@/panels/diagnostics-panel').then((module) => ({
		default: module.DiagnosticsPanel,
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
	performance: PerformancePanel,
	components: ComponentsPanel,
	diagnostics: DiagnosticsPanel,
};

function initialTool(): ToolId {
	const hash = window.location.hash.slice(1);
	return isToolId(hash) ? hash : 'network';
}

export function App() {
	const {
		actionStatus,
		bootstrap,
		clearActionStatus,
		runtimeError,
		selectedDevice,
		setSelectedDeviceId,
		state,
	} = useDesktopRuntime();
	const [activeTool, setActiveToolState] = useState<ToolId>(initialTool);
	const [sidebarOpen, setSidebarOpen] = useState(true);

	useEffect(() => {
		if (actionStatus.kind !== 'success') return;
		const timer = window.setTimeout(clearActionStatus, 3_500);
		return () => window.clearTimeout(timer);
	}, [actionStatus, clearActionStatus]);

	useEffect(() => {
		const onHashChange = () => {
			const hash = window.location.hash.slice(1);
			if (isToolId(hash)) setActiveToolState(hash);
		};
		window.addEventListener('hashchange', onHashChange);
		return () => window.removeEventListener('hashchange', onHashChange);
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.repeat || event.altKey || event.shiftKey) {
				return;
			}
			const hasPlatformModifier =
				bootstrap?.platform === 'darwin' ? event.metaKey : event.ctrlKey;
			if (!hasPlatformModifier || event.key.toLowerCase() !== 'b') return;
			event.preventDefault();
			setSidebarOpen((open) => !open);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [bootstrap?.platform]);

	const setActiveTool = (tool: ToolId) => {
		setActiveToolState(tool);
		window.history.replaceState(null, '', `#${tool}`);
	};
	const latest = selectedDevice?.tools.performance.samples.at(-1);
	const connected =
		state?.devices.filter((device) => device.status === 'online').length ?? 0;

	return (
		<div className="desktop-provider">
			<Titlebar
				connected={connected}
				latest={latest}
				sidebarOpen={sidebarOpen}
				setActiveTool={setActiveTool}
				setSelectedDeviceId={setSelectedDeviceId}
				setSidebarOpen={setSidebarOpen}
			/>
			<div className="desktop-body">
				{sidebarOpen ? (
					<DesktopSidebar activeTool={activeTool} setActiveTool={setActiveTool} />
				) : null}
				<main className="desktop-main">
					<div className="desktop-content">
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
									<ToolPanel tool={activeTool} />
								</div>
							</>
						) : (
							<WaitingForDevice />
						)}
					</div>
				</main>
			</div>
			{actionStatus.kind !== 'idle' ? (
				<ActionNotice
					kind={actionStatus.kind}
					message={actionStatus.message}
					onDismiss={clearActionStatus}
				/>
			) : null}
		</div>
	);
}

function Titlebar({
	connected,
	latest,
	sidebarOpen,
	setActiveTool,
	setSelectedDeviceId,
	setSidebarOpen,
}: {
	connected: number;
	latest:
		| { jsFps: number; eventLoopLagMs: number; memoryMb?: number | undefined }
		| undefined;
	sidebarOpen: boolean;
	setActiveTool: (tool: ToolId) => void;
	setSelectedDeviceId: (deviceId: string) => void;
	setSidebarOpen: (open: boolean) => void;
}) {
	const { bootstrap, selectedDevice, state } = useDesktopRuntime();
	const sidebarLabel = sidebarOpen ? 'Hide sidebar' : 'Show sidebar';

	return (
		<header
			className={`titlebar ${bootstrap?.platform === 'darwin' ? 'is-macos' : ''}`}
		>
			<div className="titlebar-safe-area">
				<div className="titlebar-lead">
					<span className="titlebar-title">PUMPD Devtools</span>
					<span aria-hidden="true" className="titlebar-rule" />
					<div className="titlebar-control no-drag">
						<Tooltip delay={500}>
							<Button
								aria-label={sidebarLabel}
								className="titlebar-icon-button"
								isIconOnly
								variant="ghost"
								onPress={() => setSidebarOpen(!sidebarOpen)}
							>
								{sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
							</Button>
							<Tooltip.Content>
								{sidebarLabel} · {sidebarShortcut(bootstrap?.platform)}
							</Tooltip.Content>
						</Tooltip>
					</div>
				</div>
				<div className="titlebar-trail">
					<LiveTrace samples={selectedDevice?.tools.performance.samples} />
					<div className="titlebar-metrics">
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
					</div>
					<span aria-hidden="true" className="titlebar-rule" />
					<div className="titlebar-controls no-drag">
						<button
							className="connection-button"
							type="button"
							onClick={() => setActiveTool('diagnostics')}
						>
							<span
								className={`connection-dot ${state?.broker.status === 'listening' ? 'is-online' : ''}`}
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
								disabled={!state?.devices.length}
								value={selectedDevice?.info.id ?? ''}
								onChange={(event) => setSelectedDeviceId(event.currentTarget.value)}
							>
								{!state?.devices.length ? (
									<NativeSelect.Option value="">No device</NativeSelect.Option>
								) : null}
								{state?.devices.map((device) => (
									<NativeSelect.Option key={device.info.id} value={device.info.id}>
										{device.info.name} · {device.status}
									</NativeSelect.Option>
								))}
								<NativeSelect.Indicator>
									<ChevronDown className="h-3 w-3" />
								</NativeSelect.Indicator>
							</NativeSelect.Trigger>
						</NativeSelect>
					</div>
				</div>
			</div>
		</header>
	);
}

/**
 * Fixed-width event-loop trace. The newest sample is the rightmost bar, so the
 * slots fill from the end and a short history leaves leading bars idle.
 */
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

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className="titlebar-metric">
			<span>{label}</span>
			<strong>{value}</strong>
		</div>
	);
}

function DesktopSidebar({
	activeTool,
	setActiveTool,
}: {
	activeTool: ToolId;
	setActiveTool: (tool: ToolId) => void;
}) {
	const { bootstrap, selectedDevice, state } = useDesktopRuntime();
	return (
		<aside className="desktop-sidebar" aria-label="Developer tools">
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
			<nav className="desktop-sidebar-content" aria-label="Tool panels">
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
					<span>Toggle sidebar</span>
					<kbd>{sidebarShortcut(bootstrap?.platform)}</kbd>
				</div>
			</footer>
		</aside>
	);
}

function ToolPanel({ tool }: { tool: ToolId }) {
	const Panel = TOOL_PANELS[tool];
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
