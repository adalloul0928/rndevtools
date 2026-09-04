import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	ChevronDown,
	Copy,
	Cpu,
	HardDrive,
	MemoryStick,
	Pencil,
	Play,
	Plus,
	Power,
	RotateCcw,
	Square,
	SquareCheckBig,
	Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
	BridgeUnavailableNotice,
	DenseVirtualList,
	formatBytes,
	NoSimulatorTarget,
	RefreshSimulatorsButton,
	SimulatorMetric,
	SimulatorPanelHeader,
	TargetStatePill,
} from '@/components/simulator-ui';
import {
	ConfirmAction,
	KeyValue,
	PanelNotice,
	SearchControl,
	Toolbar,
} from '@/components/ui';
import {
	defaultDiskCleanupCategoryIds,
	diskInventorySelectionRevision,
	sanitizeDiskCleanupCategoryIds,
} from '@/simulator/disk-inventory-model';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import {
	type SimulatorActionInput,
	useSimulatorRuntime,
} from '@/state/simulator-runtime';
import type { DeviceSession } from '../../../shared/protocol';
import type {
	SimulatorApp,
	SimulatorDevice,
	SimulatorDeviceMetrics,
	SimulatorDeviceType,
	SimulatorDiskCleanupCategoryId,
	SimulatorDiskInventory,
	SimulatorRuntime,
} from '../../../shared/simulator-protocol';

type TargetFilter = 'all' | SimulatorDevice['state'];

export function parseSimulatorCreateCount(value: string): number | null {
	const trimmed = value.trim();
	if (!/^(?:[1-9]|1\d|20)$/.test(trimmed)) return null;
	return Number(trimmed);
}

export function simulatorEraseAvailability(
	target: Pick<SimulatorDevice, 'isAvailable' | 'state'>,
	isBridgeAvailable: boolean
): { allowed: boolean; reason: string } {
	if (!isBridgeAvailable) {
		return { allowed: false, reason: 'Desktop Simulator controls are unavailable.' };
	}
	if (!target.isAvailable) {
		return { allowed: false, reason: 'This Simulator is unavailable in Xcode.' };
	}
	if (target.state !== 'shutdown') {
		return {
			allowed: false,
			reason: 'Shut down this Simulator first; erase is only valid while shut down.',
		};
	}
	return {
		allowed: true,
		reason: 'Returns this Simulator to a clean, recoverable state.',
	};
}

export function simulatorOpenPresentation(
	target: Pick<SimulatorDevice, 'isAvailable' | 'state'>,
	isBridgeAvailable: boolean
): { allowed: boolean; label: 'Boot & open' | 'Open Simulator' } {
	return {
		allowed:
			isBridgeAvailable &&
			target.isAvailable &&
			(target.state === 'shutdown' || target.state === 'booted'),
		label: target.state === 'booted' ? 'Open Simulator' : 'Boot & open',
	};
}

export function connectedSessionsForSimulator(
	udid: string,
	sessions: readonly DeviceSession[]
): DeviceSession[] {
	const normalizedUdid = udid.toUpperCase();
	const statusRank: Record<DeviceSession['status'], number> = {
		online: 0,
		simulated: 1,
		offline: 2,
	};
	return sessions
		.filter((session) => session.info.simulatorUdid?.toUpperCase() === normalizedUdid)
		.sort((left, right) => {
			const rankDifference = statusRank[left.status] - statusRank[right.status];
			return rankDifference || right.lastSeenAt - left.lastSeenAt;
		});
}

export function FleetPanel() {
	const desktop = useDesktopRuntime();
	const { isBridgeAvailable, runAction, selectedDevice, setSelectedDeviceUdid, state } =
		useSimulatorRuntime();
	const [query, setQuery] = useState('');
	const [filter, setFilter] = useState<TargetFilter>('all');
	const [batchUdids, setBatchUdids] = useState<string[]>([]);
	const [showCreate, setShowCreate] = useState(false);
	const normalizedQuery = query.trim().toLowerCase();
	const runtimeById = useMemo(
		() => new Map(state.runtimes.map((runtime) => [runtime.identifier, runtime])),
		[state.runtimes]
	);
	const deviceTypeById = useMemo(
		() =>
			new Map(
				state.deviceTypes.map((deviceType) => [deviceType.identifier, deviceType])
			),
		[state.deviceTypes]
	);
	const targets = useMemo(
		() =>
			state.devices.filter((target) => {
				const matchesFilter = filter === 'all' ? true : target.state === filter;
				const runtimeName = runtimeById.get(target.runtimeIdentifier)?.name ?? '';
				const deviceTypeName = target.deviceTypeIdentifier
					? (deviceTypeById.get(target.deviceTypeIdentifier)?.name ?? '')
					: '';
				const matchesQuery =
					normalizedQuery.length === 0 ||
					`${target.name} ${runtimeName} ${deviceTypeName} ${target.udid}`
						.toLowerCase()
						.includes(normalizedQuery);
				return matchesFilter && matchesQuery;
			}),
		[deviceTypeById, filter, normalizedQuery, runtimeById, state.devices]
	);
	const booted = state.devices.filter((target) => target.state === 'booted').length;
	const available = state.devices.filter((target) => target.isAvailable).length;
	const deviceMetrics = Object.values(state.metrics.byDevice);
	const totalSimulatorMemory = deviceMetrics.reduce(
		(total, metrics) => total + metrics.memoryBytes,
		0
	);
	const totalSimulatorProcesses = deviceMetrics.reduce(
		(total, metrics) => total + metrics.processCount,
		0
	);
	const associatedSessions = useMemo(
		() =>
			selectedDevice
				? connectedSessionsForSimulator(
						selectedDevice.udid,
						desktop.state?.devices ?? []
					)
				: [],
		[desktop.state?.devices, selectedDevice]
	);

	useEffect(() => {
		const known = new Set(state.devices.map((device) => device.udid));
		setBatchUdids((current) => current.filter((udid) => known.has(udid)));
	}, [state.devices]);

	const toggleBatchTarget = (target: SimulatorDevice) => {
		setSelectedDeviceUdid(target.udid);
		setBatchUdids((current) =>
			current.includes(target.udid)
				? current.filter((udid) => udid !== target.udid)
				: current.length >= 20
					? current
					: [...current, target.udid]
		);
	};
	const runBatchLifecycle = (kind: 'device.boot' | 'device.shutdown') => {
		for (const udid of batchUdids) {
			void runAction(
				{ kind, udid },
				{
					successMessage:
						kind === 'device.boot'
							? 'Simulator boot queued.'
							: 'Simulator shutdown queued.',
				}
			);
		}
	};

	return (
		<section className="panel-root">
			<SimulatorPanelHeader
				actions={<RefreshSimulatorsButton />}
				description="One control plane for installed iOS Simulator devices and runtimes. Discovery works independently of the PUMPD mobile diagnostics client."
				eyebrow="Targets"
				meta={`${state.devices.length} discovered`}
				title="Fleet"
			/>
			<BridgeUnavailableNotice />
			{state.metrics.error ? (
				<PanelNotice title="Resource metrics unavailable." tone="warning">
					{state.metrics.error}
				</PanelNotice>
			) : null}
			<div className="sim-metric-grid">
				<SimulatorMetric
					detail="active now"
					icon={<Play className="h-3.5 w-3.5" />}
					label="Booted"
					tone={booted > 0 ? 'success' : 'default'}
					value={String(booted)}
				/>
				<SimulatorMetric
					detail={
						state.metrics.status === 'available'
							? 'sampled Simulators'
							: state.metrics.status
					}
					icon={<MemoryStick className="h-3.5 w-3.5" />}
					label="Simulator RAM"
					value={
						state.metrics.status === 'available'
							? formatBytes(totalSimulatorMemory)
							: '—'
					}
				/>
				<SimulatorMetric
					detail={`${available} usable targets`}
					icon={<Cpu className="h-3.5 w-3.5" />}
					label="Processes"
					value={
						state.metrics.status === 'available' ? String(totalSimulatorProcesses) : '—'
					}
				/>
				<SimulatorMetric
					detail={
						state.metrics.host
							? `${state.metrics.host.memoryPressure} pressure`
							: 'host sample'
					}
					icon={<HardDrive className="h-3.5 w-3.5" />}
					label="Host free"
					tone={
						state.metrics.host?.memoryPressure === 'critical'
							? 'warning'
							: isBridgeAvailable
								? 'success'
								: 'warning'
					}
					value={
						state.metrics.host ? `${Math.round(state.metrics.host.freePercent)}%` : '—'
					}
				/>
			</div>
			{state.devices.length > 0 ? (
				<FleetStatusRail
					devices={state.devices}
					metrics={state.metrics.byDevice}
					runtimeById={runtimeById}
					selectedUdid={selectedDevice?.udid}
					onSelect={setSelectedDeviceUdid}
				/>
			) : null}
			<Toolbar>
				<SearchControl
					ariaLabel="Search Simulator targets"
					placeholder="Search name, runtime, or UDID"
					value={query}
					onChange={setQuery}
				/>
				<NativeSelect className="sim-filter-select" fullWidth={false}>
					<NativeSelect.Trigger
						aria-label="Filter targets"
						value={filter}
						onChange={(event) => setFilter(event.currentTarget.value as TargetFilter)}
					>
						<NativeSelect.Option value="all">All targets</NativeSelect.Option>
						<NativeSelect.Option value="booted">Booted</NativeSelect.Option>
						<NativeSelect.Option value="shutdown">Shutdown</NativeSelect.Option>
						<NativeSelect.Indicator>
							<ChevronDown className="h-3 w-3" />
						</NativeSelect.Indicator>
					</NativeSelect.Trigger>
				</NativeSelect>
				<span className="sim-toolbar-separator" />
				<Button
					isDisabled={!isBridgeAvailable || batchUdids.length === 0}
					size="sm"
					variant="secondary"
					onPress={() => runBatchLifecycle('device.boot')}
				>
					<Play className="h-3.5 w-3.5" /> Boot {batchUdids.length || ''}
				</Button>
				<Button
					isDisabled={!isBridgeAvailable || batchUdids.length === 0}
					size="sm"
					variant="ghost"
					onPress={() => runBatchLifecycle('device.shutdown')}
				>
					<Power className="h-3.5 w-3.5" /> Shut down {batchUdids.length || ''}
				</Button>
				<Button
					size="sm"
					variant={showCreate ? 'secondary' : 'ghost'}
					onPress={() => setShowCreate((shown) => !shown)}
				>
					<Plus className="h-3.5 w-3.5" /> Create
				</Button>
				<span className="sim-toolbar-meta sim-fleet-toolbar-meta">
					{targets.length} matching · {batchUdids.length} selected
				</span>
			</Toolbar>
			{showCreate ? (
				<CreateFleetControls
					deviceTypes={state.deviceTypes}
					isBridgeAvailable={isBridgeAvailable}
					runtimes={state.runtimes}
					onCreate={(action) =>
						void runAction(action, { successMessage: 'Simulator creation queued.' })
					}
				/>
			) : null}
			{state.devices.length === 0 ? (
				<div className="min-h-0 flex-1">
					<NoSimulatorTarget
						onOpenSettings={() => {
							window.location.hash = 'simulator/settings';
						}}
					/>
				</div>
			) : (
				<div className="sim-fleet-layout">
					<div className="sim-list-pane">
						<DenseVirtualList
							ariaLabel="Simulator fleet"
							emptyDescription="Try a different name, state, runtime, or device identifier."
							emptyTitle="No targets match these filters"
							items={targets}
							getId={(target) => target.udid}
							rowHeight={58}
							selectedId={selectedDevice?.udid}
							textValue={(target) =>
								`${target.name} ${runtimeById.get(target.runtimeIdentifier)?.name ?? ''}`
							}
							onSelect={toggleBatchTarget}
							renderItem={(target) => (
								<>
									<div
										className={`sim-list-leading ${batchUdids.includes(target.udid) ? 'text-blue-300' : ''}`}
									>
										{batchUdids.includes(target.udid) ? (
											<SquareCheckBig className="h-3.5 w-3.5" />
										) : (
											<Square className="h-3.5 w-3.5" />
										)}
									</div>
									<ListRowText
										description={`${target.deviceTypeIdentifier ? (deviceTypeById.get(target.deviceTypeIdentifier)?.name ?? 'Simulator') : 'Simulator'} · ${runtimeById.get(target.runtimeIdentifier)?.name ?? target.runtimeIdentifier}`}
										title={target.name}
									/>
									<TargetStatePill state={target.state} />
								</>
							)}
						/>
					</div>
					<div className="sim-detail-pane panel-scroll">
						{selectedDevice ? (
							<TargetDetail
								connectedSessions={associatedSessions}
								key={selectedDevice.udid}
								isBridgeAvailable={isBridgeAvailable}
								target={selectedDevice}
								runtime={runtimeById.get(selectedDevice.runtimeIdentifier)}
								deviceTypeName={
									selectedDevice.deviceTypeIdentifier
										? deviceTypeById.get(selectedDevice.deviceTypeIdentifier)?.name
										: undefined
								}
								apps={state.appsByDevice[selectedDevice.udid] ?? []}
								disk={state.diskByDevice[selectedDevice.udid]}
								metrics={state.metrics.byDevice[selectedDevice.udid]}
								onRunAction={(action, successMessage) =>
									void runAction(action, { successMessage })
								}
								onOpenConnectedSession={(deviceId) => {
									desktop.setSelectedDeviceId(deviceId);
									window.location.hash = 'connected/network';
								}}
							/>
						) : null}
					</div>
				</div>
			)}
		</section>
	);
}

function ListRowText({ title, description }: { title: string; description: string }) {
	return (
		<div className="sim-list-copy">
			<strong>{title}</strong>
			<span>{description}</span>
		</div>
	);
}

function FleetStatusRail({
	devices,
	metrics,
	runtimeById,
	selectedUdid,
	onSelect,
}: {
	devices: SimulatorDevice[];
	metrics: Record<string, SimulatorDeviceMetrics>;
	runtimeById: Map<string, SimulatorRuntime>;
	selectedUdid: string | undefined;
	onSelect: (udid: string) => void;
}) {
	const sampledCount = devices.filter((device) => metrics[device.udid]).length;
	return (
		<section className="sim-fleet-status-rail" aria-label="Live Simulator fleet">
			<header>
				<div>
					<span className="connection-dot is-online" />
					<strong>Live fleet</strong>
				</div>
				<span>
					{sampledCount}/{devices.length} resource samples · refreshes while visible
				</span>
			</header>
			<div className="sim-fleet-status-track">
				{devices.map((device) => {
					const metric = metrics[device.udid];
					const runtime = runtimeById.get(device.runtimeIdentifier);
					const selected = selectedUdid === device.udid;
					return (
						<button
							aria-current={selected ? 'true' : undefined}
							className={`sim-fleet-status-card is-${device.state} ${selected ? 'is-selected' : ''}`}
							key={device.udid}
							type="button"
							onClick={() => onSelect(device.udid)}
						>
							<span className="sim-fleet-status-card-heading">
								<span
									aria-hidden="true"
									className={`connection-dot ${device.state === 'booted' ? 'is-online' : ''}`}
								/>
								<strong>{device.name}</strong>
								<em>{device.state}</em>
							</span>
							<span className="sim-fleet-status-runtime">
								{runtime?.version ?? runtime?.name ?? 'Unknown runtime'}
							</span>
							<span className="sim-fleet-status-values">
								<span>
									CPU{' '}
									<strong>{metric ? `${metric.cpuPercent.toFixed(1)}%` : '—'}</strong>
								</span>
								<span>
									RAM <strong>{metric ? formatBytes(metric.memoryBytes) : '—'}</strong>
								</span>
								<span>
									PROC <strong>{metric?.processCount ?? '—'}</strong>
								</span>
							</span>
						</button>
					);
				})}
			</div>
		</section>
	);
}

function CreateFleetControls({
	runtimes,
	deviceTypes,
	isBridgeAvailable,
	onCreate,
}: {
	runtimes: SimulatorRuntime[];
	deviceTypes: SimulatorDeviceType[];
	isBridgeAvailable: boolean;
	onCreate: (action: SimulatorActionInput) => void;
}) {
	const availableRuntimes = useMemo(
		() => runtimes.filter((runtime) => runtime.isAvailable),
		[runtimes]
	);
	const [nameTemplate, setNameTemplate] = useState('PUMPD Test {n}');
	const [countText, setCountText] = useState('1');
	const [runtimeId, setRuntimeId] = useState(availableRuntimes[0]?.identifier ?? '');
	const [deviceTypeId, setDeviceTypeId] = useState(deviceTypes[0]?.identifier ?? '');
	useEffect(() => {
		if (!availableRuntimes.some((runtime) => runtime.identifier === runtimeId)) {
			setRuntimeId(availableRuntimes[0]?.identifier ?? '');
		}
		if (!deviceTypes.some((deviceType) => deviceType.identifier === deviceTypeId)) {
			setDeviceTypeId(deviceTypes[0]?.identifier ?? '');
		}
	}, [availableRuntimes, deviceTypeId, deviceTypes, runtimeId]);
	const count = parseSimulatorCreateCount(countText);
	const canCreate =
		isBridgeAvailable &&
		nameTemplate.trim().length > 0 &&
		count !== null &&
		Boolean(runtimeId) &&
		Boolean(deviceTypeId);
	return (
		<div className="sim-fleet-create">
			<div className="sim-toolbar-field sim-toolbar-field-grow">
				<span>Naming template</span>
				<Input
					aria-label="Simulator naming template"
					placeholder="PUMPD Test {n}"
					value={nameTemplate}
					onChange={(event) => setNameTemplate(event.currentTarget.value)}
				/>
			</div>
			<div className="sim-toolbar-field sim-create-count">
				<span>Count</span>
				<Input
					aria-label="Number of Simulators to create"
					aria-invalid={count === null}
					inputMode="numeric"
					value={countText}
					onChange={(event) => setCountText(event.currentTarget.value)}
				/>
				{count === null ? (
					<small className="sim-field-error" role="alert">
						Enter a whole number from 1–20.
					</small>
				) : null}
			</div>
			<NativeSelect className="sim-create-select" fullWidth={false}>
				<NativeSelect.Trigger
					aria-label="Simulator runtime for new devices"
					disabled={availableRuntimes.length === 0}
					value={runtimeId}
					onChange={(event) => setRuntimeId(event.currentTarget.value)}
				>
					{runtimes.map((runtime) => (
						<NativeSelect.Option
							disabled={!runtime.isAvailable}
							key={runtime.identifier}
							value={runtime.identifier}
						>
							{runtime.name}
							{runtime.isAvailable ? '' : ' — unavailable'}
						</NativeSelect.Option>
					))}
					<NativeSelect.Indicator>
						<ChevronDown className="h-3 w-3" />
					</NativeSelect.Indicator>
				</NativeSelect.Trigger>
			</NativeSelect>
			<NativeSelect className="sim-create-select" fullWidth={false}>
				<NativeSelect.Trigger
					aria-label="Simulator device type for new devices"
					disabled={deviceTypes.length === 0}
					value={deviceTypeId}
					onChange={(event) => setDeviceTypeId(event.currentTarget.value)}
				>
					{deviceTypes.map((deviceType) => (
						<NativeSelect.Option
							key={deviceType.identifier}
							value={deviceType.identifier}
						>
							{deviceType.name}
						</NativeSelect.Option>
					))}
					<NativeSelect.Indicator>
						<ChevronDown className="h-3 w-3" />
					</NativeSelect.Indicator>
				</NativeSelect.Trigger>
			</NativeSelect>
			<Button
				isDisabled={!canCreate}
				size="sm"
				variant="primary"
				onPress={() => {
					if (count === null) return;
					for (let index = 1; index <= count; index += 1) {
						const baseName = nameTemplate.trim();
						const name = baseName.includes('{n}')
							? baseName.replaceAll('{n}', String(index))
							: count === 1
								? baseName
								: `${baseName} ${index}`;
						onCreate({
							kind: 'device.create',
							name,
							deviceTypeIdentifier: deviceTypeId,
							runtimeIdentifier: runtimeId,
						});
					}
				}}
			>
				<Plus className="h-3.5 w-3.5" /> Create {count ?? ''}
			</Button>
			<span className="sim-toolbar-meta">
				{availableRuntimes.length === 0
					? 'No available iOS runtime. Install or repair one in Xcode.'
					: `${runtimes.length - availableRuntimes.length} unavailable runtime${runtimes.length - availableRuntimes.length === 1 ? '' : 's'} disabled · use {n} for numbering`}
			</span>
		</div>
	);
}

function TargetDetail({
	target,
	runtime,
	deviceTypeName,
	apps,
	disk,
	metrics,
	connectedSessions,
	isBridgeAvailable,
	onRunAction,
	onOpenConnectedSession,
}: {
	target: SimulatorDevice;
	runtime: SimulatorRuntime | undefined;
	deviceTypeName: string | undefined;
	apps: SimulatorApp[];
	disk: SimulatorDiskInventory | undefined;
	metrics: SimulatorDeviceMetrics | undefined;
	connectedSessions: DeviceSession[];
	isBridgeAvailable: boolean;
	onRunAction: (action: SimulatorActionInput, successMessage: string) => void;
	onOpenConnectedSession: (deviceId: string) => void;
}) {
	const [renameName, setRenameName] = useState(target.name);
	const [cloneName, setCloneName] = useState(`${target.name} Copy`);
	const openPresentation = simulatorOpenPresentation(target, isBridgeAvailable);
	const canStop = isBridgeAvailable && target.state === 'booted';
	const eraseAvailability = simulatorEraseAvailability(target, isBridgeAvailable);
	const activeApp = metrics?.activeApp;
	const activeAppName = activeApp
		? apps.find((app) => app.bundleIdentifier === activeApp.bundleIdentifier)
				?.displayName
		: undefined;
	return (
		<div className="sim-target-detail">
			<div className="sim-device-stage" aria-hidden="true">
				<div className={`sim-device-frame is-${target.state}`}>
					<span className="sim-device-island" />
					<div className="sim-device-screen">
						<div className="sim-device-time">9:41</div>
						<div className="sim-device-app-grid">
							{['01', '02', '03', '04', '05', '06'].map((id) => (
								<span key={id} />
							))}
						</div>
						<p>{target.state === 'booted' ? 'Ready for actions' : target.state}</p>
					</div>
				</div>
			</div>
			<div className="sim-detail-heading">
				<div>
					<p className="sim-eyebrow">Selected target</p>
					<h2>{target.name}</h2>
					<span>{deviceTypeName ?? 'iOS Simulator'}</span>
				</div>
				<TargetStatePill state={target.state} />
			</div>
			<div className="sim-action-row">
				<Button
					isDisabled={!openPresentation.allowed}
					size="sm"
					variant="primary"
					onPress={() =>
						onRunAction(
							{ kind: 'device.boot', udid: target.udid },
							target.state === 'booted'
								? `${target.name} opened in Simulator.`
								: `${target.name} is booting.`
						)
					}
				>
					<Play className="h-3.5 w-3.5" /> {openPresentation.label}
				</Button>
				<Button
					isDisabled={!isBridgeAvailable || target.state !== 'booted'}
					size="sm"
					variant="secondary"
					onPress={() =>
						onRunAction(
							{ kind: 'app.list', udid: target.udid },
							'Installed apps refreshed.'
						)
					}
				>
					<RotateCcw className="h-3.5 w-3.5" /> Refresh apps
				</Button>
				<Button
					isDisabled={!canStop}
					size="sm"
					variant="ghost"
					onPress={() =>
						onRunAction(
							{ kind: 'device.shutdown', udid: target.udid },
							`${target.name} is shutting down.`
						)
					}
				>
					<Power className="h-3.5 w-3.5" /> Shut down
				</Button>
			</div>
			<section className="sim-detail-section">
				<h3>Target information</h3>
				<dl>
					<KeyValue label="UDID" mono value={target.udid} />
					<KeyValue label="Runtime" value={runtime?.name ?? target.runtimeIdentifier} />
					<KeyValue label="OS" value={runtime?.version ?? 'Unknown'} />
					<KeyValue label="Device type" value={deviceTypeName ?? 'Unknown'} />
					<KeyValue label="Installed apps" value={apps.length} />
					<KeyValue
						label="Largest app process"
						mono={Boolean(activeApp)}
						value={
							activeApp
								? `${activeAppName ? `${activeAppName} · ` : ''}${activeApp.bundleIdentifier} · PID ${activeApp.processId}`
								: target.state === 'booted'
									? 'No app process sampled'
									: 'Simulator is shut down'
						}
					/>
					<KeyValue
						label="Resource sample"
						value={
							metrics ? new Date(metrics.sampledAt).toLocaleTimeString() : 'Unavailable'
						}
					/>
				</dl>
			</section>
			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>Connected PUMPD sessions</h3>
						<p>Matched by the app-reported Simulator UDID</p>
					</div>
					<span>{connectedSessions.length}</span>
				</div>
				{connectedSessions.length > 0 ? (
					<div className="sim-installed-apps sim-connected-sessions">
						{connectedSessions.map((session) => (
							<div key={session.info.id}>
								<span
									aria-hidden="true"
									className={`connection-dot ${session.status === 'online' ? 'is-online' : ''}`}
								/>
								<div>
									<strong>
										{session.info.variant ?? session.info.name}
										{session.info.bundleIdentifier
											? ` · ${session.info.bundleIdentifier}`
											: ''}
									</strong>
									<code>
										{session.status}
										{session.info.processId ? ` · PID ${session.info.processId}` : ''}
										{` · ${session.info.id}`}
									</code>
								</div>
								<Button
									size="sm"
									variant="ghost"
									onPress={() => onOpenConnectedSession(session.info.id)}
								>
									Open diagnostics
								</Button>
							</div>
						))}
					</div>
				) : (
					<p className="sim-section-empty">
						No connected PUMPD app has reported this Simulator UDID. Protocol-v1
						sessions remain available in Connected App but cannot be joined reliably.
					</p>
				)}
			</section>
			<DiskInventorySection
				disk={disk}
				isBridgeAvailable={isBridgeAvailable}
				target={target}
				onRunAction={onRunAction}
			/>
			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>Resource monitoring</h3>
						<p>Bounded host process sample for this Simulator</p>
					</div>
					<Cpu className="h-3.5 w-3.5" />
				</div>
				{metrics ? (
					<>
						<div className="sim-device-metrics">
							<div>
								<span>CPU</span>
								<strong>{metrics.cpuPercent.toFixed(1)}%</strong>
							</div>
							<div>
								<span>Memory</span>
								<strong>{formatBytes(metrics.memoryBytes)}</strong>
							</div>
							<div>
								<span>Processes</span>
								<strong>{metrics.processCount}</strong>
							</div>
							<div>
								<span>Disk allocated</span>
								<strong>
									{metrics.diskAllocatedBytes === undefined
										? '—'
										: formatBytes(metrics.diskAllocatedBytes)}
								</strong>
							</div>
						</div>
						<div className="sim-process-list">
							{[...metrics.processes]
								.sort((left, right) => right.memoryBytes - left.memoryBytes)
								.slice(0, 20)
								.map((processMetric) => (
									<div key={processMetric.processId}>
										<span>
											<strong>{processMetric.name}</strong>
											<code>PID {processMetric.processId}</code>
										</span>
										<span>
											<code>{processMetric.cpuPercent.toFixed(1)}% CPU</code>
											<code>{formatBytes(processMetric.memoryBytes)}</code>
										</span>
									</div>
								))}
						</div>
					</>
				) : (
					<p className="sim-section-empty">
						No native resource sample is available for this target.
					</p>
				)}
			</section>
			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>Manage target</h3>
						<p>Rename or create a repairable clone</p>
					</div>
					<Pencil className="h-3.5 w-3.5" />
				</div>
				<div className="sim-manage-target-row">
					<Input
						aria-label="New Simulator name"
						value={renameName}
						onChange={(event) => setRenameName(event.currentTarget.value)}
					/>
					<Button
						isDisabled={
							!isBridgeAvailable ||
							renameName.trim().length === 0 ||
							renameName.trim() === target.name
						}
						size="sm"
						variant="secondary"
						onPress={() =>
							onRunAction(
								{ kind: 'device.rename', udid: target.udid, name: renameName.trim() },
								`${target.name} was renamed.`
							)
						}
					>
						<Pencil className="h-3.5 w-3.5" /> Rename
					</Button>
				</div>
				<div className="sim-manage-target-row">
					<Input
						aria-label="Cloned Simulator name"
						value={cloneName}
						onChange={(event) => setCloneName(event.currentTarget.value)}
					/>
					<Button
						isDisabled={!isBridgeAvailable || cloneName.trim().length === 0}
						size="sm"
						variant="secondary"
						onPress={() =>
							onRunAction(
								{ kind: 'device.clone', udid: target.udid, name: cloneName.trim() },
								`${target.name} clone queued.`
							)
						}
					>
						<Copy className="h-3.5 w-3.5" /> Clone
					</Button>
				</div>
				<p className="sim-inline-note">
					A clone is the supported repair path today. If cloning fails, the backend
					reports the exact simctl error without mutating the source.
				</p>
			</section>
			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<h3>Installed apps</h3>
					<span>{apps.length}</span>
				</div>
				{apps.length > 0 ? (
					<div className="sim-installed-apps">
						{apps.slice(0, 20).map((app) => (
							<div key={app.bundleIdentifier}>
								<span className="sim-app-icon">
									{app.displayName.slice(0, 1).toUpperCase()}
								</span>
								<div>
									<strong>{app.displayName}</strong>
									<code>{app.bundleIdentifier}</code>
								</div>
								{!app.isSystem ? (
									<ConfirmAction
										confirmLabel="Uninstall app"
										description={`Remove ${app.displayName} and its app data from ${target.name}. Native confirmation is required.`}
										isDisabled={!isBridgeAvailable}
										title={`Uninstall ${app.displayName}?`}
										triggerIcon={<Trash2 className="h-3 w-3" />}
										triggerLabel="Uninstall"
										onConfirm={() =>
											onRunAction(
												{
													kind: 'app.uninstall',
													udid: target.udid,
													bundleIdentifier: app.bundleIdentifier,
												},
												`${app.displayName} uninstall queued.`
											)
										}
									/>
								) : null}
							</div>
						))}
					</div>
				) : (
					<p className="sim-section-empty">No user-installed apps were reported.</p>
				)}
			</section>
			<section className="sim-danger-zone">
				<div>
					<strong>Erase content and settings</strong>
					<span>{eraseAvailability.reason}</span>
				</div>
				<ConfirmAction
					confirmLabel="Erase Simulator"
					description={`This removes every app and all data from ${target.name}. The target must be shut down first.`}
					isDisabled={!eraseAvailability.allowed}
					title={`Erase ${target.name}?`}
					triggerIcon={<RotateCcw className="h-3.5 w-3.5" />}
					triggerLabel="Erase"
					onConfirm={() =>
						onRunAction(
							{ kind: 'device.erase', udid: target.udid },
							`${target.name} was erased.`
						)
					}
				/>
			</section>
			<section className="sim-danger-zone">
				<div>
					<strong>Delete Simulator</strong>
					<span>Permanently removes this target and its local data.</span>
				</div>
				<ConfirmAction
					confirmLabel="Delete Simulator"
					description={`Permanently delete ${target.name}. Native confirmation issues a short-lived token bound to this exact request.`}
					isDisabled={!isBridgeAvailable}
					title={`Delete ${target.name}?`}
					triggerIcon={<Trash2 className="h-3.5 w-3.5" />}
					triggerLabel="Delete"
					onConfirm={() =>
						onRunAction(
							{ kind: 'device.delete', udid: target.udid },
							`${target.name} deletion queued.`
						)
					}
				/>
			</section>
		</div>
	);
}

function DiskInventorySection({
	disk,
	target,
	isBridgeAvailable,
	onRunAction,
}: {
	disk: SimulatorDiskInventory | undefined;
	target: SimulatorDevice;
	isBridgeAvailable: boolean;
	onRunAction: (action: SimulatorActionInput, successMessage: string) => void;
}) {
	const [selection, setSelection] = useState<{
		revision: string;
		categoryIds: SimulatorDiskCleanupCategoryId[];
	}>({ revision: 'none', categoryIds: [] });
	const inventoryRevision = diskInventorySelectionRevision(disk);

	const selected = disk
		? selection.revision === inventoryRevision
			? sanitizeDiskCleanupCategoryIds(disk, selection.categoryIds)
			: defaultDiskCleanupCategoryIds(disk)
		: [];
	const selectedBytes = disk
		? disk.categories
				.filter((category) =>
					selected.includes(category.id as SimulatorDiskCleanupCategoryId)
				)
				.reduce((total, category) => total + category.bytes, 0)
		: 0;

	return (
		<section className="sim-detail-section sim-disk-inventory">
			<div className="sim-section-heading">
				<div>
					<h3>Disk inventory</h3>
					<p>Categorized by the signed, pinned SimSlim helper</p>
				</div>
				<Button
					isDisabled={!isBridgeAvailable || !target.isAvailable}
					size="sm"
					variant="ghost"
					onPress={() =>
						onRunAction(
							{ kind: 'disk.inspect', udid: target.udid },
							`${target.name} disk inventory refresh queued.`
						)
					}
				>
					<HardDrive className="h-3.5 w-3.5" /> {disk ? 'Refresh' : 'Inspect'}
				</Button>
			</div>
			{disk ? (
				<>
					<div className="sim-disk-summary">
						<div>
							<span>Simulator data</span>
							<strong>{formatBytes(disk.totalBytes)}</strong>
						</div>
						<div>
							<span>Known cleanable</span>
							<strong>{formatBytes(disk.cleanableBytes)}</strong>
						</div>
						<div>
							<span>Selected</span>
							<strong>{formatBytes(selectedBytes)}</strong>
						</div>
					</div>
					<section className="sim-disk-storage" aria-label="Protected disk storage">
						{disk.storage.map((item) => (
							<div key={item.id}>
								<span>
									<strong>{item.name}</strong>
									<small>{item.description}</small>
								</span>
								<code>{formatBytes(item.bytes)}</code>
							</div>
						))}
					</section>
					<fieldset className="sim-disk-categories">
						<legend>Allowlisted cleanup categories</legend>
						{disk.categories.map((category) => {
							const categoryId = category.id as SimulatorDiskCleanupCategoryId;
							const isSelected = selected.includes(categoryId);
							return (
								<button
									aria-pressed={category.canClean ? isSelected : undefined}
									className={`${isSelected ? 'is-selected' : ''} ${category.canClean ? '' : 'is-protected'}`}
									disabled={!category.canClean}
									key={category.id}
									type="button"
									onClick={() => {
										if (!disk || !category.canClean) return;
										const next = isSelected
											? selected.filter((id) => id !== categoryId)
											: [...selected, categoryId];
										setSelection({
											revision: inventoryRevision,
											categoryIds: sanitizeDiskCleanupCategoryIds(disk, next),
										});
									}}
								>
									<span className="sim-disk-category-check">
										{isSelected ? (
											<SquareCheckBig className="h-3.5 w-3.5" />
										) : (
											<Square className="h-3.5 w-3.5" />
										)}
									</span>
									<span>
										<strong>{category.name}</strong>
										<small>{category.description}</small>
										<em>
											{category.canClean
												? `Risk ${category.risk} · ${category.downside} Recovery: ${category.recovery}`
												: `Protected · ${category.downside}`}
										</em>
									</span>
									<code>{formatBytes(category.bytes)}</code>
								</button>
							);
						})}
					</fieldset>
					<div className="sim-disk-cleanup-action">
						<div>
							<strong>{selected.length} categories selected</strong>
							<span>
								Cleanup is scoped to known Simulator paths and requires exact native
								confirmation.
							</span>
						</div>
						<ConfirmAction
							confirmLabel="Clean selected data"
							description={`Remove ${formatBytes(selectedBytes)} of allowlisted caches and generated data from ${target.name}. The backend preserves and verifies the prior boot state.`}
							isDisabled={!isBridgeAvailable || selected.length === 0}
							title={`Clean disk data from ${target.name}?`}
							triggerIcon={<Trash2 className="h-3 w-3" />}
							triggerLabel="Clean selected"
							onConfirm={() =>
								onRunAction(
									{
										kind: 'disk.cleanup',
										udid: target.udid,
										categoryIds: selected,
									},
									`${target.name} cleanup queued.`
								)
							}
						/>
					</div>
					{disk.lastCleanup ? (
						<p className="sim-disk-last-cleanup" role="status">
							Last cleanup reclaimed {formatBytes(disk.lastCleanup.reclaimedBytes)} ·{' '}
							{disk.lastCleanup.bootStateRestored
								? 'original boot state restored'
								: 'boot state needs attention'}{' '}
							· {new Date(disk.lastCleanup.cleanedAt).toLocaleString()}
						</p>
					) : null}
					<p className="sim-inline-note">
						Inspected {new Date(disk.inspectedAt).toLocaleString()}. Installed apps,
						Documents, app data, user media, and required Siri assets are never cleanup
						targets.
					</p>
				</>
			) : (
				<p className="sim-section-empty">
					Inspect this target to classify cleanable caches, logs, temporary files, and
					linguistic data separately from protected app and user storage.
				</p>
			)}
		</section>
	);
}
