import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Tooltip } from '@heroui/react/tooltip';
import { ListView } from '@heroui-pro/react/list-view';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	ArrowRight,
	ChevronDown,
	CircleAlert,
	RefreshCw,
	Smartphone,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyPanel, PanelHeader } from '@/components/ui';
import { useSimulatorRuntime } from '@/state/simulator-runtime';
import type { SimulatorDevice } from '../../shared/simulator-protocol';

export function SimulatorPanelHeader({
	eyebrow,
	title,
	description,
	meta,
	actions,
}: {
	eyebrow: string;
	title: string;
	description: string;
	meta?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<PanelHeader
			actions={actions}
			description={description}
			eyebrow={`Simulator / ${eyebrow}`}
			meta={meta}
			title={title}
		/>
	);
}

export function RefreshSimulatorsButton({ compact = false }: { compact?: boolean }) {
	const { isBridgeAvailable, isLoading, refresh } = useSimulatorRuntime();
	return (
		<Tooltip delay={500}>
			<Button
				aria-label="Refresh Simulator targets"
				{...(compact ? { className: 'sim-icon-button' } : {})}
				isDisabled={!isBridgeAvailable || isLoading}
				isIconOnly={compact}
				size="sm"
				variant="secondary"
				onPress={() => void refresh()}
			>
				<RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
				{compact ? null : isLoading ? 'Scanning…' : 'Refresh'}
			</Button>
			<Tooltip.Content>
				{isBridgeAvailable
					? 'Refresh Simulator discovery'
					: 'Desktop bridge unavailable'}
			</Tooltip.Content>
		</Tooltip>
	);
}

export function SimulatorTargetSelect({ className = '' }: { className?: string }) {
	const { selectedDevice, setSelectedDeviceUdid, state } = useSimulatorRuntime();
	return (
		<NativeSelect className={`sim-target-select ${className}`} fullWidth={false}>
			<NativeSelect.Trigger
				aria-label="Simulator target"
				disabled={state.devices.length === 0}
				value={selectedDevice?.udid ?? ''}
				onChange={(event) => setSelectedDeviceUdid(event.currentTarget.value)}
			>
				{state.devices.length === 0 ? (
					<NativeSelect.Option value="">No target discovered</NativeSelect.Option>
				) : null}
				{state.devices.map((device) => (
					<NativeSelect.Option key={device.udid} value={device.udid}>
						{device.name} · {device.state}
					</NativeSelect.Option>
				))}
				<NativeSelect.Indicator>
					<ChevronDown className="h-3 w-3" />
				</NativeSelect.Indicator>
			</NativeSelect.Trigger>
		</NativeSelect>
	);
}

export function SimulatorMetric({
	label,
	value,
	detail,
	tone = 'default',
	icon,
}: {
	label: string;
	value: string;
	detail: string;
	tone?: 'default' | 'success' | 'warning' | 'info';
	icon?: ReactNode;
}) {
	return (
		<Card className={`sim-metric is-${tone}`} variant="secondary">
			<Card.Header className="sim-metric-header">
				<Card.Title className="sim-metric-label">{label}</Card.Title>
				{icon ? <span className="sim-metric-icon">{icon}</span> : null}
			</Card.Header>
			<Card.Content className="sim-metric-content">
				<strong>{value}</strong>
				<span>{detail}</span>
			</Card.Content>
		</Card>
	);
}

export function DenseVirtualList<T extends object>({
	ariaLabel,
	items,
	getId,
	renderItem,
	textValue,
	selectedId,
	selectedIds,
	onSelectedIdsChange,
	onSelect,
	emptyTitle = 'Nothing here yet',
	emptyDescription = 'Refresh discovery or change the current filters.',
	rowHeight = 48,
	className = '',
}: {
	ariaLabel: string;
	items: T[];
	getId: (item: T) => string;
	renderItem: (item: T) => ReactNode;
	textValue: (item: T) => string;
	selectedId?: string | null | undefined;
	selectedIds?: string[] | undefined;
	onSelectedIdsChange?: ((ids: string[]) => void) | undefined;
	onSelect?: (item: T) => void;
	emptyTitle?: string;
	emptyDescription?: string;
	rowHeight?: number;
	className?: string | undefined;
}) {
	const selectionMode = onSelectedIdsChange
		? 'multiple'
		: selectedId !== undefined && onSelect
			? 'single'
			: 'none';
	return (
		<ListView
			aria-label={ariaLabel}
			className={`sim-virtual-list ${className}`}
			items={items}
			selectionMode={selectionMode}
			selectionBehavior={selectionMode === 'multiple' ? 'toggle' : 'replace'}
			selectedKeys={selectedIds ?? (selectedId ? [selectedId] : [])}
			onSelectionChange={(keys) => {
				const selected = items.filter(
					(item) => keys === 'all' || keys.has(getId(item))
				);
				if (onSelectedIdsChange) onSelectedIdsChange(selected.map(getId));
				else if (selected[0]) onSelect?.(selected[0]);
			}}
			renderEmptyState={() => (
				<div className="sim-list-empty">
					<strong>{emptyTitle}</strong>
					<span>{emptyDescription}</span>
				</div>
			)}
			rowHeight={rowHeight}
			virtualized
		>
			{(item) => {
				const itemId = getId(item);
				const selected =
					selectionMode === 'multiple'
						? selectedIds?.includes(itemId)
						: selectedId === itemId;
				return (
					<ListView.Item
						aria-current={selectionMode === 'single' && selected ? 'true' : undefined}
						className={`sim-list-item ${selected ? 'is-selected' : ''}`}
						id={itemId}
						textValue={textValue(item)}
						{...(selectionMode === 'none' ? { onAction: () => onSelect?.(item) } : {})}
					>
						{renderItem(item)}
					</ListView.Item>
				);
			}}
		</ListView>
	);
}

export function TargetStatePill({ state }: { state: SimulatorDevice['state'] }) {
	const tone =
		state === 'booted'
			? 'success'
			: state === 'booting' || state === 'shuttingDown' || state === 'creating'
				? 'info'
				: state === 'unknown'
					? 'danger'
					: 'default';
	return (
		<span className={`sim-state-pill is-${tone}`}>
			{state === 'shuttingDown' ? 'shutting down' : state}
		</span>
	);
}

export function NoSimulatorTarget({ onOpenSettings }: { onOpenSettings?: () => void }) {
	return (
		<EmptyPanel
			action={
				<div className="flex items-center justify-center gap-2">
					<RefreshSimulatorsButton />
					{onOpenSettings ? (
						<Button size="sm" variant="ghost" onPress={onOpenSettings}>
							Review setup <ArrowRight className="h-3.5 w-3.5" />
						</Button>
					) : null}
				</div>
			}
			description="Install an iOS runtime in Xcode, then refresh discovery. A mobile app connection is not required."
			icon={<Smartphone className="h-5 w-5" />}
			title="No Simulator target discovered"
		/>
	);
}

export function BridgeUnavailableNotice() {
	const { runtimeError } = useSimulatorRuntime();
	if (!runtimeError) return null;
	return (
		<div className="sim-bridge-notice" role="alert">
			<CircleAlert className="h-3.5 w-3.5 shrink-0" />
			<div>
				<strong>Native controls unavailable</strong>
				<span>{runtimeError}</span>
			</div>
		</div>
	);
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const exponent = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1
	);
	const value = bytes / 1024 ** exponent;
	return `${value >= 100 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatDuration(durationMs: number): string {
	if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
	if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
	return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}
