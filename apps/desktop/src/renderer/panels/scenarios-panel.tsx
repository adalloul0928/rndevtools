import { TextArea } from '@heroui/react/textarea';
import {
	CheckCircle2,
	FileJson2,
	History,
	Play,
	RotateCcw,
	ShieldAlert,
	Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConfirmAction, EmptyPanel, PanelHeader, StatusPill } from '@/components/ui';
import { formatRelativeTime } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import type { ScenarioDefinitionSummary } from '../../shared/protocol';

type VariableDrafts = Readonly<Record<string, string>>;

function initialVariables(scenario: ScenarioDefinitionSummary | null): VariableDrafts {
	if (!scenario) return {};
	return Object.fromEntries(
		scenario.variables.flatMap((variable) =>
			variable.defaultValue === undefined
				? []
				: [[variable.id, String(variable.defaultValue)]]
		)
	);
}

function resolvedVariables(
	scenario: ScenarioDefinitionSummary,
	drafts: VariableDrafts
): Readonly<Record<string, string | number | boolean>> {
	const output: Record<string, string | number | boolean> = {};
	for (const variable of scenario.variables) {
		const raw = drafts[variable.id];
		if (raw === undefined || raw === '') {
			if (variable.required && variable.defaultValue === undefined) {
				throw new Error(`${variable.label} is required.`);
			}
			continue;
		}
		if (variable.type === 'number') {
			const number = Number(raw);
			if (!Number.isFinite(number))
				throw new Error(`${variable.label} must be a number.`);
			output[variable.id] = number;
		} else if (variable.type === 'boolean') {
			if (raw !== 'true' && raw !== 'false') {
				throw new Error(`${variable.label} must be true or false.`);
			}
			output[variable.id] = raw === 'true';
		} else {
			output[variable.id] = raw;
		}
	}
	return output;
}

function receiptTone(status: string): 'success' | 'warning' | 'danger' {
	if (status === 'complete') return 'success';
	if (status === 'rolled-back') return 'warning';
	return 'danger';
}

export function ScenariosPanel() {
	const { canRunAction, selectedDevice, runAction } = useDesktopRuntime();
	const scenarios = selectedDevice?.tools.scenarios ?? [];
	const runtime = selectedDevice?.tools.scenarioRuntime ?? { running: false };
	const receipts = selectedDevice?.tools.scenarioReceipts ?? [];
	const [selectedId, setSelectedId] = useState<string | null>(scenarios[0]?.id ?? null);
	const selected =
		scenarios.find((scenario) => scenario.id === selectedId) ?? scenarios[0] ?? null;
	const [variablesByScenario, setVariablesByScenario] = useState<
		Readonly<Record<string, VariableDrafts>>
	>({});
	const drafts = selected
		? (variablesByScenario[selected.id] ?? initialVariables(selected))
		: {};
	let variableError: string | undefined;
	let variables: Readonly<Record<string, string | number | boolean>> = {};
	if (selected) {
		try {
			variables = resolvedVariables(selected, drafts);
		} catch (error) {
			variableError = error instanceof Error ? error.message : 'Variables are invalid.';
		}
	}
	const [importText, setImportText] = useState(
		'{\n  "schemaVersion": 1,\n  "namespace": "pumpd-devtools-scenarios",\n  "scenarios": []\n}'
	);
	const latestReceipt = useMemo(
		() =>
			selected
				? receipts
						.filter((receipt) => receipt.scenarioId === selected.id)
						.sort((left, right) => right.completedAt - left.completedAt)[0]
				: undefined,
		[receipts, selected]
	);

	return (
		<section className="panel-root">
			<PanelHeader
				eyebrow="Automation"
				title="Scenarios"
				description="Run bounded, versioned app-state transactions with full preflight, rollback capture, active-state visibility, and one-tap undo."
				meta={
					runtime.recoveryError ? (
						<span className="flex items-center gap-1.5 text-red-300">
							<ShieldAlert className="h-3 w-3" /> Recovery data needs attention
						</span>
					) : runtime.active ? (
						<span className="flex items-center gap-1.5 text-amber-300">
							<ShieldAlert className="h-3 w-3" /> {runtime.active.scenarioName}{' '}
							{runtime.active.recoveryRequired ? 'needs recovery' : 'active'}
						</span>
					) : (
						<span className="flex items-center gap-1.5 text-emerald-300">
							<CheckCircle2 className="h-3 w-3" /> No scenario override
						</span>
					)
				}
				actions={
					runtime.recoveryError ? (
						<ConfirmAction
							triggerLabel="Discard corrupt journal"
							triggerIcon={<Trash2 className="h-3.5 w-3.5" />}
							title="Discard corrupt recovery data?"
							description="This removes only the unreadable scenario recovery journal. Any app state left by its transaction must be reviewed manually."
							confirmLabel="Discard journal"
							tone="danger"
							isDisabled={!canRunAction('scenarios', 'discardRecovery')}
							onConfirm={() => {
								const recoveryError = runtime.recoveryError;
								if (!recoveryError) return;
								void runAction(
									'scenarios',
									'discardRecovery',
									{ recoveryError },
									'Corrupt scenario recovery journal discarded.'
								);
							}}
						/>
					) : runtime.active ? (
						<ConfirmAction
							triggerLabel="Undo active"
							triggerIcon={<RotateCcw className="h-3.5 w-3.5" />}
							title={`Undo ${runtime.active.scenarioName}?`}
							description="The app will restore every reversible value captured before this scenario ran, in reverse dependency order."
							confirmLabel="Undo safely"
							tone="warning"
							isDisabled={!canRunAction('scenarios', 'undo')}
							onConfirm={() => {
								const active = runtime.active;
								if (!active) return;
								void runAction(
									'scenarios',
									'undo',
									{ receiptId: active.receiptId },
									'Active scenario undone.'
								);
							}}
						/>
					) : null
				}
			/>
			<div className="grid min-h-0 flex-1 grid-cols-[330px_minmax(0,1fr)]">
				<div className="panel-scroll border-r border-white/8 p-4">
					<div className="mb-2 flex items-center justify-between px-1">
						<span className="text-[10px] uppercase tracking-[0.08em] text-(--text-3)">
							Available scenarios
						</span>
						<span className="font-mono text-[9px] text-(--text-3)">
							{scenarios.length}
						</span>
					</div>
					{scenarios.length === 0 ? (
						<EmptyPanel
							compact
							icon={<Play className="h-5 w-5" />}
							title="No scenarios"
							description="Import a versioned scenario document or connect a build with bundled scenarios."
						/>
					) : (
						<div className="space-y-2">
							{scenarios.map((scenario) => (
								<button
									aria-pressed={selected?.id === scenario.id}
									className={`w-full rounded-lg border p-3 text-left transition-colors ${selected?.id === scenario.id ? 'border-blue-400/25 bg-blue-400/[0.07]' : 'border-white/[0.06] bg-white/[0.02] hover:border-white/12 hover:bg-white/[0.04]'}`}
									key={scenario.id}
									type="button"
									onClick={() => setSelectedId(scenario.id)}
								>
									<div className="flex items-start justify-between gap-3">
										<div className="min-w-0">
											<p className="m-0 truncate text-xs font-medium text-(--foreground)">
												{scenario.name}
											</p>
											<p className="mb-0 mt-1 font-mono text-[9px] text-(--text-3)">
												{scenario.id} · v{scenario.version}
											</p>
										</div>
										<StatusPill tone={scenario.bundled ? 'info' : 'default'}>
											{scenario.bundled ? 'Bundled' : 'User'}
										</StatusPill>
									</div>
								</button>
							))}
						</div>
					)}
					<div className="mt-5 rounded-lg border border-white/8 bg-white/[0.025] p-3">
						<div className="mb-2 flex items-center gap-2 text-xs font-semibold text-(--foreground)">
							<FileJson2 className="h-3.5 w-3.5" /> Import user scenarios
						</div>
						<TextArea
							aria-label="Scenario import JSON"
							className="min-h-36 w-full rounded-md border border-white/10 bg-black/30 p-3 font-mono text-[10px] leading-4 text-(--foreground) outline-none focus:border-white/25"
							maxLength={512 * 1024}
							value={importText}
							onChange={(event) => setImportText(event.currentTarget.value)}
						/>
						<ConfirmAction
							triggerLabel="Merge import"
							title="Import user scenarios?"
							description="Every definition is strictly parsed before the persistent scenario set changes. Bundled IDs cannot be replaced."
							confirmLabel="Validate and merge"
							isDisabled={!importText || !canRunAction('scenarios', 'import')}
							triggerVariant="secondary"
							onConfirm={() =>
								void runAction(
									'scenarios',
									'import',
									{ json: importText, mode: 'merge' },
									'Scenario document imported.'
								)
							}
						/>
					</div>
				</div>
				<div className="panel-scroll p-6">
					{selected ? (
						<div className="mx-auto max-w-3xl">
							{runtime.recoveryError ? (
								<div className="mb-5 rounded-lg border border-red-400/25 bg-red-400/[0.07] p-4 text-xs text-red-200">
									{runtime.recoveryError}
								</div>
							) : null}
							<div className="mb-5 flex items-start justify-between gap-4">
								<div>
									<h2 className="m-0 text-xl font-semibold tracking-[-0.035em] text-(--foreground)">
										{selected.name}
									</h2>
									<p className="mb-0 mt-2 max-w-xl text-xs leading-5 text-(--muted)">
										{selected.description ?? 'No description provided.'}
									</p>
								</div>
								<div className="flex gap-2">
									{!selected.bundled ? (
										<ConfirmAction
											triggerLabel="Delete"
											triggerIcon={<Trash2 className="h-3.5 w-3.5" />}
											title="Delete this user scenario?"
											description="The persistent definition will be removed. Bundled scenarios are immutable."
											confirmLabel="Delete scenario"
											isDisabled={!canRunAction('scenarios', 'remove')}
											onConfirm={() =>
												void runAction(
													'scenarios',
													'remove',
													{
														id: selected.id,
														version: selected.version,
														definitionToken: selected.definitionToken,
													},
													'Scenario deleted.'
												)
											}
										/>
									) : null}
									<ConfirmAction
										triggerLabel="Run"
										triggerIcon={<Play className="h-3.5 w-3.5" />}
										triggerVariant="primary"
										title={`Run ${selected.name}?`}
										description={`PUMPD will preflight all ${selected.steps.length} steps, capture rollback state, then apply sequentially. Privileged and non-reversible steps remain blocked by the mobile engine.`}
										confirmLabel="Run transaction"
										isDisabled={
											Boolean(runtime.active) ||
											runtime.running ||
											Boolean(runtime.recoveryError) ||
											Boolean(variableError) ||
											!canRunAction('scenarios', 'execute')
										}
										onConfirm={() => {
											void runAction(
												'scenarios',
												'execute',
												{
													id: selected.id,
													version: selected.version,
													definitionToken: selected.definitionToken,
													variables,
												},
												`${selected.name} activated.`
											);
										}}
									/>
								</div>
							</div>
							{selected.variables.length > 0 ? (
								<div className="mb-5 rounded-lg border border-white/8 bg-white/[0.025] p-4">
									<h3 className="m-0 text-xs font-semibold text-(--foreground)">
										Variables
									</h3>
									<div className="mt-3 grid grid-cols-2 gap-3">
										{selected.variables.map((variable) => (
											<label className="text-[10px] text-(--muted)" key={variable.id}>
												{variable.label}
												{variable.required ? ' *' : ''}
												<input
													className="mt-1 h-9 w-full rounded-md border border-white/10 bg-black/30 px-3 text-xs text-(--foreground) outline-none focus:border-white/25"
													value={drafts[variable.id] ?? ''}
													onChange={(event) =>
														setVariablesByScenario((current) => ({
															...current,
															[selected.id]: {
																...drafts,
																[variable.id]: event.target.value,
															},
														}))
													}
												/>
											</label>
										))}
									</div>
									{variableError ? (
										<p className="mb-0 mt-2 text-[10px] text-red-300">
											{variableError}
										</p>
									) : null}
								</div>
							) : null}
							<div className="grid grid-cols-3 overflow-hidden rounded-lg border border-white/8 bg-white/[0.025]">
								<div className="border-r border-white/8 p-4">
									<p className="m-0 text-[9px] uppercase tracking-[0.08em] text-(--text-3)">
										Steps
									</p>
									<p className="mb-0 mt-1 font-mono text-lg text-(--foreground)">
										{selected.steps.length}
									</p>
								</div>
								<div className="border-r border-white/8 p-4">
									<p className="m-0 text-[9px] uppercase tracking-[0.08em] text-(--text-3)">
										Variables
									</p>
									<p className="mb-0 mt-1 font-mono text-lg text-(--foreground)">
										{selected.variables.length}
									</p>
								</div>
								<div className="p-4">
									<p className="m-0 text-[9px] uppercase tracking-[0.08em] text-(--text-3)">
										Preconditions
									</p>
									<p className="mb-0 mt-1 font-mono text-lg text-(--foreground)">
										{selected.preconditionCount}
									</p>
								</div>
							</div>
							<div className="mt-5 space-y-2">
								{selected.steps.map((step, index) => (
									<div
										className="flex items-center gap-3 rounded-lg border border-white/8 bg-white/[0.02] p-3"
										key={step.id}
									>
										<span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/10 font-mono text-[10px] text-(--muted)">
											{index + 1}
										</span>
										<div>
											<p className="m-0 text-xs font-medium text-(--foreground)">
												{step.label ?? step.id}
											</p>
											<p className="mb-0 mt-1 font-mono text-[9px] text-(--text-3)">
												{step.type}
											</p>
										</div>
									</div>
								))}
							</div>
							{latestReceipt ? (
								<div className="mt-5 rounded-lg border border-white/8 bg-white/[0.02] p-4">
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-2 text-xs font-semibold text-(--foreground)">
											<History className="h-3.5 w-3.5" /> Latest transaction
										</div>
										<StatusPill tone={receiptTone(latestReceipt.status)}>
											{latestReceipt.status}
										</StatusPill>
									</div>
									<p className="mb-0 mt-2 text-[10px] text-(--text-3)">
										{formatRelativeTime(latestReceipt.completedAt)} ·{' '}
										{latestReceipt.stepResults.length} step results
									</p>
									{latestReceipt.error ? (
										<p className="mb-0 mt-2 text-xs text-red-300">
											{latestReceipt.error}
										</p>
									) : null}
								</div>
							) : null}
						</div>
					) : (
						<EmptyPanel
							icon={<Play className="h-5 w-5" />}
							title="Select a scenario"
							description="Review its transaction before running it on the connected app."
						/>
					)}
				</div>
			</div>
		</section>
	);
}
