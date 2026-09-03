import { AlertDialog } from '@heroui/react/alert-dialog';
import { Button } from '@heroui/react/button';
import { SearchField } from '@heroui/react/search-field';
import { Tooltip } from '@heroui/react/tooltip';
import { EmptyState } from '@heroui-pro/react/empty-state';
import {
	AlertTriangle,
	ChevronRight,
	CircleX,
	Copy,
	Info,
	Search,
	X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { statusToneClassName } from '@/components/status-ui';
import { copyText } from '@/lib/format';

export { StatusPill } from '@/components/status-ui';

export function PanelHeader({
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
		<header className="panel-header">
			<div className="min-w-0">
				<div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.09em] text-(--text-3)">
					<span>{eyebrow}</span>
					{meta ? (
						<>
							<span className="text-white/20">/</span>
							{meta}
						</>
					) : null}
				</div>
				<h1 className="m-0 truncate text-xl font-semibold tracking-[-0.035em] text-(--foreground)">
					{title}
				</h1>
				<p className="mb-0 mt-1 max-w-[740px] text-xs leading-5 text-(--muted)">
					{description}
				</p>
			</div>
			{actions ? (
				<div className="flex shrink-0 items-center gap-2">{actions}</div>
			) : null}
		</header>
	);
}

export function Toolbar({ children }: { children: ReactNode }) {
	return <div className="panel-toolbar">{children}</div>;
}

export function PanelNotice({
	title,
	children,
	tone = 'warning',
}: {
	title: string;
	children: ReactNode;
	tone?: 'warning' | 'danger' | 'info';
}) {
	const Icon = tone === 'danger' ? CircleX : tone === 'info' ? Info : AlertTriangle;
	return (
		<div
			className={`flex shrink-0 items-start gap-2 border-b px-4 py-2.5 text-[10px] leading-5 ${statusToneClassName[tone]}`}
			role={tone === 'danger' ? 'alert' : 'status'}
		>
			<Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
			<div className="min-w-0">
				<strong className="mr-1.5 font-semibold">{title}</strong>
				<span className="break-words">{children}</span>
			</div>
		</div>
	);
}

export function SearchControl({
	value,
	onChange,
	placeholder = 'Search',
	ariaLabel = 'Search',
	className = '',
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	ariaLabel?: string;
	className?: string;
}) {
	return (
		<SearchField
			aria-label={ariaLabel}
			className={`w-[260px] ${className}`}
			value={value}
			onChange={onChange}
		>
			<SearchField.Group className="h-8 rounded-md border border-white/10 bg-black/30 shadow-none transition-colors focus-within:border-white/25">
				<Search className="ml-2.5 h-3.5 w-3.5 text-(--text-3)" aria-hidden="true" />
				<SearchField.Input
					className="h-full min-w-0 flex-1 bg-transparent px-2 text-xs text-(--foreground) outline-none placeholder:text-(--text-3)"
					placeholder={placeholder}
				/>
				<SearchField.ClearButton className="mr-1 grid h-6 w-6 place-items-center rounded text-(--text-3) hover:bg-white/8 hover:text-(--foreground)">
					<X className="h-3.5 w-3.5" />
				</SearchField.ClearButton>
			</SearchField.Group>
		</SearchField>
	);
}

export function EmptyPanel({
	icon,
	title,
	description,
	action,
}: {
	icon?: ReactNode;
	title: string;
	description: string;
	action?: ReactNode;
}) {
	return (
		<EmptyState
			className="mx-auto min-h-[360px] max-w-md justify-center text-center"
			size="lg"
		>
			<EmptyState.Header>
				{icon ? <EmptyState.Media variant="icon">{icon}</EmptyState.Media> : null}
				<EmptyState.Title className="text-base text-(--foreground)">
					{title}
				</EmptyState.Title>
				<EmptyState.Description className="text-xs leading-5 text-(--muted)">
					{description}
				</EmptyState.Description>
			</EmptyState.Header>
			{action ? <EmptyState.Content>{action}</EmptyState.Content> : null}
		</EmptyState>
	);
}

export function CodePreview({
	value,
	label,
	maxHeight = 320,
}: {
	value: string | undefined;
	label?: string;
	maxHeight?: number;
}) {
	if (value === undefined) {
		return <p className="text-xs text-(--text-3)">No captured value.</p>;
	}
	const displayValue = value.length === 0 ? '∅ (empty string)' : value;
	return (
		<div className="overflow-hidden rounded-md border border-white/8 bg-black/35">
			{label ? (
				<div className="flex h-8 items-center justify-between border-b border-white/8 px-3 font-mono text-[10px] uppercase tracking-[0.06em] text-(--text-3)">
					<span>{label}</span>
					<CopyButton value={value} />
				</div>
			) : null}
			<pre
				className="m-0 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-[1.65] text-[#d4d4d4]"
				style={{ maxHeight }}
			>
				{displayValue}
			</pre>
		</div>
	);
}

export function CopyButton({
	value,
	label = 'Copy',
}: {
	value: string;
	label?: string;
}) {
	const [lastCopy, setLastCopy] = useState<{
		value: string;
		ok: boolean;
	} | null>(null);
	const result = lastCopy?.value === value ? lastCopy.ok : undefined;
	const feedback =
		result === true ? 'Copied' : result === false ? 'Copy failed' : label;
	useEffect(() => {
		if (!lastCopy || lastCopy.value !== value) return;
		const timer = window.setTimeout(() => setLastCopy(null), 1_800);
		return () => window.clearTimeout(timer);
	}, [lastCopy, value]);
	return (
		<Tooltip delay={400}>
			<Button
				aria-label={feedback}
				className="h-6 min-w-6 rounded p-0 text-(--text-3) hover:bg-white/8 hover:text-(--foreground)"
				isIconOnly
				variant="ghost"
				onPress={() => {
					void copyText(value).then((ok) => setLastCopy({ value, ok }));
				}}
			>
				<Copy className="h-3.5 w-3.5" />
			</Button>
			<Tooltip.Content>{feedback}</Tooltip.Content>
		</Tooltip>
	);
}

export function KeyValue({
	label,
	value,
	mono = false,
}: {
	label: string;
	value: ReactNode;
	mono?: boolean;
}) {
	return (
		<div className="grid grid-cols-[132px_minmax(0,1fr)] gap-4 border-b border-white/[0.06] py-2.5 last:border-0">
			<dt className="text-xs text-(--text-3)">{label}</dt>
			<dd
				className={`m-0 min-w-0 break-words text-xs text-(--foreground) ${mono ? 'font-mono text-[11px]' : ''}`}
			>
				{value}
			</dd>
		</div>
	);
}

export function ConfirmAction({
	triggerLabel,
	title,
	description,
	confirmLabel,
	onConfirm,
	tone = 'danger',
	triggerVariant = 'ghost',
	triggerIcon,
	isDisabled = false,
}: {
	triggerLabel: string;
	title: string;
	description: string;
	confirmLabel: string;
	onConfirm: () => void;
	tone?: 'warning' | 'danger';
	triggerVariant?: 'ghost' | 'secondary' | 'primary' | 'danger';
	triggerIcon?: ReactNode;
	isDisabled?: boolean;
}) {
	const Icon = tone === 'danger' ? CircleX : AlertTriangle;
	return (
		<AlertDialog>
			<AlertDialog.Trigger>
				<Button isDisabled={isDisabled} size="sm" variant={triggerVariant}>
					{triggerIcon}
					{triggerLabel}
				</Button>
			</AlertDialog.Trigger>
			<AlertDialog.Backdrop className="bg-black/70 backdrop-blur-sm">
				<AlertDialog.Container className="border border-white/12 bg-[#0b0b0b] shadow-2xl">
					<AlertDialog.Dialog>
						<AlertDialog.Header>
							<AlertDialog.Icon status={tone}>
								<Icon className="h-5 w-5" />
							</AlertDialog.Icon>
							<AlertDialog.Heading>{title}</AlertDialog.Heading>
						</AlertDialog.Header>
						<AlertDialog.Body>{description}</AlertDialog.Body>
						<AlertDialog.Footer>
							<Button size="sm" slot="close" variant="ghost">
								Cancel
							</Button>
							<Button
								{...(tone === 'warning'
									? { className: 'bg-amber-600 text-white hover:bg-amber-500' }
									: {})}
								onPress={onConfirm}
								size="sm"
								slot="close"
								variant={tone === 'danger' ? 'danger' : 'primary'}
							>
								{confirmLabel}
							</Button>
						</AlertDialog.Footer>
					</AlertDialog.Dialog>
				</AlertDialog.Container>
			</AlertDialog.Backdrop>
		</AlertDialog>
	);
}

export function DetailPlaceholder({
	label = 'Select a row to inspect',
}: {
	label?: string;
}) {
	return (
		<div className="grid h-full place-items-center p-8 text-center">
			<div>
				<ChevronRight className="mx-auto mb-3 h-5 w-5 text-white/20" />
				<p className="m-0 text-xs text-(--text-3)">{label}</p>
			</div>
		</div>
	);
}
