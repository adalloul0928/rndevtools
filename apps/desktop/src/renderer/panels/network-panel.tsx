import { Button } from '@heroui/react/button';
import {
	DataGrid,
	type DataGridColumn,
	type DataGridSelection,
} from '@heroui-pro/react/data-grid';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	matchesNetworkSegment,
	type NetworkSegment,
} from '@rndevtools/core/plugins/network-presentation';
import {
	ChevronDown,
	CirclePause,
	CirclePlay,
	DatabaseZap,
	Filter,
	Radio,
	Trash2,
	Wifi,
	WifiOff,
	X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
	Badge,
	CodePreview,
	ConfirmAction,
	DetailPlaceholder,
	EmptyPanel,
	KeyValue,
	PanelHeader,
	PanelNotice,
	SearchControl,
	StatusPill,
	Toolbar,
} from '@/components/ui';
import {
	settleNetworkFilter,
	useAppTraffic,
	useNetworkFilterIntent,
} from '@/lib/app-traffic';
import {
	formatBytes,
	formatClock,
	formatDuration,
	truncateMiddle,
} from '@/lib/format';
import {
	type NetworkTargetBadge,
	type NetworkTargetFilter,
	networkTargetFilter,
	networkTargetKey,
} from '@/simulator/app-traffic-model';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import { useSupabaseNavigation } from '@/state/supabase-runtime';
import type { NetworkEntry } from '../../shared/protocol';
import type { SupabaseTrafficTarget } from '../../shared/supabase-traffic';

// Classification is shared with the on-device panel. The local copy disagreed
// with it: aborted requests were missing from `errors`, and `supabase` matched
// on a hard-coded host substring rather than the REST/functions/storage/auth
// path prefixes, so custom-domain traffic was classified differently on each
// surface.
type NetworkFilter = NetworkSegment;
type DetailTab = 'overview' | 'headers' | 'request' | 'response';

const NETWORK_PROFILES = [
	{ id: 'offline', name: 'Offline' },
	{ id: 'edge', name: 'Edge' },
	{ id: '3g', name: '3G' },
	{ id: 'lte', name: 'LTE' },
	{ id: 'wifi', name: 'Wi-Fi' },
	{ id: 'dsl', name: 'DSL' },
	{ id: 'very-bad', name: 'Very Bad Network' },
] as const;
type NetworkProfileId = (typeof NETWORK_PROFILES)[number]['id'];

const NETWORK_FILTERS: {
	id: NetworkFilter;
	label: string;
}[] = [
	{ id: 'all', label: 'All' },
	{ id: 'errors', label: 'Errors' },
	{ id: 'slow', label: 'Slow' },
	{ id: 'supabase', label: 'Backend' },
];

/**
 * Method → `Badge` tone. HTTP verbs read as semantic categories, not status:
 * GET is neutral information (blue), the mutating verbs escalate — POST creates
 * (positive/green), DELETE removes (danger/red), PUT/PATCH/other change
 * (warning/amber). Kept pure so the mapping is unit-tested rather than
 * eyeballed.
 */
export function methodBadgeTone(
	method: string
): 'info' | 'success' | 'danger' | 'warning' {
	const verb = method.toUpperCase();
	if (verb === 'GET' || verb === 'HEAD') return 'info';
	if (verb === 'POST') return 'success';
	if (verb === 'DELETE') return 'danger';
	return 'warning';
}

export function statusTone(
	entry: Pick<NetworkEntry, 'state' | 'status'>
): 'success' | 'warning' | 'danger' | 'info' {
	if (entry.state === 'pending') return 'info';
	if (
		entry.state === 'error' ||
		entry.state === 'aborted' ||
		(entry.status ?? 0) >= 400
	)
		return 'danger';
	if ((entry.status ?? 0) >= 300) return 'warning';
	return 'success';
}

export function headersText(
	headers: Record<string, string> | undefined
): string {
	if (!headers || Object.keys(headers).length === 0)
		return 'No captured headers.';
	return Object.entries(headers)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}: ${value}`)
		.join('\n');
}

/**
 * Requests to one backend: the filter the connected banner's Show this
 * traffic asks for, kept per device so another app's list is never
 * narrowed by it.
 */
export function matchesNetworkTarget(
	target: SupabaseTrafficTarget | undefined,
	filter: NetworkTargetFilter | null
): boolean {
	return (
		filter === null ||
		(target !== undefined && networkTargetKey(target) === filter.key)
	);
}

function MethodBadge({ method }: { method: string }) {
	return (
		<Badge className="font-mono font-semibold" tone={methodBadgeTone(method)}>
			{method}
		</Badge>
	);
}

export function NetworkPanel() {
	const { canRunAction, actionUnavailableReason, selectedDevice, runAction } =
		useDesktopRuntime();
	const liveEntries = selectedDevice?.tools.network ?? [];
	const deviceId = selectedDevice?.info.id;
	const [pausedSnapshot, setPausedSnapshot] = useState<{
		deviceId: string | undefined;
		entries: NetworkEntry[];
	} | null>(null);
	const pausedEntries =
		pausedSnapshot && pausedSnapshot.deviceId === deviceId
			? pausedSnapshot.entries
			: null;
	const entries = pausedEntries ?? liveEntries;
	const [query, setQuery] = useState('');
	const [filter, setFilter] = useState<NetworkFilter>('all');
	const [selectedId, setSelectedId] = useState<string | null>(
		entries[0]?.id ?? null
	);
	const [detailTab, setDetailTab] = useState<DetailTab>('overview');
	const currentProfile = selectedDevice?.tools.networkProfile;
	const [profileId, setProfileId] = useState<NetworkProfileId>(
		currentProfile?.id === 'none' || !currentProfile?.id
			? 'lte'
			: (currentProfile.id as NetworkProfileId)
	);
	const paused = pausedEntries !== null;
	const setProfileReason = actionUnavailableReason('network', 'setProfile');
	const traffic = useAppTraffic();
	const { targetFor, badgeFor } = traffic;
	const { openInSupabase } = useSupabaseNavigation();
	const [targetChip, setTargetChip] = useState<{
		deviceId: string | undefined;
		filter: NetworkTargetFilter;
	} | null>(null);
	const targetFilter =
		targetChip && targetChip.deviceId === deviceId ? targetChip.filter : null;
	const intent = useNetworkFilterIntent();
	useEffect(() => {
		if (!intent) return;
		// The banner's Show this traffic: the backend segment, one backend.
		setFilter('supabase');
		setTargetChip({ deviceId: intent.deviceId, filter: intent.target });
		settleNetworkFilter(intent.nonce);
	}, [intent]);
	useEffect(() => {
		if (pausedSnapshot && pausedSnapshot.deviceId !== deviceId) {
			setPausedSnapshot(null);
		}
	}, [deviceId, pausedSnapshot]);
	useEffect(() => {
		if (currentProfile?.id && currentProfile.id !== 'none') {
			setProfileId(currentProfile.id);
		}
	}, [currentProfile?.id]);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return entries
			.filter((entry) => {
				if (!matchesNetworkSegment(entry, filter)) return false;
				if (!matchesNetworkTarget(targetFor(entry), targetFilter)) return false;
				return (
					!needle ||
					[
						entry.method,
						entry.url,
						entry.host,
						entry.path,
						entry.status,
						entry.source,
					]
						.join(' ')
						.toLowerCase()
						.includes(needle)
				);
			})
			.sort((left, right) => right.at - left.at);
	}, [entries, filter, query, targetFilter, targetFor]);

	const selected =
		filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null;
	const columns = useMemo<DataGridColumn<NetworkEntry>[]>(
		() => [
			{
				id: 'method',
				header: 'Method',
				width: 88,
				isRowHeader: true,
				cell: (entry) => <MethodBadge method={entry.method} />,
			},
			{
				id: 'request',
				header: 'Request',
				minWidth: 340,
				cell: (entry) => {
					const target = targetFor(entry);
					return (
						<div className="min-w-0 py-0.5">
							<div className="truncate font-mono text-xs text-(--foreground)">
								{entry.path}
							</div>
							<div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-(--text-3)">
								{target ? <TargetBadge badge={badgeFor(target)} /> : null}
								<span className="truncate">
									{entry.host} {entry.source ? `· ${entry.source}` : ''}
								</span>
							</div>
						</div>
					);
				},
			},
			{
				id: 'status',
				header: 'Status',
				width: 92,
				cell: (entry) => (
					<StatusPill tone={statusTone(entry)}>
						{entry.state === 'pending'
							? 'Pending'
							: (entry.status ?? entry.state)}
					</StatusPill>
				),
			},
			{
				id: 'duration',
				header: 'Time',
				width: 90,
				align: 'end',
				cell: (entry) => (
					<span className="font-mono text-xs text-(--muted)">
						{formatDuration(entry.durationMs)}
					</span>
				),
			},
			{
				id: 'size',
				header: 'Size',
				width: 88,
				align: 'end',
				cell: (entry) => (
					<span className="font-mono text-xs text-(--muted)">
						{formatBytes(entry.responseBytes)}
					</span>
				),
			},
			{
				id: 'at',
				header: 'Started',
				width: 92,
				align: 'end',
				cell: (entry) => (
					<span className="font-mono text-xs text-(--text-3)">
						{formatClock(entry.at)}
					</span>
				),
			},
		],
		[badgeFor, targetFor]
	);

	const selectedTarget = selected ? targetFor(selected) : undefined;
	const selectedBackend = selectedTarget
		? {
				badge: badgeFor(selectedTarget),
				target: selectedTarget,
				onOpen: () =>
					openInSupabase(
						selectedTarget.kind === 'this-stack' ||
							selectedTarget.kind === 'other-stack'
							? { stackId: selectedTarget.stackId }
							: {}
					),
				onOnly: () => {
					setFilter('supabase');
					setTargetChip({
						deviceId,
						filter: networkTargetFilter(selectedTarget),
					});
				},
			}
		: undefined;

	function onSelectionChange(selection: DataGridSelection): void {
		if (selection === 'all') {
			setSelectedId(filtered[0]?.id ?? null);
			return;
		}
		const key = [...selection][0];
		setSelectedId(key === undefined ? null : String(key));
	}

	return (
		<section className="panel-root">
			<PanelHeader
				eyebrow="Inspect"
				title="Network"
				description="Every instrumented request, with privacy-safe headers, bodies, timing, and failure context."
				meta={
					<span className="flex items-center gap-1.5 text-(--brand)">
						<Radio className="h-3 w-3" /> {paused ? 'View paused' : 'Live view'}
					</span>
				}
				actions={
					<>
						<Button
							aria-pressed={paused}
							size="sm"
							variant="secondary"
							onPress={() =>
								setPausedSnapshot(
									paused ? null : { deviceId, entries: [...liveEntries] }
								)
							}
						>
							{paused ? (
								<CirclePlay className="h-3.5 w-3.5" />
							) : (
								<CirclePause className="h-3.5 w-3.5" />
							)}
							{paused ? 'Resume view' : 'Pause view'}
						</Button>
						<ConfirmAction
							triggerLabel="Clear"
							triggerIcon={<Trash2 className="h-3.5 w-3.5" />}
							title="Clear captured requests?"
							description="This only clears the diagnostics buffer. It does not cancel requests or change app data."
							confirmLabel="Clear requests"
							isDisabled={!canRunAction('network', 'clear')}
							onConfirm={() => {
								void runAction(
									'network',
									'clear',
									{},
									'Network buffer cleared.'
								).then((result) => {
									if (result.ok && paused) {
										setPausedSnapshot((current) =>
											current?.deviceId === deviceId
												? { deviceId, entries: [] }
												: current
										);
									}
								});
							}}
						/>
					</>
				}
			/>
			<Toolbar>
				<SearchControl
					ariaLabel="Search network requests"
					placeholder="URL, method, status…"
					value={query}
					widthClassName="w-[260px] max-[1080px]:w-[200px]"
					onChange={setQuery}
				/>
				<div className="flex items-center gap-1">
					{NETWORK_FILTERS.map(({ id, label }) => (
						<Button
							aria-pressed={filter === id}
							className="h-7 rounded-md px-2.5 text-xs"
							key={id}
							size="sm"
							variant={filter === id ? 'secondary' : 'ghost'}
							onPress={() => setFilter(id)}
						>
							{label}
						</Button>
					))}
				</div>
				{targetFilter ? (
					<span className="network-target-filter">
						<Badge className="network-target-filter-label">
							{targetFilter.label}
						</Badge>
						<Button
							aria-label={`Show every backend, not only ${targetFilter.label}`}
							className="sim-icon-button"
							isIconOnly
							size="sm"
							variant="ghost"
							onPress={() => setTargetChip(null)}
						>
							<X className="h-3.5 w-3.5" />
						</Button>
					</span>
				) : null}
				<span className="sim-toolbar-separator" />
				<div className="sim-toolbar-field">
					<span>Fetch profile</span>
					<NativeSelect className="sim-filter-select" fullWidth={false}>
						<NativeSelect.Trigger
							aria-label="Instrumented fetch network profile"
							value={profileId}
							onChange={(event) =>
								setProfileId(event.currentTarget.value as NetworkProfileId)
							}
						>
							{NETWORK_PROFILES.map((profile) => (
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
					{...(setProfileReason
						? { 'aria-describedby': 'network-set-reason' }
						: {})}
					isDisabled={!canRunAction('network', 'setProfile')}
					size="sm"
					variant="secondary"
					onPress={() =>
						void runAction(
							'network',
							'setProfile',
							{ profileId },
							`${NETWORK_PROFILES.find((profile) => profile.id === profileId)?.name ?? profileId} fetch profile applied.`
						)
					}
				>
					<Wifi className="h-3.5 w-3.5" /> Set
				</Button>
				<Button
					{...(currentProfile?.active
						? {}
						: { 'aria-describedby': 'network-clear-reason' })}
					isDisabled={
						!canRunAction('network', 'clearProfile') || !currentProfile?.active
					}
					size="sm"
					variant="ghost"
					onPress={() =>
						void runAction(
							'network',
							'clearProfile',
							{},
							'Instrumented fetch profile cleared.'
						)
					}
				>
					<WifiOff className="h-3.5 w-3.5" /> Clear
				</Button>
				{setProfileReason ? (
					<span
						className="shrink-0 text-xs text-(--warning)"
						id="network-set-reason"
					>
						{setProfileReason}
					</span>
				) : !currentProfile?.active ? (
					<span
						className="shrink-0 text-xs text-(--text-3)"
						id="network-clear-reason"
					>
						No profile active
					</span>
				) : null}
				<span className="ml-auto shrink-0 font-mono text-xs text-(--text-3)">
					{filtered.length} of {entries.length} requests
				</span>
			</Toolbar>
			<PanelNotice
				title={
					currentProfile?.active
						? `${currentProfile.name} is active · instrumented requests only`
						: 'Network simulation is off'
				}
				tone="info"
			>
				{currentProfile?.active
					? `${currentProfile.name} is active for instrumented fetch only. `
					: 'No network profile is currently active. '}
				Profiles do not change Simulator-wide networking, native SDK traffic,
				WebSockets, or requests from other apps.
			</PanelNotice>

			<div className="split-panel">
				<div className="min-w-0 overflow-hidden">
					{filtered.length === 0 ? (
						<EmptyPanel
							icon={<Radio className="h-5 w-5" />}
							title="No matching requests"
							description="Adjust the filters or use the app to generate fresh network traffic."
						/>
					) : (
						<DataGrid
							aria-label="Captured network requests"
							className="desktop-grid"
							columns={columns}
							data={filtered}
							getRowId={(entry) => entry.id}
							headingHeight={36}
							rowHeight={42}
							selectedKeys={selected ? new Set([selected.id]) : new Set()}
							selectionMode="single"
							virtualized
							onSelectionChange={onSelectionChange}
						/>
					)}
				</div>
				<aside className="detail-pane">
					{selected ? (
						<NetworkDetail
							backend={selectedBackend}
							entry={selected}
							tab={detailTab}
							onTabChange={setDetailTab}
						/>
					) : (
						<DetailPlaceholder />
					)}
				</aside>
			</div>
		</section>
	);
}

/** The backend a Supabase-shaped request went to, beside its host. */
function TargetBadge({ badge }: { badge: NetworkTargetBadge }) {
	return (
		<Badge className="network-target-badge" tone={badge.tone}>
			{badge.label}
		</Badge>
	);
}

function NetworkDetail({
	entry,
	tab,
	onTabChange,
	backend,
}: {
	entry: NetworkEntry;
	tab: DetailTab;
	onTabChange: (tab: DetailTab) => void;
	/** Set for Supabase-shaped requests: which backend, and what to do about it. */
	backend?:
		| Readonly<{
				badge: NetworkTargetBadge;
				target: SupabaseTrafficTarget;
				onOpen: () => void;
				onOnly: () => void;
		  }>
		| undefined;
}) {
	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-white/8 p-4">
				<div className="mb-3 flex items-center gap-2">
					<MethodBadge method={entry.method} />
					<StatusPill tone={statusTone(entry)}>
						{entry.status ?? entry.state}
					</StatusPill>
				</div>
				<h2 className="m-0 break-all font-mono text-xs font-medium leading-5 text-(--foreground)">
					{truncateMiddle(entry.url, 160)}
				</h2>
				<p className="mb-0 mt-2 text-xs text-(--text-3)">
					{formatClock(entry.at)} · {formatDuration(entry.durationMs)} ·{' '}
					{formatBytes(entry.responseBytes)}
				</p>
			</div>
			<div className="flex h-9 shrink-0 items-end gap-4 border-b border-white/8 px-4">
				{(['overview', 'headers', 'request', 'response'] as const).map(
					(value) => (
						<button
							aria-pressed={tab === value}
							className={`h-9 border-b text-xs capitalize transition-colors ${tab === value ? 'border-white text-white' : 'border-transparent text-(--text-3) hover:text-(--muted)'}`}
							key={value}
							type="button"
							onClick={() => onTabChange(value)}
						>
							{value}
						</button>
					)
				)}
			</div>
			<div className="min-h-0 flex-1 overflow-auto p-4">
				{tab === 'overview' ? (
					<dl className="m-0">
						<KeyValue label="Host" value={entry.host} mono />
						<KeyValue label="Path" value={entry.path} mono />
						<KeyValue label="Source" value={entry.source ?? 'fetch'} />
						{backend ? (
							<KeyValue
								label="Backend"
								value={
									<span className="network-target-detail">
										<TargetBadge badge={backend.badge} />
										<span>{backend.badge.detail}</span>
										<span className="network-target-detail-actions">
											{backend.target.kind === 'this-stack' ||
											backend.target.kind === 'other-stack' ? (
												<Button
													size="sm"
													variant="ghost"
													onPress={backend.onOpen}
												>
													<DatabaseZap className="h-3.5 w-3.5" /> Open in
													Supabase
												</Button>
											) : null}
											<Button
												size="sm"
												variant="ghost"
												onPress={backend.onOnly}
											>
												<Filter className="h-3.5 w-3.5" /> Only this backend
											</Button>
										</span>
									</span>
								}
							/>
						) : null}
						<KeyValue
							label="Content type"
							value={entry.contentType ?? 'Unknown'}
							mono
						/>
						<KeyValue
							label="Request size"
							value={formatBytes(entry.requestBytes)}
							mono
						/>
						<KeyValue
							label="Response size"
							value={formatBytes(entry.responseBytes)}
							mono
						/>
						<KeyValue
							label="Duration"
							value={formatDuration(entry.durationMs)}
							mono
						/>
						{entry.error ? (
							<div className="mt-4">
								<PanelNotice title="Request failed" tone="danger">
									{entry.error}
								</PanelNotice>
							</div>
						) : null}
					</dl>
				) : null}
				{tab === 'headers' ? (
					<div className="space-y-4">
						<CodePreview
							label="Request headers"
							value={headersText(entry.requestHeaders)}
						/>
						<CodePreview
							label="Response headers"
							value={headersText(entry.responseHeaders)}
						/>
					</div>
				) : null}
				{tab === 'request' ? (
					<CodePreview
						label="Request body"
						value={entry.requestBody}
						maxHeight={520}
					/>
				) : null}
				{tab === 'response' ? (
					<CodePreview
						label="Response body"
						value={entry.responseBody}
						maxHeight={520}
					/>
				) : null}
			</div>
		</div>
	);
}
