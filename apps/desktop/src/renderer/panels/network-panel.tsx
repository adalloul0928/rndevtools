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
} from '@pumpd/devtools/plugins/network-presentation';
import {
	ChevronDown,
	CirclePause,
	CirclePlay,
	Radio,
	Trash2,
	Wifi,
	WifiOff,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
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
import { formatBytes, formatClock, formatDuration, truncateMiddle } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import type { NetworkEntry } from '../../shared/protocol';

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

function methodTone(method: string): string {
	if (method === 'GET') return 'border-blue-400/25 bg-blue-400/10 text-blue-300';
	if (method === 'POST')
		return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300';
	if (method === 'DELETE') return 'border-red-400/25 bg-red-400/10 text-red-300';
	return 'border-amber-400/25 bg-amber-400/10 text-amber-300';
}

function statusTone(entry: NetworkEntry): 'success' | 'warning' | 'danger' | 'info' {
	if (entry.state === 'pending') return 'info';
	if (entry.state === 'error' || (entry.status ?? 0) >= 400) return 'danger';
	if ((entry.status ?? 0) >= 300) return 'warning';
	return 'success';
}

function headersText(headers: Record<string, string> | undefined): string {
	if (!headers || Object.keys(headers).length === 0) return 'No captured headers.';
	return Object.entries(headers)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}: ${value}`)
		.join('\n');
}

export function NetworkPanel() {
	const { canRunAction, selectedDevice, runAction } = useDesktopRuntime();
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
	const [selectedId, setSelectedId] = useState<string | null>(entries[0]?.id ?? null);
	const [detailTab, setDetailTab] = useState<DetailTab>('overview');
	const currentProfile = selectedDevice?.tools.networkProfile;
	const [profileId, setProfileId] = useState<NetworkProfileId>(
		currentProfile?.id === 'none' || !currentProfile?.id
			? 'lte'
			: (currentProfile.id as NetworkProfileId)
	);
	const paused = pausedEntries !== null;
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
				return (
					!needle ||
					[entry.method, entry.url, entry.host, entry.path, entry.status, entry.source]
						.join(' ')
						.toLowerCase()
						.includes(needle)
				);
			})
			.sort((left, right) => right.at - left.at);
	}, [entries, filter, query]);

	const selected =
		filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null;
	const columns = useMemo<DataGridColumn<NetworkEntry>[]>(
		() => [
			{
				id: 'method',
				header: 'Method',
				width: 88,
				isRowHeader: true,
				cell: (entry) => (
					<span
						className={`inline-flex h-5 items-center rounded border px-1.5 font-mono text-xs font-semibold ${methodTone(entry.method)}`}
					>
						{entry.method}
					</span>
				),
			},
			{
				id: 'request',
				header: 'Request',
				minWidth: 340,
				cell: (entry) => (
					<div className="min-w-0 py-0.5">
						<div className="truncate font-mono text-xs text-(--foreground)">
							{entry.path}
						</div>
						<div className="mt-0.5 truncate text-xs text-(--text-3)">
							{entry.host} {entry.source ? `· ${entry.source}` : ''}
						</div>
					</div>
				),
			},
			{
				id: 'status',
				header: 'Status',
				width: 92,
				cell: (entry) => (
					<StatusPill tone={statusTone(entry)}>
						{entry.state === 'pending' ? 'Pending' : (entry.status ?? entry.state)}
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
		[]
	);

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
					<span className="flex items-center gap-1.5 text-emerald-300">
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
								void runAction('network', 'clear', {}, 'Network buffer cleared.').then(
									(result) => {
										if (result.ok && paused) {
											setPausedSnapshot((current) =>
												current?.deviceId === deviceId
													? { deviceId, entries: [] }
													: current
											);
										}
									}
								);
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
					onChange={setQuery}
				/>
				<div className="flex items-center gap-1">
					{(['all', 'errors', 'slow', 'supabase'] as const).map((value) => (
						<Button
							aria-pressed={filter === value}
							className="h-7 rounded-md px-2.5 text-xs capitalize"
							key={value}
							size="sm"
							variant={filter === value ? 'secondary' : 'ghost'}
							onPress={() => setFilter(value)}
						>
							{value}
						</Button>
					))}
				</div>
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
				<span className="ml-auto shrink-0 font-mono text-xs text-(--text-3)">
					{filtered.length} of {entries.length} requests
				</span>
			</Toolbar>
			<PanelNotice
				title={
					currentProfile?.active
						? `${currentProfile.name} is active · PUMPD requests only`
						: 'Network simulation is off'
				}
				tone="info"
			>
				{currentProfile?.active
					? `${currentProfile.name} is active for instrumented PUMPD fetch only. `
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

function NetworkDetail({
	entry,
	tab,
	onTabChange,
}: {
	entry: NetworkEntry;
	tab: DetailTab;
	onTabChange: (tab: DetailTab) => void;
}) {
	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-white/8 p-4">
				<div className="mb-3 flex items-center gap-2">
					<span
						className={`rounded border px-1.5 py-0.5 font-mono text-xs font-semibold ${methodTone(entry.method)}`}
					>
						{entry.method}
					</span>
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
				{(['overview', 'headers', 'request', 'response'] as const).map((value) => (
					<button
						aria-pressed={tab === value}
						className={`h-9 border-b text-xs capitalize transition-colors ${tab === value ? 'border-white text-white' : 'border-transparent text-(--text-3) hover:text-(--muted)'}`}
						key={value}
						type="button"
						onClick={() => onTabChange(value)}
					>
						{value}
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1 overflow-auto p-4">
				{tab === 'overview' ? (
					<dl className="m-0">
						<KeyValue label="Host" value={entry.host} mono />
						<KeyValue label="Path" value={entry.path} mono />
						<KeyValue label="Source" value={entry.source ?? 'fetch'} />
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
						<KeyValue label="Duration" value={formatDuration(entry.durationMs)} mono />
						{entry.error ? (
							<div className="mt-4 rounded-md border border-red-400/20 bg-red-400/8 p-3 text-xs leading-5 text-red-300">
								{entry.error}
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
					<CodePreview label="Request body" value={entry.requestBody} maxHeight={520} />
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
