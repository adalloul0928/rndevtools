import { AlertDialog } from '@heroui/react/alert-dialog';
import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { Switch } from '@heroui/react/switch';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	Activity,
	BadgeCheck,
	Ban,
	Check,
	ChevronDown,
	CircleAlert,
	ClipboardCheck,
	Cpu,
	Gauge,
	HardDriveDownload,
	HeartPulse,
	History,
	ListRestart,
	RefreshCw,
	RotateCcw,
	ShieldAlert,
	Sparkles,
	Square,
	SquareCheckBig,
	Undo2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
	DenseVirtualList,
	formatBytes,
	SimulatorMetric,
	SimulatorPanelHeader,
} from '@/components/simulator-ui';
import {
	ConfirmAction,
	EmptyPanel,
	KeyValue,
	PanelNotice,
	StatusPill,
	Toolbar,
} from '@/components/ui';
import {
	allSelectedCheckpointsAvailable,
	managedOverrideUdids,
	restoreAndDisableInput,
	type UnknownTupleAcknowledgement,
	unknownCompatibilityBinding,
} from '@/simulator/slimming-ui-model';
import { useSimulatorRuntime } from '@/state/simulator-runtime';
import { type SlimmingActionInput, useSlimmingRuntime } from '@/state/slimming-runtime';
import {
	SLIMMING_CONFIRMATIONS,
	SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT,
	type SlimmingCondition,
	type SlimmingDoctorResult,
	type SlimmingJob,
	type SlimmingPlan,
	type SlimmingProfile,
	type SlimmingSimulator,
	type SlimmingSimulatorStatus,
} from '../../../shared/slimming-protocol';

const MAX_BATCH_SIZE = 20;
const DEFAULT_DOCTOR_CAPABILITIES = [
	'push-notifications',
	'universal-links',
	'icloud-sync',
] as const;

export function SlimmingPanel() {
	const simulatorRuntime = useSimulatorRuntime();
	const {
		state,
		isBridgeAvailable,
		isLoading,
		runtimeError,
		refresh,
		setEnabled,
		acknowledgeCompatibility,
		runAction,
		cancelJob,
	} = useSlimmingRuntime();
	const [selectedProfileId, setSelectedProfileId] = useState('');
	const [selectedUdids, setSelectedUdids] = useState<string[]>([]);
	const [disableDialogOpen, setDisableDialogOpen] = useState(false);

	useEffect(() => {
		if (state.profiles.some((profile) => profile.id === selectedProfileId)) return;
		setSelectedProfileId(state.profiles[0]?.id ?? '');
	}, [selectedProfileId, state.profiles]);

	useEffect(() => {
		const available = new Set(state.simulators.map((simulator) => simulator.udid));
		setSelectedUdids((current) => {
			const retained = current.filter((udid) => available.has(udid));
			if (retained.length > 0 || state.simulators.length === 0) return retained;
			const initial =
				state.simulators.find((simulator) => simulator.state === 'booted') ??
				state.simulators[0];
			return initial ? [initial.udid] : [];
		});
	}, [state.simulators]);

	const selectedProfile =
		state.profiles.find((profile) => profile.id === selectedProfileId) ?? null;
	const selectedSimulators = state.simulators.filter((simulator) =>
		selectedUdids.includes(simulator.udid)
	);
	const selectedStatuses = selectedUdids
		.map((udid) => state.statusBySimulator[udid])
		.filter((status): status is SlimmingSimulatorStatus => Boolean(status));
	const selectedPlans = selectedUdids
		.map((udid) => state.previewBySimulator[udid])
		.filter((plan): plan is SlimmingPlan => Boolean(plan));
	const selectedDoctors = selectedUdids
		.map((udid) => state.doctorBySimulator[udid])
		.filter((result): result is SlimmingDoctorResult => Boolean(result));
	const currentMetricSamples = selectedUdids
		.map((udid) => simulatorRuntime.state.metrics.byDevice[udid])
		.filter((metrics) => metrics !== undefined);
	const hasCompleteCurrentMetrics =
		selectedUdids.length > 0 && currentMetricSamples.length === selectedUdids.length;
	const currentMemoryBytes = hasCompleteCurrentMetrics
		? currentMetricSamples.reduce((sum, metrics) => sum + metrics.memoryBytes, 0)
		: null;
	const currentProcessCount = hasCompleteCurrentMetrics
		? currentMetricSamples.reduce((sum, metrics) => sum + metrics.processCount, 0)
		: null;
	const categoryById = useMemo(
		() => new Map(state.categories.map((category) => [category.id, category])),
		[state.categories]
	);
	const profileCategories = selectedProfile
		? selectedProfile.categoryIds
				.map((id) => categoryById.get(id))
				.filter((category) => category !== undefined)
		: [];
	const estimatedCategoryCount = profileCategories.filter(
		(category) => category.approxMemoryMb > 0
	).length;
	const changingServices = selectedPlans.reduce(
		(total, plan) =>
			total + plan.toDisableServiceIds.length + plan.toEnableServiceIds.length,
		0
	);
	const selectedUnknownTupleBinding = unknownCompatibilityBinding(selectedStatuses);
	const plansReady =
		selectedUdids.length > 0 &&
		selectedPlans.length === selectedUdids.length &&
		selectedPlans.every(
			(plan) => plan.profileId === selectedProfileId && plan.executable
		);
	const mutationAvailable =
		isBridgeAvailable &&
		state.helper.status === 'available' &&
		state.setting.experimentalMutationsEnabled;
	const canApply =
		mutationAvailable &&
		Boolean(selectedProfile) &&
		plansReady &&
		!selectedUnknownTupleBinding;
	const managedUdids = managedOverrideUdids(state.statusBySimulator);
	const managedStatuses = managedUdids
		.map((udid) => state.statusBySimulator[udid])
		.filter((status): status is SlimmingSimulatorStatus => Boolean(status));
	const activeJobs = state.jobs.filter((job) =>
		['queued', 'preflight', 'running', 'verifying', 'rolling-back'].includes(job.status)
	);
	const needsAttention = selectedStatuses.filter(
		(status) => status.condition === 'needs-attention'
	).length;

	const submit = (action: SlimmingActionInput, successMessage: string) =>
		void runAction(action, { successMessage });
	const toggleTarget = (simulator: SlimmingSimulator) => {
		setSelectedUdids((current) => {
			if (current.includes(simulator.udid)) {
				return current.filter((udid) => udid !== simulator.udid);
			}
			if (current.length >= MAX_BATCH_SIZE) return current;
			return [...current, simulator.udid];
		});
	};

	return (
		<section className="panel-root">
			<SlimmingDisableDialog
				isOpen={disableDialogOpen}
				managedStatuses={managedStatuses}
				managedUdids={managedUdids}
				onLeaveOverrides={() =>
					void setEnabled({
						enabled: false,
						disposition: 'leave-overrides-in-place',
					})
				}
				onOpenChange={setDisableDialogOpen}
				onRestore={async (typedAcknowledgement) => {
					const binding = unknownCompatibilityBinding(managedStatuses);
					const validated = restoreAndDisableInput(
						managedUdids,
						binding,
						typedAcknowledgement
					);
					if (!validated) return;
					if (binding) {
						const acknowledgement = await acknowledgeCompatibility({
							simulatorUdids: managedUdids,
							acknowledgement: typedAcknowledgement,
						});
						if (!acknowledgement.accepted) return;
					}
					const request = restoreAndDisableInput(managedUdids, null, '');
					if (request) await setEnabled(request);
				}}
			/>
			<SimulatorPanelHeader
				actions={
					<div className="sim-slimming-header-actions">
						<Switch
							aria-label="Enable experimental Simulator mutations"
							isDisabled={!isBridgeAvailable || state.helper.status !== 'available'}
							isSelected={state.setting.experimentalMutationsEnabled}
							size="sm"
							onChange={(selected) => {
								if (selected) {
									void setEnabled({ enabled: true });
									return;
								}
								if (managedUdids.length === 0) {
									void setEnabled({
										enabled: false,
										disposition: 'leave-overrides-in-place',
									});
									return;
								}
								setDisableDialogOpen(true);
							}}
						>
							<Switch.Content>
								<span className="sim-slimming-switch-label">
									Experimental mutations
								</span>
							</Switch.Content>
							<Switch.Control>
								<Switch.Thumb />
							</Switch.Control>
						</Switch>
						<Button
							aria-label="Refresh Simulator Slimming state"
							isDisabled={!isBridgeAvailable || isLoading}
							isIconOnly
							size="sm"
							variant="secondary"
							onPress={() => void refresh()}
						>
							<RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
						</Button>
					</div>
				}
				description="Preview, apply, verify, and safely roll back versioned Simulator service profiles through the app-pinned SimSlim core. Mutations are experimental, local, checkpointed, and processed sequentially."
				eyebrow="Experimental resource profiles"
				meta={<HelperStatus status={state.helper.status} />}
				title="Simulator Slimming"
			/>
			{runtimeError ? (
				<PanelNotice title="Slimming helper unavailable." tone="danger">
					{runtimeError}
				</PanelNotice>
			) : null}
			{state.helper.error ? (
				<PanelNotice title="Native helper reported an error." tone="danger">
					{state.helper.error}
				</PanelNotice>
			) : null}
			{state.helper.status === 'available' ? (
				<PanelNotice title="Pinned SimSlim core is embedded." tone="info">
					The signed PUMPD helper runs the audited, app-bundled library; it does not
					require a separate SimSlim installation or download code at runtime.
					{state.helper.catalogVersion
						? ` Catalog ${state.helper.catalogVersion}.`
						: ''}
				</PanelNotice>
			) : null}
			{state.setting.warning ? (
				<PanelNotice title="Managed overrides remain in place." tone="warning">
					{state.setting.warning}
				</PanelNotice>
			) : null}
			{!state.setting.experimentalMutationsEnabled ? (
				<PanelNotice title="Read-only mode is active." tone="info">
					Preview, verify, and doctor checks remain available. Apply, undo, and restore
					stay blocked until you explicitly enable experimental mutations.
				</PanelNotice>
			) : null}
			<Toolbar>
				<div className="sim-toolbar-field">
					<span>Profile</span>
					<NativeSelect className="sim-slimming-profile-select" fullWidth={false}>
						<NativeSelect.Trigger
							aria-label="Slimming profile"
							disabled={state.profiles.length === 0}
							value={selectedProfileId}
							onChange={(event) => {
								setSelectedProfileId(event.currentTarget.value);
							}}
						>
							{state.profiles.length === 0 ? (
								<NativeSelect.Option value="">
									No profiles available
								</NativeSelect.Option>
							) : null}
							{state.profiles.map((profile) => (
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
				<span className="sim-toolbar-meta">
					{selectedUdids.length}/{MAX_BATCH_SIZE} selected · sequential execution
				</span>
				<span className="sim-toolbar-spacer" />
				<Button
					isDisabled={
						!state.helper.readOnlyAvailable ||
						selectedUdids.length === 0 ||
						!selectedProfile
					}
					size="sm"
					variant="secondary"
					onPress={() =>
						submit(
							{
								kind: 'profile.preview',
								profileId: selectedProfileId,
								simulatorUdids: selectedUdids,
							},
							'Profile preview completed.'
						)
					}
				>
					<ClipboardCheck className="h-3.5 w-3.5" /> Preview
				</Button>
				<Button
					isDisabled={
						!state.helper.readOnlyAvailable ||
						selectedUdids.length === 0 ||
						!selectedProfile
					}
					size="sm"
					variant="ghost"
					onPress={() =>
						submit(
							{
								kind: 'profile.verify',
								profileId: selectedProfileId,
								simulatorUdids: selectedUdids,
							},
							'Profile verification completed.'
						)
					}
				>
					<BadgeCheck className="h-3.5 w-3.5" /> Verify
				</Button>
			</Toolbar>
			<div className="sim-metric-grid">
				<SimulatorMetric
					detail="selected targets"
					icon={<Gauge className="h-3.5 w-3.5" />}
					label="Batch"
					value={String(selectedUdids.length)}
				/>
				<SimulatorMetric
					detail="non-additive category medians"
					icon={<Cpu className="h-3.5 w-3.5" />}
					label="Memory evidence"
					tone={estimatedCategoryCount > 0 ? 'info' : 'default'}
					value={
						estimatedCategoryCount > 0
							? `${estimatedCategoryCount} categor${estimatedCategoryCount === 1 ? 'y' : 'ies'}`
							: '—'
					}
				/>
				<SimulatorMetric
					detail="planned changes"
					icon={<HardDriveDownload className="h-3.5 w-3.5" />}
					label="Services"
					value={plansReady ? String(changingServices) : '—'}
				/>
				<SimulatorMetric
					detail="selected targets"
					icon={<ShieldAlert className="h-3.5 w-3.5" />}
					label="Attention"
					tone={needsAttention > 0 ? 'warning' : 'default'}
					value={String(needsAttention)}
				/>
			</div>
			{state.simulators.length === 0 ? (
				<div className="sim-slimming-empty panel-scroll min-h-0 flex-1">
					<EmptyPanel
						compact
						description="Install an iOS runtime, create a Simulator, then refresh the signed helper. Slimming never requires a connected PUMPD mobile session."
						icon={<Activity className="h-5 w-5" />}
						title="No Simulator slimming targets"
					/>
				</div>
			) : (
				<div className="sim-slimming-layout">
					<section className="sim-surface sim-slimming-targets">
						<header className="sim-surface-header">
							<div>
								<p className="sim-eyebrow">Fleet selection</p>
								<h2>Simulator targets</h2>
							</div>
							<Button
								size="sm"
								variant="ghost"
								onPress={() => {
									setSelectedUdids(
										selectedUdids.length === state.simulators.length
											? []
											: state.simulators
													.slice(0, MAX_BATCH_SIZE)
													.map((simulator) => simulator.udid)
									);
								}}
							>
								{selectedUdids.length === state.simulators.length
									? 'Clear'
									: 'Select 20'}
							</Button>
						</header>
						<DenseVirtualList
							ariaLabel="Simulator slimming targets"
							className="sim-slimming-target-list"
							items={state.simulators}
							getId={(simulator) => simulator.udid}
							rowHeight={62}
							textValue={(simulator) => simulator.name}
							onSelect={toggleTarget}
							renderItem={(simulator) => {
								const status = state.statusBySimulator[simulator.udid];
								const selected = selectedUdids.includes(simulator.udid);
								return (
									<>
										<span
											className={`sim-selection-box ${selected ? 'is-selected' : ''}`}
										>
											{selected ? (
												<SquareCheckBig className="h-3.5 w-3.5" />
											) : (
												<Square className="h-3.5 w-3.5" />
											)}
										</span>
										<div className="sim-list-copy">
											<strong>{simulator.name}</strong>
											<span>{simulator.runtimeIdentifier}</span>
										</div>
										<ConditionPill condition={status?.condition} />
									</>
								);
							}}
						/>
					</section>
					<section className="sim-surface panel-scroll">
						<ProfileWorkspace
							activeJobs={activeJobs}
							canApply={canApply}
							categories={profileCategories}
							cancelJob={(jobId) => void cancelJob(jobId)}
							currentMemoryBytes={currentMemoryBytes}
							currentProcessCount={currentProcessCount}
							doctors={selectedDoctors}
							mutationAvailable={mutationAvailable}
							onRun={submit}
							plans={selectedPlans}
							profile={selectedProfile}
							selectedSimulators={selectedSimulators}
							selectedStatuses={selectedStatuses}
							selectedUdids={selectedUdids}
							state={state}
							onAcknowledgeUnknownTuple={async (acknowledgement) => {
								if (acknowledgement.binding !== selectedUnknownTupleBinding) return;
								await acknowledgeCompatibility({
									simulatorUdids: selectedUdids,
									acknowledgement: acknowledgement.value,
								});
							}}
							unknownTupleBinding={selectedUnknownTupleBinding}
						/>
					</section>
				</div>
			)}
		</section>
	);
}

function ProfileWorkspace({
	profile,
	categories,
	selectedUdids,
	selectedSimulators,
	selectedStatuses,
	plans,
	doctors: _doctors,
	activeJobs: _activeJobs,
	currentMemoryBytes,
	currentProcessCount,
	mutationAvailable,
	canApply,
	unknownTupleBinding,
	onAcknowledgeUnknownTuple,
	state,
	onRun,
	cancelJob,
}: {
	profile: SlimmingProfile | null;
	categories: Array<{
		id: string;
		name: string;
		description: string;
		downside: string;
	}>;
	selectedUdids: string[];
	selectedSimulators: SlimmingSimulator[];
	selectedStatuses: SlimmingSimulatorStatus[];
	plans: SlimmingPlan[];
	doctors: SlimmingDoctorResult[];
	activeJobs: SlimmingJob[];
	currentMemoryBytes: number | null;
	currentProcessCount: number | null;
	mutationAvailable: boolean;
	canApply: boolean;
	unknownTupleBinding: string | null;
	onAcknowledgeUnknownTuple: (
		acknowledgement: UnknownTupleAcknowledgement
	) => void | Promise<void>;
	state: ReturnType<typeof useSlimmingRuntime>['state'];
	onRun: (action: SlimmingActionInput, successMessage: string) => void;
	cancelJob: (jobId: string) => void;
}) {
	if (!profile) {
		return (
			<EmptyPanel
				description="The signed helper did not publish a profile catalog. Refresh after helper verification completes."
				icon={<Ban className="h-5 w-5" />}
				title="No slimming profiles available"
			/>
		);
	}
	const hasUnknownTuple = Boolean(unknownTupleBinding);
	const unknownTupleReady = !hasUnknownTuple;
	const canUndo =
		mutationAvailable &&
		allSelectedCheckpointsAvailable(selectedUdids, state.statusBySimulator) &&
		unknownTupleReady;

	return (
		<div className="sim-slimming-workspace">
			<header className="sim-report-heading">
				<div>
					<p className="sim-eyebrow">Selected profile</p>
					<h2>{profile.name}</h2>
					<span>{profile.description}</span>
				</div>
				<StatusPill tone={profile.experimental ? 'warning' : 'success'}>
					{profile.experimental ? 'Experimental' : 'Verified'}
				</StatusPill>
			</header>

			<section className="sim-slimming-action-card">
				<div className="sim-slimming-action-copy">
					<strong>{selectedUdids.length} Simulator targets</strong>
					<span>
						{plans.length === selectedUdids.length && selectedUdids.length > 0
							? `${plans.reduce((sum, plan) => sum + plan.toDisableServiceIds.length, 0)} disable and ${plans.reduce((sum, plan) => sum + plan.toEnableServiceIds.length, 0)} restore operations previewed`
							: 'Preview this exact profile and target set before applying.'}
					</span>
				</div>
				<div className="sim-action-row sim-slimming-action-buttons">
					<ConfirmAction
						confirmLabel="Apply profile"
						description={`Create a checkpoint, then apply ${profile.name} sequentially to ${selectedUdids.length} selected Simulator${selectedUdids.length === 1 ? '' : 's'}. The native backend will ask for final confirmation.`}
						isDisabled={!canApply}
						title={`Apply ${profile.name}?`}
						triggerIcon={<Sparkles className="h-3.5 w-3.5" />}
						triggerLabel="Apply"
						triggerVariant="primary"
						tone="warning"
						onConfirm={() =>
							onRun(
								{
									kind: 'profile.apply',
									profileId: profile.id,
									simulatorUdids: selectedUdids,
									confirmation: SLIMMING_CONFIRMATIONS.apply,
								},
								`${profile.name} was queued for ${selectedUdids.length} Simulator targets.`
							)
						}
					/>
					<ConfirmAction
						confirmLabel="Undo last mutation"
						description={`Roll back the latest recovery checkpoint for all ${selectedUdids.length} selected Simulator targets.`}
						isDisabled={!canUndo}
						title="Undo the last managed mutation?"
						triggerIcon={<Undo2 className="h-3.5 w-3.5" />}
						triggerLabel="Undo"
						triggerVariant="secondary"
						tone="warning"
						onConfirm={() =>
							onRun(
								{
									kind: 'profile.undo',
									simulatorUdids: selectedUdids,
									confirmation: SLIMMING_CONFIRMATIONS.undo,
								},
								'Checkpoint rollback queued.'
							)
						}
					/>
					<ConfirmAction
						confirmLabel="Restore all"
						description={`Restore every service managed by PUMPD on ${selectedUdids.length} selected targets. Unmanaged host services remain untouched.`}
						isDisabled={
							!mutationAvailable || selectedUdids.length === 0 || !unknownTupleReady
						}
						title="Restore all managed services?"
						triggerIcon={<ListRestart className="h-3.5 w-3.5" />}
						triggerLabel="Restore"
						triggerVariant="ghost"
						onConfirm={() =>
							onRun(
								{
									kind: 'profile.restore',
									simulatorUdids: selectedUdids,
									confirmation: SLIMMING_CONFIRMATIONS.restore,
								},
								'Managed-service restore queued.'
							)
						}
					/>
					<Button
						isDisabled={!state.helper.readOnlyAvailable || selectedUdids.length === 0}
						size="sm"
						variant="ghost"
						onPress={() =>
							onRun(
								{
									kind: 'doctor.run',
									simulatorUdids: selectedUdids,
									requiredCapabilities: [...DEFAULT_DOCTOR_CAPABILITIES],
								},
								'Capability doctor completed.'
							)
						}
					>
						<HeartPulse className="h-3.5 w-3.5" /> Doctor
					</Button>
				</div>
				{!mutationAvailable ? (
					<p className="sim-inline-note is-warning">
						Enable experimental mutations and verify the signed helper before changing a
						Simulator.
					</p>
				) : null}
				{hasUnknownTuple && unknownTupleBinding ? (
					<UnknownTupleAcknowledgementDialog
						binding={unknownTupleBinding}
						onAcknowledge={onAcknowledgeUnknownTuple}
						statuses={selectedStatuses}
					/>
				) : null}
			</section>

			<section className="sim-slimming-grid">
				<div className="sim-detail-section">
					<div className="sim-section-heading">
						<div>
							<h3>Profile categories</h3>
							<p>Versioned allowlist and explicit tradeoffs</p>
						</div>
						<span>{categories.length}</span>
					</div>
					<div className="sim-profile-categories">
						{categories.map((category) => (
							<div key={category.id}>
								<Check className="h-3.5 w-3.5" />
								<span>
									<strong>{category.name}</strong>
									<small>{category.description}</small>
									<em>{category.downside}</em>
								</span>
							</div>
						))}
					</div>
				</div>
				<div className="sim-detail-section">
					<div className="sim-section-heading">
						<div>
							<h3>Before / after evidence</h3>
							<p>Measured host and Simulator process footprint</p>
						</div>
						<Cpu className="h-3.5 w-3.5" />
					</div>
					<div className="sim-evidence-grid">
						<div>
							<span>Current RAM</span>
							<strong>
								{currentMemoryBytes === null ? '—' : formatBytes(currentMemoryBytes)}
							</strong>
						</div>
						<div>
							<span>After RAM</span>
							<strong>—</strong>
						</div>
						<div>
							<span>Current processes</span>
							<strong>{currentProcessCount ?? '—'}</strong>
						</div>
						<div>
							<span>After processes</span>
							<strong>—</strong>
						</div>
					</div>
					<p className="sim-inline-note">
						Current readings come from the strict Fleet metrics projection. Historical
						before/after samples are not captured in this milestone, so profile
						estimates are never presented as measured savings.
					</p>
				</div>
			</section>

			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>Selected target status</h3>
						<p>Drift, compatibility, checkpoints, and doctor results</p>
					</div>
					<span>{selectedSimulators.length}</span>
				</div>
				<div className="sim-target-status-table">
					{selectedSimulators.map((simulator) => {
						const status = state.statusBySimulator[simulator.udid];
						const plan = state.previewBySimulator[simulator.udid];
						const doctor = state.doctorBySimulator[simulator.udid];
						const checkpoint = state.checkpointBySimulator[simulator.udid];
						return (
							<details key={simulator.udid}>
								<summary>
									<span>
										<strong>{simulator.name}</strong>
										<code>{simulator.udid}</code>
									</span>
									<ConditionPill condition={status?.condition} />
								</summary>
								<dl>
									<KeyValue
										label="Compatibility"
										value={status?.compatibility?.status ?? 'Not checked'}
									/>
									<KeyValue
										label="Managed services"
										value={
											status
												? `${status.managedDisabledCount}/${status.managedServiceCount} disabled`
												: 'Not checked'
										}
									/>
									<KeyValue
										label="Preview"
										value={
											plan
												? `${plan.toDisableServiceIds.length} disable · ${plan.toEnableServiceIds.length} restore${plan.requiresReboot ? ' · reboot' : ''}`
												: 'Not previewed'
										}
									/>
									<KeyValue
										label="Checkpoint"
										value={
											checkpoint
												? new Date(checkpoint.createdAt).toLocaleString()
												: 'None'
										}
									/>
									<KeyValue
										label="Doctor"
										value={
											doctor
												? doctor.healthy
													? 'Healthy'
													: `${doctor.capabilities.filter((capability) => !capability.available).length} capabilities blocked`
												: 'Not run'
										}
									/>
								</dl>
							</details>
						);
					})}
				</div>
			</section>

			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>Sequential jobs</h3>
						<p>One target mutates at a time; verification follows each target</p>
					</div>
					<History className="h-3.5 w-3.5" />
				</div>
				{state.jobs.length === 0 ? (
					<p className="sim-section-empty">No Slimming operations have run.</p>
				) : (
					<div className="sim-slimming-jobs">
						{state.jobs.slice(0, 8).map((job) => (
							<JobRow job={job} key={job.id} onCancel={() => cancelJob(job.id)} />
						))}
					</div>
				)}
			</section>
		</div>
	);
}

function UnknownTupleAcknowledgementDialog({
	binding,
	statuses,
	onAcknowledge,
}: {
	binding: string;
	statuses: SlimmingSimulatorStatus[];
	onAcknowledge: (acknowledgement: UnknownTupleAcknowledgement) => void | Promise<void>;
}) {
	const [typedValue, setTypedValue] = useState('');
	const unknownCompatibilities = statuses.flatMap((status) => {
		const compatibility = status.compatibility;
		return compatibility?.status === 'unknown' &&
			compatibility.acknowledgementRequired &&
			!compatibility.acknowledged
			? [{ simulatorUdid: status.simulatorUdid, compatibility }]
			: [];
	});
	const exact = typedValue === SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT;
	return (
		<AlertDialog onOpenChange={(open) => (open ? undefined : setTypedValue(''))}>
			<AlertDialog.Trigger className="sim-unknown-ack">
				<Square className="h-4 w-4" />
				<span>
					<strong>Type to acknowledge the current compatibility tuple</strong>
					<small>
						Apply, undo, and restore remain blocked until the exact acknowledgement is
						entered for this tuple set.
					</small>
				</span>
			</AlertDialog.Trigger>
			<AlertDialog.Backdrop className="bg-black/70 backdrop-blur-sm">
				<AlertDialog.Container
					className="border border-white/12 bg-[#0b0b0b] shadow-2xl"
					size="lg"
				>
					<AlertDialog.Dialog>
						<AlertDialog.Header>
							<AlertDialog.Icon status="warning">
								<ShieldAlert className="h-5 w-5" />
							</AlertDialog.Icon>
							<AlertDialog.Heading>
								Acknowledge unknown compatibility
							</AlertDialog.Heading>
						</AlertDialog.Header>
						<AlertDialog.Body>
							<div className="sim-ack-dialog-body">
								<p>
									These exact macOS, Xcode, runtime, architecture, and catalog tuples
									have not been verified. This acknowledgement is held only for the
									currently displayed tuple set.
								</p>
								<div className="sim-tuple-list">
									{unknownCompatibilities.map(({ simulatorUdid, compatibility }) => (
										<div key={`${simulatorUdid}-${compatibility.key}`}>
											<code>{simulatorUdid}</code>
											<span>
												macOS {compatibility.tuple.macOSBuild} · Xcode{' '}
												{compatibility.tuple.xcodeBuild} ·{' '}
												{compatibility.tuple.runtimeIdentifier} ·{' '}
												{compatibility.tuple.hostArchitecture} · catalog{' '}
												{compatibility.tuple.catalogVersion}
											</span>
										</div>
									))}
								</div>
								<div className="sim-ack-input">
									<span>
										Type <code>{SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT}</code> exactly
									</span>
									<Input
										aria-label="Unknown compatibility acknowledgement"
										autoComplete="off"
										value={typedValue}
										onChange={(event) => setTypedValue(event.currentTarget.value)}
									/>
								</div>
							</div>
						</AlertDialog.Body>
						<AlertDialog.Footer>
							<Button size="sm" slot="close" variant="ghost">
								Cancel
							</Button>
							<Button
								isDisabled={!exact}
								size="sm"
								slot="close"
								variant="primary"
								onPress={() => onAcknowledge({ binding, value: typedValue })}
							>
								Acknowledge exact tuple
							</Button>
						</AlertDialog.Footer>
					</AlertDialog.Dialog>
				</AlertDialog.Container>
			</AlertDialog.Backdrop>
		</AlertDialog>
	);
}

function SlimmingDisableDialog({
	isOpen,
	managedStatuses,
	managedUdids,
	onOpenChange,
	onRestore,
	onLeaveOverrides,
}: {
	isOpen: boolean;
	managedStatuses: SlimmingSimulatorStatus[];
	managedUdids: string[];
	onOpenChange: (open: boolean) => void;
	onRestore: (typedAcknowledgement: string) => void;
	onLeaveOverrides: () => void;
}) {
	const [typedAcknowledgement, setTypedAcknowledgement] = useState('');
	const unknownBinding = unknownCompatibilityBinding(managedStatuses);
	const restoreInput = restoreAndDisableInput(
		managedUdids,
		unknownBinding,
		typedAcknowledgement
	);
	return (
		<AlertDialog
			isOpen={isOpen}
			onOpenChange={(open) => {
				onOpenChange(open);
				if (!open) setTypedAcknowledgement('');
			}}
		>
			<AlertDialog.Backdrop className="bg-black/70 backdrop-blur-sm">
				<AlertDialog.Container
					className="border border-white/12 bg-[#0b0b0b] shadow-2xl"
					size="lg"
				>
					<AlertDialog.Dialog>
						<AlertDialog.Header>
							<AlertDialog.Icon status="warning">
								<ListRestart className="h-5 w-5" />
							</AlertDialog.Icon>
							<AlertDialog.Heading>
								Managed services are still changed
							</AlertDialog.Heading>
						</AlertDialog.Header>
						<AlertDialog.Body>
							<div className="sim-disable-dialog-body">
								<p>
									Choose how to handle {managedUdids.length} Simulator
									{managedUdids.length === 1 ? '' : 's'} before experimental mutations
									are disabled.
								</p>
								<div className="sim-managed-targets">
									{managedUdids.map((udid) => (
										<code key={udid}>{udid}</code>
									))}
								</div>
								<div className="sim-disable-choice is-recommended">
									<strong>Recommended: restore, verify, then disable</strong>
									<span>
										The helper restores every listed target sequentially, verifies the
										managed services, and disables mutations only after success.
									</span>
								</div>
								<div className="sim-disable-choice is-risky">
									<strong>Leave overrides in place and disable</strong>
									<span>
										No services are restored. Fleet remains in read-only mode with a
										persistent warning and restoration guidance.
									</span>
								</div>
								{managedUdids.length > MAX_BATCH_SIZE ? (
									<p className="sim-field-error" role="alert">
										Restore-and-disable supports at most {MAX_BATCH_SIZE} managed
										targets. Restore smaller batches from this workspace first.
									</p>
								) : null}
								{unknownBinding ? (
									<div className="sim-ack-input">
										<span>
											Unknown compatibility is present. Type{' '}
											<code>{SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT}</code> exactly to
											restore and verify.
										</span>
										<Input
											aria-label="Restore unknown compatibility acknowledgement"
											autoComplete="off"
											value={typedAcknowledgement}
											onChange={(event) =>
												setTypedAcknowledgement(event.currentTarget.value)
											}
										/>
									</div>
								) : null}
							</div>
						</AlertDialog.Body>
						<AlertDialog.Footer>
							<Button size="sm" slot="close" variant="ghost">
								Cancel
							</Button>
							<Button
								className="bg-red-950 text-red-200 hover:bg-red-900"
								size="sm"
								slot="close"
								variant="ghost"
								onPress={onLeaveOverrides}
							>
								Leave overrides &amp; disable
							</Button>
							<Button
								isDisabled={!restoreInput}
								size="sm"
								slot="close"
								variant="primary"
								onPress={() => onRestore(typedAcknowledgement)}
							>
								Restore, verify &amp; disable
							</Button>
						</AlertDialog.Footer>
					</AlertDialog.Dialog>
				</AlertDialog.Container>
			</AlertDialog.Backdrop>
		</AlertDialog>
	);
}

function HelperStatus({
	status,
}: {
	status: 'checking' | 'available' | 'unavailable' | 'untrusted';
}) {
	return (
		<span className={`sim-helper-status is-${status}`}>
			{status === 'available' ? (
				<BadgeCheck className="h-3 w-3" />
			) : (
				<CircleAlert className="h-3 w-3" />
			)}
			{status === 'available' ? 'Embedded helper ready' : status}
		</span>
	);
}

function ConditionPill({ condition }: { condition: SlimmingCondition | undefined }) {
	const tone =
		condition === 'managed-clean' || condition === 'profile-match'
			? 'success'
			: condition === 'drifted' || condition === 'partial'
				? 'warning'
				: condition === 'needs-attention'
					? 'danger'
					: 'default';
	return <StatusPill tone={tone}>{condition ?? 'not checked'}</StatusPill>;
}

function JobRow({ job, onCancel }: { job: SlimmingJob; onCancel: () => void }) {
	const running = [
		'queued',
		'preflight',
		'running',
		'verifying',
		'rolling-back',
	].includes(job.status);
	const percent = Math.min(100, Math.max(0, (job.currentIndex / job.total) * 100));
	return (
		<div className="sim-slimming-job">
			<header>
				<span>
					<strong>{job.kind}</strong>
					<code>{job.phase}</code>
				</span>
				<StatusPill
					tone={
						job.status === 'complete'
							? 'success'
							: job.status === 'failed' || job.status === 'needs-attention'
								? 'danger'
								: running
									? 'info'
									: 'default'
					}
				>
					{job.status}
				</StatusPill>
			</header>
			<p>{job.message}</p>
			<div className="sim-job-progress">
				<span style={{ width: `${percent}%` }} />
			</div>
			<footer>
				<span>
					{job.currentIndex}/{job.total} targets
				</span>
				{running ? (
					<Button size="sm" variant="ghost" onPress={onCancel}>
						<RotateCcw className="h-3 w-3" /> Cancel
					</Button>
				) : null}
			</footer>
		</div>
	);
}
