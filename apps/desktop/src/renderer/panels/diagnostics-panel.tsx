import { Card } from '@heroui/react/card';
import {
	Activity,
	CircleAlert,
	Cpu,
	Laptop2,
	Radio,
	ShieldCheck,
	TerminalSquare,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
	CopyButton,
	EmptyPanel,
	PanelHeader,
	PanelNotice,
	SearchControl,
	StatusPill,
	Toolbar,
} from '@/components/ui';
import { boundedTextExport, formatClock, formatRelativeTime } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import type { DiagnosticEntry } from '../../shared/protocol';

const MAX_RENDERED_DIAGNOSTICS = 500;

function levelTone(level: DiagnosticEntry['level']) {
	if (level === 'error') return 'danger' as const;
	if (level === 'warn') return 'warning' as const;
	if (level === 'info') return 'info' as const;
	return 'default' as const;
}

export function DiagnosticsPanel() {
	const { bootstrap, selectedDevice, state } = useDesktopRuntime();
	const [query, setQuery] = useState('');
	const entries = useMemo(
		() => [...(state?.diagnostics ?? []), ...(selectedDevice?.tools.diagnostics ?? [])],
		[state?.diagnostics, selectedDevice?.tools.diagnostics]
	);
	const matching = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return entries
			.filter(
				(entry) =>
					!needle ||
					[entry.level, entry.scope, entry.message]
						.join(' ')
						.toLowerCase()
						.includes(needle)
			)
			.sort((left, right) => right.at - left.at);
	}, [entries, query]);
	const filtered = matching.slice(0, MAX_RENDERED_DIAGNOSTICS);
	const broker = state?.broker;
	const latestSample = selectedDevice?.tools.performance.samples.at(-1);
	const exportText = useMemo(
		() =>
			boundedTextExport(
				filtered,
				(entry) =>
					`${new Date(entry.at).toISOString()} ${entry.level.toUpperCase()} [${entry.scope}] ${entry.message}`
			),
		[filtered]
	);

	return (
		<section className="panel-root">
			<PanelHeader
				eyebrow="System"
				title="Diagnostics"
				description="Desktop broker health, device transport, runtime versions, privacy guarantees, and internal diagnostic events in one place."
				meta={
					<StatusPill
						dot
						tone={
							broker?.status === 'listening'
								? 'success'
								: broker?.status === 'error'
									? 'danger'
									: 'warning'
						}
					>
						{broker?.status ?? 'starting'}
					</StatusPill>
				}
			/>
			<Toolbar>
				<SearchControl
					ariaLabel="Search diagnostics"
					placeholder="Scope, level, message…"
					value={query}
					onChange={setQuery}
				/>
				<span className="ml-auto font-mono text-[10px] text-(--text-3)">
					{filtered.length} of {matching.length} events
				</span>
			</Toolbar>
			{matching.length > filtered.length || exportText.truncated ? (
				<PanelNotice title="Diagnostic rendering is bounded." tone="info">
					Search covers all {matching.length} matching events. The stream and copy
					action use the newest {MAX_RENDERED_DIAGNOSTICS}, and copied text is capped at
					2 MB.
				</PanelNotice>
			) : null}
			<div className="panel-scroll p-5">
				<div className="mb-4 grid grid-cols-4 gap-3 max-[1180px]:grid-cols-2">
					<HealthCard
						icon={<Radio className="h-4 w-4" />}
						label="Broker"
						value={broker?.status ?? 'Starting'}
						detail={
							broker ? `${broker.host}:${broker.port}` : 'Creating local listener'
						}
						tone={
							broker?.status === 'listening'
								? 'green'
								: broker?.status === 'error'
									? 'red'
									: 'amber'
						}
					/>
					<HealthCard
						icon={<Laptop2 className="h-4 w-4" />}
						label="Selected device"
						value={selectedDevice?.status ?? 'None'}
						detail={
							selectedDevice
								? `${selectedDevice.info.name} · ${formatRelativeTime(selectedDevice.lastSeenAt)}`
								: 'Waiting for a session'
						}
						tone={
							!selectedDevice || selectedDevice.status === 'offline' ? 'amber' : 'blue'
						}
					/>
					<HealthCard
						icon={<Activity className="h-4 w-4" />}
						label="JS responsiveness"
						value={
							latestSample ? `${latestSample.jsFps.toFixed(0)} fps` : 'Unavailable'
						}
						detail={
							latestSample
								? `${latestSample.eventLoopLagMs.toFixed(1)} ms loop lag`
								: 'Start a performance review'
						}
						tone={
							!latestSample
								? 'blue'
								: latestSample.eventLoopLagMs > 32
									? 'amber'
									: 'green'
						}
					/>
					<HealthCard
						icon={<ShieldCheck className="h-4 w-4" />}
						label="Transport"
						value={broker?.access === 'token' ? 'Token protected' : 'Loopback only'}
						detail={
							broker?.access === 'token'
								? `Authenticated access on ${broker.host}; traffic is not encrypted by ws://`
								: 'Only this computer can connect'
						}
						tone={
							broker?.status === 'listening'
								? 'green'
								: broker?.status === 'error'
									? 'red'
									: 'amber'
						}
					/>
				</div>

				<div className="mb-4 grid grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)] gap-4 max-[1080px]:grid-cols-1">
					<Card
						className="rounded-lg border border-white/8 bg-white/[0.025] p-0 shadow-none"
						variant="secondary"
					>
						<Card.Header className="flex items-center justify-between border-b border-white/8 px-4 py-3">
							<div>
								<Card.Title className="m-0 text-xs font-semibold text-(--foreground)">
									Connection endpoints
								</Card.Title>
								<Card.Description className="mb-0 mt-1 text-[10px] text-(--text-3)">
									Use the first reachable WebSocket URL from a development device.
								</Card.Description>
							</div>
							<Radio className="h-4 w-4 text-blue-300" />
						</Card.Header>
						<Card.Content className="p-0">
							{broker?.urls.map((url) => (
								<div
									className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3 last:border-0"
									key={url}
								>
									<span
										className={`h-1.5 w-1.5 rounded-full ${broker.status === 'listening' ? 'bg-emerald-400' : 'bg-red-400'}`}
									/>
									<code className="min-w-0 flex-1 truncate text-[10px] text-(--foreground)">
										{url}
									</code>
									<CopyButton label="Copy endpoint" value={url} />
								</div>
							))}
							{broker?.urls.length === 0 ? (
								<p className="m-0 px-4 py-3 text-[10px] text-(--text-3)">
									No connection endpoint is available.
								</p>
							) : null}
							{broker?.error ? (
								<div className="flex items-start gap-2 border-t border-red-400/15 bg-red-400/[0.05] px-4 py-3 text-[10px] leading-5 text-red-200">
									<CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {broker.error}
								</div>
							) : null}
						</Card.Content>
					</Card>
					<Card
						className="rounded-lg border border-white/8 bg-white/[0.025] p-4 shadow-none"
						variant="secondary"
					>
						<div className="mb-3 flex items-center gap-2 text-xs font-semibold text-(--foreground)">
							<Cpu className="h-4 w-4 text-(--muted)" /> Runtime
						</div>
						<VersionRow label="App" value={bootstrap?.versions.app ?? '—'} />
						<VersionRow label="Electron" value={bootstrap?.versions.electron ?? '—'} />
						<VersionRow label="Chromium" value={bootstrap?.versions.chrome ?? '—'} />
						<VersionRow label="Node" value={bootstrap?.versions.node ?? '—'} />
						<VersionRow
							label="Protocol"
							value={state ? `v${state.protocolVersion}` : '—'}
						/>
					</Card>
				</div>

				<Card
					className="rounded-lg border border-white/8 bg-white/[0.025] p-0 shadow-none"
					variant="secondary"
				>
					<Card.Header className="flex items-center justify-between border-b border-white/8 px-4 py-3">
						<div className="flex items-center gap-2">
							<TerminalSquare className="h-4 w-4 text-(--muted)" />
							<Card.Title className="m-0 text-xs font-semibold text-(--foreground)">
								Internal event stream
							</Card.Title>
						</div>
						{exportText.text ? (
							<CopyButton
								label={
									exportText.truncated
										? 'Copy bounded diagnostic events'
										: 'Copy diagnostic events'
								}
								value={exportText.text}
							/>
						) : null}
					</Card.Header>
					<Card.Content className="p-0">
						{filtered.length === 0 ? (
							<EmptyPanel
								icon={<TerminalSquare className="h-5 w-5" />}
								title="No diagnostic events"
								description="Broker and device lifecycle events will appear here."
							/>
						) : (
							filtered.map((entry) => (
								<div
									className="grid grid-cols-[78px_72px_110px_minmax(0,1fr)] items-start gap-3 border-b border-white/[0.06] px-4 py-3 last:border-0"
									key={`${entry.scope}-${entry.id}`}
								>
									<span className="font-mono text-[9px] text-(--text-3)">
										{formatClock(entry.at)}
									</span>
									<StatusPill tone={levelTone(entry.level)}>{entry.level}</StatusPill>
									<code className="truncate text-[10px] text-(--muted)">
										{entry.scope}
									</code>
									<span className="text-[10px] leading-4 text-(--foreground)">
										{entry.message}
									</span>
								</div>
							))
						)}
					</Card.Content>
				</Card>
			</div>
		</section>
	);
}

function HealthCard({
	icon,
	label,
	value,
	detail,
	tone,
}: {
	icon: React.ReactNode;
	label: string;
	value: string;
	detail: string;
	tone: 'blue' | 'green' | 'amber' | 'red';
}) {
	const color = {
		blue: 'border-blue-400/15 bg-blue-400/[0.055] text-blue-300',
		green: 'border-emerald-400/15 bg-emerald-400/[0.055] text-emerald-300',
		amber: 'border-amber-400/15 bg-amber-400/[0.055] text-amber-300',
		red: 'border-red-400/15 bg-red-400/[0.055] text-red-300',
	}[tone];
	return (
		<Card
			className="rounded-lg border border-white/8 bg-white/[0.025] p-4 shadow-none"
			variant="secondary"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="m-0 text-[9px] uppercase tracking-[0.08em] text-(--text-3)">
						{label}
					</p>
					<p className="mb-0 mt-2 truncate text-sm font-semibold capitalize text-(--foreground)">
						{value}
					</p>
				</div>
				<span
					className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border ${color}`}
				>
					{icon}
				</span>
			</div>
			<p className="mb-0 mt-3 truncate text-[9px] text-(--text-3)">{detail}</p>
		</Card>
	);
}

function VersionRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-3 border-t border-white/[0.06] py-2 first:border-0">
			<span className="text-[10px] text-(--text-3)">{label}</span>
			<code className="max-w-[170px] truncate text-[10px] text-(--foreground)">
				{value}
			</code>
		</div>
	);
}
