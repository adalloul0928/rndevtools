import { Button } from '@heroui/react/button';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	Bot,
	ChevronDown,
	FolderGit2,
	FolderPlus,
	Play,
	RefreshCw,
	ScrollText,
	Square,
	Waypoints,
	X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ControllableScreen } from '@/components/controllable-screen';
import { VisibleDeviceScreen } from '@/components/device-screen';
import {
	AgentBadge,
	LaneChip,
	LaneSlimBadge,
	WorktreeLabel,
} from '@/components/lane-ui';
import {
	SimulatorMetric,
	SimulatorPanelHeader,
} from '@/components/simulator-ui';
import {
	ConfirmAction,
	Disclosure,
	InfoPopover,
	KeyValue,
	PanelNotice,
	StatusPill,
} from '@/components/ui';
import { shortPath } from '@/simulator/fleet-model';
import { useAgentRuntime } from '@/state/agent-runtime';
import { useLaneRuntime } from '@/state/lane-runtime';
import { useSimulatorRuntime } from '@/state/simulator-runtime';
import { useSlimmingRuntime } from '@/state/slimming-runtime';
import type {
	Lane,
	LaneEnvironment,
	LaneState,
	LaneWorktree,
} from '../../../shared/lane-protocol';
import {
	LANE_METRO_HEALTH_TIMEOUT_MS,
	laneDevClientLaunchUrl,
} from '../../../shared/lane-protocol';
import type { SimulatorDevice } from '../../../shared/simulator-protocol';
import type { SlimmingProfile } from '../../../shared/slimming-protocol';
import { AgentsView } from './agents-view';

/**
 * Picks the worktree to preselect: the first one without a lane, so a second
 * "Start lane" never silently targets a checkout that is already running.
 */
export function defaultLaneWorktree(
	worktrees: readonly LaneWorktree[]
): string {
	return (
		worktrees.find((worktree) => !worktree.laneId)?.path ??
		worktrees[0]?.path ??
		''
	);
}

/**
 * Devices are offered booted-first, then shut down; devices another lane owns
 * stay visible but disabled so the operator sees why they cannot be chosen.
 */
export function laneDeviceOptions(
	devices: readonly SimulatorDevice[],
	lanes: readonly Lane[]
): Array<{ device: SimulatorDevice; disabledReason?: string }> {
	const laneByUdid = new Map(
		lanes.map((lane) => [lane.simulatorUdid.toUpperCase(), lane])
	);
	return devices
		.filter((device) => device.isAvailable)
		.map((device) => {
			const lane = laneByUdid.get(device.udid.toUpperCase());
			return lane
				? { device, disabledReason: `lane ${lane.branch}` }
				: { device };
		})
		.sort(
			(left, right) =>
				Number(right.device.state === 'booted') -
					Number(left.device.state === 'booted') ||
				left.device.name.localeCompare(right.device.name)
		);
}

export function laneSummaryCounts(state: LaneState): {
	lanes: number;
	ready: number;
	agents: number;
	worktrees: number;
} {
	return {
		lanes: state.lanes.length,
		ready: state.lanes.filter((lane) => lane.metro === 'ready').length,
		agents: state.lanes.filter((lane) => lane.agent).length,
		worktrees: state.worktrees.length,
	};
}

export function LanesPanel() {
	const slimming = useSlimmingRuntime();
	const lanes = useLaneRuntime();
	const simulator = useSimulatorRuntime();
	const [selectedLaneId, setSelectedLaneId] = useState<string>('');
	const [showStart, setShowStart] = useState(false);
	const [view, setView] = useState<'lanes' | 'agents'>('lanes');
	const agents = useAgentRuntime();
	const liveAgentCount = agents.state.sessions.length;
	const [log, setLog] = useState<{ laneId: string; text: string } | null>(null);
	const counts = laneSummaryCounts(lanes.state);
	const hostFree = simulator.state.metrics.host;

	useEffect(() => {
		if (!lanes.state.lanes.some((lane) => lane.id === selectedLaneId)) {
			setSelectedLaneId(lanes.state.lanes[0]?.id ?? '');
		}
	}, [lanes.state.lanes, selectedLaneId]);

	const selectedLane = lanes.state.lanes.find(
		(lane) => lane.id === selectedLaneId
	);
	const deviceByUdid = useMemo(
		() =>
			new Map(
				simulator.state.devices.map((device) => [
					device.udid.toUpperCase(),
					device,
				])
			),
		[simulator.state.devices]
	);

	const launch = (lane: Lane) =>
		void lanes.runOperation(
			{ kind: 'lane.launch', laneId: lane.id },
			{
				pendingMessage: `Waiting for Metro on :${lane.port}…`,
				successMessage: `${lane.branch} launched on ${deviceByUdid.get(lane.simulatorUdid.toUpperCase())?.name ?? 'its Simulator'}.`,
			}
		);
	const stop = (lane: Lane) =>
		void lanes.runOperation(
			{ kind: 'lane.stop', laneId: lane.id },
			{ successMessage: `Lane ${lane.branch} stopped; its Simulator is free.` }
		);
	const decideSlim = (lane: Lane, decision: 'approve' | 'dismiss') =>
		void lanes.runOperation(
			{ kind: 'lane.slim', laneId: lane.id, decision },
			decision === 'approve'
				? {
						pendingMessage: `Applying ${lane.slim?.profileId ?? 'the profile'} to ${deviceByUdid.get(lane.simulatorUdid.toUpperCase())?.name ?? 'the Simulator'}…`,
						successMessage: 'Slimming finished; see the lane for the outcome.',
					}
				: { successMessage: 'Slimming request dismissed.' }
		);
	const readLog = async (lane: Lane) => {
		const receipt = await lanes.runOperation({
			kind: 'lane.log',
			laneId: lane.id,
			maxCharacters: 16 * 1024,
		});
		if (receipt?.completed) {
			setLog({ laneId: lane.id, text: receipt.log ?? '' });
		}
	};

	return (
		<section className="panel-root">
			<SimulatorPanelHeader
				actions={
					<>
						<Button
							aria-label="Refresh lanes"
							className="sim-icon-button"
							isDisabled={
								!lanes.isBridgeAvailable || lanes.pendingOperation !== null
							}
							isIconOnly
							size="sm"
							variant="secondary"
							onPress={() => void lanes.refresh()}
						>
							<RefreshCw
								className={`h-3.5 w-3.5 ${lanes.pendingOperation === 'lane.refresh' ? 'animate-spin' : ''}`}
							/>
						</Button>
						<fieldset className="sim-layout-toggle">
							<legend className="sr-only">Lanes view</legend>
							<Button
								aria-pressed={view === 'lanes'}
								size="sm"
								variant={view === 'lanes' ? 'secondary' : 'ghost'}
								onPress={() => setView('lanes')}
							>
								<Waypoints className="h-3.5 w-3.5" /> Lanes
							</Button>
							<Button
								aria-pressed={view === 'agents'}
								size="sm"
								variant={view === 'agents' ? 'secondary' : 'ghost'}
								onPress={() => setView('agents')}
							>
								<Bot className="h-3.5 w-3.5" /> Agents
								{liveAgentCount > 0 ? ` (${liveAgentCount})` : ''}
							</Button>
						</fieldset>
						<Button
							isDisabled={!lanes.isBridgeAvailable}
							size="sm"
							variant="primary"
							aria-expanded={showStart}
							onPress={() => {
								setView('lanes');
								setShowStart((shown) => !shown);
							}}
						>
							<Waypoints className="h-4 w-4" />
							{showStart ? 'Close' : 'Start lane'}
						</Button>
					</>
				}
				description="One worktree on one Simulator, served by one Metro on a leased port. Lanes let several branches, and the agents working on them, run side by side."
				eyebrow="Lanes"
				meta={`${counts.lanes} active`}
				title="Lanes"
			/>
			{!lanes.isBridgeAvailable ? (
				<PanelNotice
					title="Lanes require the secure desktop bridge."
					tone="warning"
				>
					Open this window from the packaged RN Devtools app to manage lanes.
				</PanelNotice>
			) : null}
			{lanes.state.error ? (
				<PanelNotice
					title="Some repositories could not be read."
					tone="warning"
				>
					{lanes.state.error}
				</PanelNotice>
			) : null}
			{lanes.actionStatus.kind === 'error' ? (
				<PanelNotice title="Lane action failed." tone="danger">
					{lanes.actionStatus.message}
				</PanelNotice>
			) : null}
			<div className="sim-metric-grid">
				<SimulatorMetric
					detail={`${counts.ready} Metro ready`}
					icon={<Waypoints className="h-3.5 w-3.5" />}
					label="Lanes"
					tone={counts.lanes > 0 ? 'success' : 'default'}
					value={String(counts.lanes)}
				/>
				<SimulatorMetric
					detail={`${counts.agents} attached to lanes`}
					icon={<Bot className="h-3.5 w-3.5" />}
					label="Live agents"
					tone={liveAgentCount > 0 ? 'info' : 'default'}
					value={String(liveAgentCount)}
				/>
				<SimulatorMetric
					detail={`${lanes.state.repositories.length} repositories`}
					icon={<FolderGit2 className="h-3.5 w-3.5" />}
					label="Worktrees"
					value={String(counts.worktrees)}
				/>
				<SimulatorMetric
					detail={
						hostFree ? `${hostFree.memoryPressure} pressure` : 'host sample'
					}
					icon={<ScrollText className="h-3.5 w-3.5" />}
					label="Host free"
					tone={hostFree?.memoryPressure === 'critical' ? 'warning' : 'default'}
					value={hostFree ? `${Math.round(hostFree.freePercent)}%` : '—'}
				/>
			</div>
			{showStart ? (
				<StartLaneForm
					devices={simulator.state.devices}
					environments={lanes.state.environments}
					isBusy={lanes.pendingOperation === 'lane.start'}
					lanes={lanes.state.lanes}
					slimProfiles={
						slimming.state.helper.status === 'available'
							? slimming.state.profiles
							: []
					}
					slimUnavailableReason={
						slimming.state.helper.status === 'available'
							? (slimming.state.helper.mutationUnavailableReason ??
								(slimming.state.setting.experimentalMutationsEnabled
									? undefined
									: 'Enable experimental mutations in the SimSlim panel first.'))
							: 'The SimSlim helper is not available.'
					}
					worktrees={lanes.state.worktrees}
					onAddRepository={() =>
						void lanes.runOperation({ kind: 'lane.add-repository' })
					}
					onStart={async (input) => {
						const receipt = await lanes.runOperation(
							{ kind: 'lane.start', ...input },
							{
								pendingMessage: input.slimProfileId
									? 'Booting, slimming, and starting Metro…'
									: 'Booting the Simulator and starting Metro…',
								successMessage: 'Lane started.',
							}
						);
						if (receipt?.completed && receipt.lane) {
							setSelectedLaneId(receipt.lane.id);
							setShowStart(false);
						}
					}}
				/>
			) : null}
			{view === 'agents' ? (
				<AgentsView
					devices={simulator.state.devices}
					onSelectSimulator={(udid) => {
						simulator.setSelectedDeviceUdid(udid);
						window.location.hash = 'simulator/fleet';
					}}
				/>
			) : (
				<div className="sim-fleet-layout">
					<div className="sim-list-pane panel-scroll">
						{lanes.state.lanes.length === 0 ? (
							<div className="lane-empty">
								<Waypoints className="h-5 w-5" />
								<strong>No lanes yet</strong>
								<span>
									Start a lane to run a worktree on its own Simulator with its
									own Metro port, or let an agent run{' '}
									<code>rndevtools lane --operation up</code>.
								</span>
							</div>
						) : (
							<ul className="lane-list" aria-label="Lanes">
								{lanes.state.lanes.map((lane) => {
									const device = deviceByUdid.get(
										lane.simulatorUdid.toUpperCase()
									);
									const selected = lane.id === selectedLaneId;
									return (
										<li key={lane.id}>
											<button
												type="button"
												className={`lane-row ${selected ? 'is-selected' : ''}`}
												aria-pressed={selected}
												onClick={() => setSelectedLaneId(lane.id)}
											>
												<VisibleDeviceScreen
													className="lane-row-thumb"
													live={device?.state === 'booted'}
													name={device?.name ?? lane.branch}
													quality="tile"
													size="thumb"
													udid={lane.simulatorUdid}
												/>
												<div className="lane-row-copy">
													<div className="lane-row-main">
														<WorktreeLabel
															path={lane.worktreePath}
															branch={lane.branch}
														/>
														<LaneChip lane={lane} compact />
													</div>
													<div className="lane-row-meta">
														<span className="lane-row-device">
															{device?.name ?? lane.simulatorUdid}
															{device ? ` · ${device.state}` : ''}
														</span>
														{lane.agent ? (
															<AgentBadge agent={lane.agent} />
														) : null}
														<LaneSlimBadge lane={lane} />
													</div>
												</div>
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</div>
					<div className="sim-detail-pane panel-scroll">
						{selectedLane ? (
							<LaneDetail
								key={selectedLane.id}
								device={deviceByUdid.get(
									selectedLane.simulatorUdid.toUpperCase()
								)}
								isBusy={lanes.pendingOperation !== null}
								lane={selectedLane}
								log={log?.laneId === selectedLane.id ? log.text : undefined}
								onCloseLog={() => setLog(null)}
								onLaunch={() => launch(selectedLane)}
								onLog={() => void readLog(selectedLane)}
								onOpenSimulator={() => {
									simulator.setSelectedDeviceUdid(selectedLane.simulatorUdid);
									window.location.hash = 'simulator/fleet';
								}}
								onSlimDecision={(decision) =>
									decideSlim(selectedLane, decision)
								}
								onStop={() => stop(selectedLane)}
							/>
						) : (
							<WorktreesOverview
								lanes={lanes.state.lanes}
								onAddRepository={() =>
									void lanes.runOperation({ kind: 'lane.add-repository' })
								}
								onRemoveRepository={(root) =>
									void lanes.runOperation({
										kind: 'lane.remove-repository',
										repositoryRoot: root,
									})
								}
								repositories={lanes.state.repositories}
								worktrees={lanes.state.worktrees}
							/>
						)}
					</div>
				</div>
			)}
		</section>
	);
}

function StartLaneForm({
	worktrees,
	devices,
	environments,
	lanes,
	slimProfiles,
	slimUnavailableReason,
	isBusy,
	onStart,
	onAddRepository,
}: {
	worktrees: readonly LaneWorktree[];
	devices: readonly SimulatorDevice[];
	environments: readonly LaneEnvironment[];
	lanes: readonly Lane[];
	slimProfiles: readonly SlimmingProfile[];
	/** Why the slim select is disabled, when it is. */
	slimUnavailableReason: string | undefined;
	isBusy: boolean;
	onStart: (input: {
		worktreePath: string;
		simulatorUdid: string;
		environment: string;
		launch: boolean;
		slimProfileId?: string;
	}) => Promise<void>;
	onAddRepository: () => void;
}) {
	const [worktreePath, setWorktreePath] = useState(() =>
		defaultLaneWorktree(worktrees)
	);
	const [udid, setUdid] = useState('');
	const [environmentId, setEnvironmentId] = useState(
		environments[0]?.id ?? 'development'
	);
	const [slimProfileId, setSlimProfileId] = useState('');
	const options = useMemo(
		() => laneDeviceOptions(devices, lanes),
		[devices, lanes]
	);
	const environment = environments.find(
		(candidate) => candidate.id === environmentId
	);
	const worktree = worktrees.find(
		(candidate) => candidate.path === worktreePath
	);

	useEffect(() => {
		if (!worktrees.some((candidate) => candidate.path === worktreePath)) {
			setWorktreePath(defaultLaneWorktree(worktrees));
		}
	}, [worktrees, worktreePath]);
	useEffect(() => {
		if (
			udid &&
			!options.some(
				(option) => option.device.udid === udid && !option.disabledReason
			)
		) {
			setUdid('');
		}
	}, [options, udid]);

	const canStart =
		!isBusy && Boolean(worktreePath) && Boolean(udid) && Boolean(environment);

	return (
		<form
			className="lane-start-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (!canStart) return;
				void onStart({
					worktreePath,
					simulatorUdid: udid,
					environment: environmentId,
					launch: true,
					...(slimProfileId && !slimUnavailableReason ? { slimProfileId } : {}),
				});
			}}
		>
			<div className="lane-start-fields">
				<div className="sim-toolbar-field sim-toolbar-field-grow">
					<span>Worktree</span>
					<NativeSelect fullWidth>
						<NativeSelect.Trigger
							aria-label="Worktree"
							disabled={worktrees.length === 0}
							value={worktreePath}
							onChange={(event) => setWorktreePath(event.currentTarget.value)}
						>
							{worktrees.length === 0 ? (
								<NativeSelect.Option value="">
									No repositories tracked yet
								</NativeSelect.Option>
							) : null}
							{worktrees.map((candidate) => (
								<NativeSelect.Option
									key={candidate.path}
									value={candidate.path}
								>
									{candidate.branch} · {shortPath(candidate.path)}
									{candidate.dirty ? ' · dirty' : ''}
									{candidate.laneId ? ' · has lane' : ''}
								</NativeSelect.Option>
							))}
							<NativeSelect.Indicator>
								<ChevronDown className="h-3 w-3" />
							</NativeSelect.Indicator>
						</NativeSelect.Trigger>
					</NativeSelect>
				</div>
				<div className="sim-toolbar-field sim-toolbar-field-grow">
					<span>Simulator</span>
					<NativeSelect fullWidth>
						<NativeSelect.Trigger
							aria-label="Simulator"
							disabled={options.length === 0}
							value={udid}
							onChange={(event) => setUdid(event.currentTarget.value)}
						>
							<NativeSelect.Option value="">
								Choose a Simulator
							</NativeSelect.Option>
							{options.map(({ device, disabledReason }) => (
								<NativeSelect.Option
									disabled={Boolean(disabledReason)}
									key={device.udid}
									value={device.udid}
								>
									{device.name} · {device.state}
									{disabledReason ? ` · ${disabledReason}` : ''}
								</NativeSelect.Option>
							))}
							<NativeSelect.Indicator>
								<ChevronDown className="h-3 w-3" />
							</NativeSelect.Indicator>
						</NativeSelect.Trigger>
					</NativeSelect>
				</div>
				<div className="sim-toolbar-field">
					<span>Environment</span>
					<NativeSelect fullWidth={false}>
						<NativeSelect.Trigger
							aria-label="Lane environment"
							value={environmentId}
							onChange={(event) => setEnvironmentId(event.currentTarget.value)}
						>
							{environments.map((candidate) => (
								<NativeSelect.Option key={candidate.id} value={candidate.id}>
									{candidate.id}
								</NativeSelect.Option>
							))}
							<NativeSelect.Indicator>
								<ChevronDown className="h-3 w-3" />
							</NativeSelect.Indicator>
						</NativeSelect.Trigger>
					</NativeSelect>
				</div>
				<div className="sim-toolbar-field">
					<span>Slim</span>
					<NativeSelect fullWidth={false}>
						<NativeSelect.Trigger
							aria-label="SimSlim profile"
							disabled={Boolean(slimUnavailableReason)}
							title={slimUnavailableReason}
							value={slimProfileId}
							onChange={(event) => setSlimProfileId(event.currentTarget.value)}
						>
							<NativeSelect.Option value="">No slimming</NativeSelect.Option>
							{slimProfiles.map((profile) => (
								<NativeSelect.Option key={profile.id} value={profile.id}>
									{profile.name}
								</NativeSelect.Option>
							))}
							<NativeSelect.Indicator>
								<ChevronDown className="h-3 w-3" />
							</NativeSelect.Indicator>
						</NativeSelect.Trigger>
					</NativeSelect>
				</div>
				<Button
					isDisabled={!canStart}
					size="sm"
					type="submit"
					variant="primary"
				>
					<Play className="h-3.5 w-3.5" />{' '}
					{isBusy ? 'Starting…' : 'Start Metro'}
				</Button>
				<Button size="sm" variant="ghost" onPress={onAddRepository}>
					<FolderPlus className="h-3.5 w-3.5" /> Track repository
				</Button>
			</div>
			<p className="sim-inline-note lane-start-hint">
				{environment ? (
					<>
						Metro ports{' '}
						<code>
							{environment.portRange[0]}–{environment.portRange[1]}
						</code>
						{worktree?.dirty ? ' · the worktree has uncommitted changes' : ''}
						{' · '}the dev client is opened against the leased port once Metro
						answers, within {LANE_METRO_HEALTH_TIMEOUT_MS / 1_000}s.
					</>
				) : (
					'Choose an environment to see its Metro port range.'
				)}
				<InfoPopover label="Starting a lane">
					A lane boots the Simulator if needed, optionally applies a SimSlim
					profile (you confirm it in a native dialog; the signed helper applies
					it), starts <code>expo start --dev-client --localhost</code> from the
					worktree on the leased port, and deep-links the installed dev client
					to it. The dev client must already be installed on the Simulator;
					lanes never trigger a native build.
				</InfoPopover>
			</p>
		</form>
	);
}

function LaneDetail({
	lane,
	device,
	isBusy,
	log,
	onLaunch,
	onLog,
	onCloseLog,
	onStop,
	onOpenSimulator,
	onSlimDecision,
}: {
	lane: Lane;
	device: SimulatorDevice | undefined;
	isBusy: boolean;
	log: string | undefined;
	onLaunch: () => void;
	onLog: () => void;
	onCloseLog: () => void;
	onStop: () => void;
	onOpenSimulator: () => void;
	onSlimDecision: (decision: 'approve' | 'dismiss') => void;
}) {
	const launchUrl = lane.scheme
		? laneDevClientLaunchUrl(lane.scheme, lane.port)
		: undefined;
	return (
		<div className="sim-target-detail">
			<div className="sim-detail-heading">
				<div>
					<p className="sim-eyebrow">Lane</p>
					<h2>
						<code>{lane.branch}</code>
					</h2>
					<span title={lane.appPath ?? lane.worktreePath}>
						{shortPath(lane.appPath ?? lane.worktreePath)}
					</span>
				</div>
				<LaneChip lane={lane} compact />
			</div>
			<div className="sim-focus-screen">
				<ControllableScreen
					live={device?.state === 'booted'}
					name={device?.name ?? lane.branch}
					udid={lane.simulatorUdid}
				/>
			</div>
			<div className="sim-action-row">
				<Button
					isDisabled={isBusy || lane.metro === 'stopped' || !lane.scheme}
					size="sm"
					variant="primary"
					onPress={onLaunch}
				>
					<Play className="h-3.5 w-3.5" /> Launch app
				</Button>
				<Button
					isDisabled={isBusy}
					size="sm"
					variant="secondary"
					onPress={onLog}
				>
					<ScrollText className="h-3.5 w-3.5" /> Metro log
				</Button>
				<Button size="sm" variant="ghost" onPress={onOpenSimulator}>
					Open in Simulators
				</Button>
				<ConfirmAction
					confirmLabel="Stop lane"
					description={`Metro on port ${lane.port} stops and ${device?.name ?? 'the Simulator'} is released for another worktree. The Simulator keeps running.`}
					isDisabled={isBusy}
					title={`Stop lane ${lane.branch}?`}
					triggerIcon={<Square className="h-3.5 w-3.5" />}
					triggerLabel="Stop"
					onConfirm={onStop}
				/>
			</div>
			{lane.metro === 'stopped' ? (
				<PanelNotice title="Metro is not running." tone="warning">
					The bundler for this lane exited. Read the log, then stop the lane and
					start it again.
				</PanelNotice>
			) : null}
			{lane.slim?.status === 'needs-approval' ? (
				<PanelNotice
					title="Slimming is waiting for your approval."
					tone="warning"
				>
					An agent (or the CLI) asked to apply{' '}
					<code>{lane.slim.profileId}</code> to{' '}
					{device?.name ?? 'this Simulator'}. Only you can approve a Simulator
					mutation; the CLI cannot. Approving shows the SimSlim confirmation and
					relaunches the dev client afterwards.
					<div className="sim-action-row lane-slim-actions">
						<Button
							isDisabled={isBusy}
							size="sm"
							variant="primary"
							onPress={() => onSlimDecision('approve')}
						>
							Approve and slim
						</Button>
						<Button
							isDisabled={isBusy}
							size="sm"
							variant="ghost"
							onPress={() => onSlimDecision('dismiss')}
						>
							Dismiss
						</Button>
					</div>
				</PanelNotice>
			) : null}
			{lane.slim && lane.slim.status !== 'needs-approval' ? (
				<PanelNotice
					title={
						lane.slim.status === 'applied'
							? `Slimmed with ${lane.slim.profileId}.`
							: lane.slim.status === 'applying'
								? `Applying ${lane.slim.profileId}…`
								: lane.slim.status === 'failed'
									? `Slimming with ${lane.slim.profileId} failed.`
									: `Slimming with ${lane.slim.profileId} was skipped.`
					}
					tone={
						lane.slim.status === 'failed'
							? 'danger'
							: lane.slim.status === 'applied'
								? 'info'
								: 'warning'
					}
				>
					{lane.slim.message ?? 'The SimSlim job finished.'}
				</PanelNotice>
			) : null}
			{!lane.scheme ? (
				<PanelNotice title="No URL scheme in app.json." tone="info">
					The worktree declares no <code>expo.scheme</code>, so the dev client
					cannot be deep-linked. Agents can still pass a full URL with{' '}
					<code>lane --operation launch --url</code>.
				</PanelNotice>
			) : null}
			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>Agent</h3>
					</div>
				</div>
				{lane.agent ? (
					<div className="lane-agent-card">
						<AgentBadge agent={lane.agent} showSession />
						<span className="sim-inline-note">
							Last seen {new Date(lane.agent.lastSeenAt).toLocaleTimeString()}
						</span>
					</div>
				) : (
					<p className="sim-section-empty">
						No coding agent has touched this lane. Agents are attributed from{' '}
						<code>CLAUDE_CODE_SESSION_ID</code> or <code>CODEX_THREAD_ID</code>{' '}
						when they use the CLI.
					</p>
				)}
			</section>
			<Disclosure defaultOpen title="Lane details">
				<dl>
					<KeyValue label="Lane id" mono value={lane.id} />
					<KeyValue label="Worktree" mono value={lane.worktreePath} />
					{lane.appPath ? (
						<KeyValue label="App directory" mono value={lane.appPath} />
					) : null}
					<KeyValue label="Branch" mono value={lane.branch} />
					<KeyValue
						label="Simulator"
						value={
							device
								? `${device.name} · ${device.state} · ${device.udid}`
								: lane.simulatorUdid
						}
					/>
					<KeyValue label="Environment" value={lane.environment} />
					{lane.slim ? (
						<KeyValue
							label="Slim request"
							value={`${lane.slim.profileId} · ${lane.slim.status}${lane.slim.jobId ? ` · job ${lane.slim.jobId}` : ''}`}
						/>
					) : null}
					<KeyValue
						label="Metro"
						value={`http://127.0.0.1:${lane.port} · ${lane.metro}${lane.metroPid ? ` · pid ${lane.metroPid}` : ''}`}
					/>
					<KeyValue
						label="Bundle"
						mono
						value={lane.bundleIdentifier ?? 'not declared'}
					/>
					<KeyValue label="Scheme" mono value={lane.scheme ?? 'not declared'} />
					{launchUrl ? (
						<KeyValue label="Launch URL" mono value={launchUrl} />
					) : null}
					<KeyValue
						label="Started"
						value={new Date(lane.startedAt).toLocaleString()}
					/>
					{lane.lastLaunchedAt ? (
						<KeyValue
							label="Last launch"
							value={new Date(lane.lastLaunchedAt).toLocaleString()}
						/>
					) : null}
					<KeyValue label="Log" mono value={lane.logPath} />
				</dl>
			</Disclosure>
			{log !== undefined ? (
				<section className="sim-detail-section lane-log">
					<div className="sim-section-heading">
						<div>
							<h3>Metro log</h3>
						</div>
						<Button
							aria-label="Close log"
							className="sim-icon-button"
							isIconOnly
							size="sm"
							variant="ghost"
							onPress={onCloseLog}
						>
							<X className="h-3.5 w-3.5" />
						</Button>
					</div>
					<pre className="lane-log-output">
						{log || 'The log is empty so far.'}
					</pre>
				</section>
			) : null}
		</div>
	);
}

function WorktreesOverview({
	worktrees,
	repositories,
	lanes,
	onAddRepository,
	onRemoveRepository,
}: {
	worktrees: readonly LaneWorktree[];
	repositories: readonly string[];
	lanes: readonly Lane[];
	onAddRepository: () => void;
	onRemoveRepository: (root: string) => void;
}) {
	const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
	return (
		<div className="sim-target-detail">
			<div className="sim-detail-heading">
				<div>
					<p className="sim-eyebrow">Repositories</p>
					<h2>Worktrees</h2>
					<span>Every checkout of a tracked repository can become a lane.</span>
				</div>
				<Button size="sm" variant="secondary" onPress={onAddRepository}>
					<FolderPlus className="h-3.5 w-3.5" /> Track repository
				</Button>
			</div>
			{repositories.length === 0 ? (
				<p className="sim-section-empty">
					Track a repository to list its worktrees here. Starting a lane from
					the CLI tracks the repository automatically.
				</p>
			) : null}
			{repositories.map((root) => {
				const members = worktrees.filter(
					(worktree) => worktree.repositoryRoot === root
				);
				return (
					<section className="sim-detail-section" key={root}>
						<div className="sim-section-heading">
							<div>
								<h3 title={root}>{shortPath(root)}</h3>
							</div>
							<ConfirmAction
								confirmLabel="Stop tracking"
								description={`${shortPath(root)} and its worktrees stop appearing here. Running lanes are not affected.`}
								title="Stop tracking this repository?"
								tone="warning"
								triggerLabel="Untrack"
								onConfirm={() => onRemoveRepository(root)}
							/>
						</div>
						{members.length === 0 ? (
							<p className="sim-section-empty">No worktrees were discovered.</p>
						) : (
							<ul className="worktree-list">
								{members.map((worktree) => {
									const lane = worktree.laneId
										? laneById.get(worktree.laneId)
										: undefined;
									return (
										<li key={worktree.path}>
											<WorktreeLabel
												path={worktree.path}
												branch={worktree.branch}
											/>
											<span className="worktree-list-meta">
												{worktree.dirty ? (
													<StatusPill tone="warning">dirty</StatusPill>
												) : null}
												{lane ? <LaneChip lane={lane} compact /> : null}
											</span>
										</li>
									);
								})}
							</ul>
						)}
					</section>
				);
			})}
			<p className="sim-inline-note">
				Keep worktrees as siblings of the main checkout, never nested inside it;
				Metro's file watcher would otherwise see both trees.
			</p>
		</div>
	);
}
