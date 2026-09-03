import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { Label } from '@heroui/react/label';
import { TextField } from '@heroui/react/textfield';
import { ArchiveRestore, Camera, Clock3, ShieldCheck, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
	CodePreview,
	ConfirmAction,
	EmptyPanel,
	PanelHeader,
	StatusPill,
} from '@/components/ui';
import { formatBytes, formatRelativeTime } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';

export function RestorePanel() {
	const { canRunAction, selectedDevice, runAction } = useDesktopRuntime();
	const rawPoints = selectedDevice?.tools.restorePoints ?? [];
	const points = useMemo(
		() => [...rawPoints].sort((left, right) => right.createdAt - left.createdAt),
		[rawPoints]
	);
	const [label, setLabel] = useState('Before desktop changes');
	const [selectedId, setSelectedId] = useState<string | null>(points[0]?.id ?? null);
	const selected = points.find((point) => point.id === selectedId) ?? points[0] ?? null;

	return (
		<section className="panel-root">
			<PanelHeader
				eyebrow="State"
				title="Restore Points"
				description="Capture and roll back only state sources the app explicitly declares as safe to restore."
				meta={
					<span className="flex items-center gap-1.5 text-emerald-300">
						<ShieldCheck className="h-3 w-3" /> Rollback guarded · explicit sources
					</span>
				}
			/>
			<div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)]">
				<div className="panel-scroll border-r border-white/8 p-4">
					<div className="mb-4 rounded-lg border border-white/10 bg-white/[0.035] p-4">
						<div className="mb-3 flex items-center gap-2">
							<div className="grid h-8 w-8 place-items-center rounded-md border border-blue-400/20 bg-blue-400/10 text-blue-300">
								<Camera className="h-3.5 w-3.5" />
							</div>
							<div>
								<h2 className="m-0 text-xs font-semibold text-(--foreground)">
									New checkpoint
								</h2>
								<p className="mb-0 mt-0.5 text-[10px] text-(--text-3)">
									Developer overrides only
								</p>
							</div>
						</div>
						<TextField fullWidth value={label} onChange={setLabel}>
							<Label className="mb-1.5 text-[10px] text-(--muted)">
								Checkpoint label
							</Label>
							<Input
								className="h-9 rounded-md border border-white/10 bg-black/30 px-3 text-xs text-(--foreground)"
								maxLength={120}
								placeholder="Before testing empty state"
							/>
						</TextField>
						<Button
							className="mt-3"
							fullWidth
							isDisabled={!label.trim() || !canRunAction('restore', 'capture')}
							size="sm"
							variant="primary"
							onPress={() => {
								setSelectedId(null);
								void runAction(
									'restore',
									'capture',
									{ label: label.trim() },
									'Restore point captured.'
								);
							}}
						>
							<Camera className="h-3.5 w-3.5" /> Capture current state
						</Button>
					</div>
					<div className="mb-2 flex items-center justify-between px-1">
						<span className="text-[10px] uppercase tracking-[0.08em] text-(--text-3)">
							Checkpoints
						</span>
						<span className="font-mono text-[9px] text-(--text-3)">
							{points.length}
						</span>
					</div>
					{points.length === 0 ? (
						<EmptyPanel
							icon={<Clock3 className="h-5 w-5" />}
							title="No restore points"
							description="Capture the explicit developer state before testing risky scenarios."
						/>
					) : (
						<div className="space-y-2">
							{points.map((point) => (
								<button
									aria-pressed={selected?.id === point.id}
									className={`w-full rounded-lg border p-3 text-left transition-colors ${selected?.id === point.id ? 'border-white/18 bg-white/[0.07]' : 'border-white/[0.06] bg-white/[0.02] hover:border-white/12 hover:bg-white/[0.04]'}`}
									key={point.id}
									type="button"
									onClick={() => setSelectedId(point.id)}
								>
									<div className="flex items-start gap-3">
										<div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border border-emerald-400/20 bg-emerald-400/10 text-emerald-300">
											<ArchiveRestore className="h-3.5 w-3.5" />
										</div>
										<div className="min-w-0 flex-1">
											<p className="m-0 truncate text-xs font-medium text-(--foreground)">
												{point.label}
											</p>
											<p className="mb-0 mt-1 text-[9px] text-(--text-3)">
												{formatRelativeTime(point.createdAt)} ·{' '}
												{formatBytes(point.estimatedBytes)}
											</p>
										</div>
									</div>
								</button>
							))}
						</div>
					)}
				</div>
				<div className="panel-scroll p-6">
					{selected ? (
						<div className="mx-auto max-w-3xl">
							<div className="mb-5 flex items-start justify-between gap-5">
								<div>
									<div className="mb-2 flex items-center gap-2">
										<StatusPill tone="success" dot>
											Captured
										</StatusPill>
										<span className="text-[10px] text-(--text-3)">
											{formatRelativeTime(selected.createdAt)}
										</span>
									</div>
									<h2 className="m-0 text-xl font-semibold tracking-[-0.035em] text-(--foreground)">
										{selected.label}
									</h2>
								</div>
								<div className="flex gap-2">
									<ConfirmAction
										triggerLabel="Delete"
										triggerIcon={<Trash2 className="h-3.5 w-3.5" />}
										title="Delete this restore point?"
										description="The snapshot will be removed from this in-memory diagnostics session. This cannot be undone."
										confirmLabel="Delete point"
										isDisabled={!canRunAction('restore', 'remove')}
										onConfirm={() => {
											setSelectedId(null);
											void runAction(
												'restore',
												'remove',
												{ id: selected.id },
												'Restore point deleted.'
											);
										}}
									/>
									<ConfirmAction
										triggerLabel="Restore"
										triggerIcon={<ArchiveRestore className="h-3.5 w-3.5" />}
										triggerVariant="secondary"
										tone="warning"
										title="Restore explicit developer state?"
										description="PUMPD captures rollback data before applying declared sources in order. If a source fails, it attempts to restore every source already touched. User data, authentication, and secure storage are outside this snapshot."
										confirmLabel="Restore safely"
										isDisabled={!canRunAction('restore', 'restore')}
										onConfirm={() =>
											void runAction(
												'restore',
												'restore',
												{ id: selected.id },
												'Explicit developer state restored.'
											)
										}
									/>
								</div>
							</div>
							<div className="mb-5 grid grid-cols-3 overflow-hidden rounded-lg border border-white/8 bg-white/[0.025]">
								<div className="border-r border-white/8 p-4">
									<p className="m-0 text-[9px] uppercase tracking-[0.08em] text-(--text-3)">
										Sources
									</p>
									<p className="mb-0 mt-1 font-mono text-lg text-(--foreground)">
										{selected.sources.length}
									</p>
								</div>
								<div className="border-r border-white/8 p-4">
									<p className="m-0 text-[9px] uppercase tracking-[0.08em] text-(--text-3)">
										Size
									</p>
									<p className="mb-0 mt-1 font-mono text-lg text-(--foreground)">
										{formatBytes(selected.estimatedBytes)}
									</p>
								</div>
								<div className="p-4">
									<p className="m-0 text-[9px] uppercase tracking-[0.08em] text-(--text-3)">
										Lifetime
									</p>
									<p className="mb-0 mt-1 font-mono text-lg text-(--foreground)">
										Session
									</p>
								</div>
							</div>
							<div className="space-y-4">
								{selected.sources.map((source) => (
									<div
										className="rounded-lg border border-white/8 bg-white/[0.02] p-4"
										key={source.id}
									>
										<div className="mb-3 flex items-center justify-between gap-3">
											<div>
												<h3 className="m-0 text-xs font-semibold text-(--foreground)">
													{source.title}
												</h3>
												<p className="mb-0 mt-1 font-mono text-[9px] text-(--text-3)">
													{source.id}
												</p>
											</div>
											<StatusPill tone="success">
												{formatBytes(source.bytes)}
											</StatusPill>
										</div>
										<CodePreview
											label="Canonical JSON preview"
											value={source.preview}
											maxHeight={320}
										/>
									</div>
								))}
							</div>
							<div className="mt-5 rounded-lg border border-emerald-400/15 bg-emerald-400/[0.05] p-4">
								<div className="flex items-center gap-2 text-xs font-medium text-emerald-200">
									<ShieldCheck className="h-4 w-4" /> Restore safety boundary
								</div>
								<p className="mb-0 mt-2 text-[11px] leading-5 text-emerald-100/60">
									Snapshots are JSON-bounded and validated before writes. If a later
									source fails, PUMPD attempts to reapply the captured rollback data.
									Secure storage and app user data are not included.
								</p>
							</div>
						</div>
					) : (
						<EmptyPanel
							icon={<ArchiveRestore className="h-5 w-5" />}
							title="Select a restore point"
							description="Review its exact source boundary before restoring it on device."
						/>
					)}
				</div>
			</div>
		</section>
	);
}
