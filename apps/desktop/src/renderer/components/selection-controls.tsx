import { type KeyboardEvent, type ReactNode, useRef } from 'react';

type Choice<T extends string> = {
	value: T;
	label: ReactNode;
	ariaLabel?: string;
	disabled?: boolean;
};
type SelectionProps<T extends string> = {
	label: string;
	value: T;
	items: readonly Choice<T>[];
	onChange: (value: T) => void;
	className?: string;
	disabled?: boolean;
};

function SelectionControl<T extends string>({
	label,
	value,
	items,
	onChange,
	className = '',
	disabled = false,
	tabs,
}: SelectionProps<T> & { tabs?: { id: string; panelId: string } }) {
	const buttons = useRef(new Map<T, HTMLButtonElement>());
	const enabled = items.filter((item) => !disabled && !item.disabled);
	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		const current = enabled.findIndex(
			(item) => buttons.current.get(item.value) === event.target
		);
		if (current < 0) return;
		const next =
			event.key === 'ArrowRight'
				? enabled[(current + 1) % enabled.length]
				: event.key === 'ArrowLeft'
					? enabled[(current + enabled.length - 1) % enabled.length]
					: event.key === 'Home'
						? enabled[0]
						: event.key === 'End'
							? enabled.at(-1)
							: undefined;
		if (!next) return;
		event.preventDefault();
		onChange(next.value);
		buttons.current.get(next.value)?.focus();
	};
	const content = items.map((item) => (
		<button
			key={item.value}
			ref={(node) => {
				if (node) buttons.current.set(item.value, node);
				else buttons.current.delete(item.value);
			}}
			type="button"
			className={tabs ? 'ui-tab' : 'segmented-button'}
			aria-label={item.ariaLabel}
			disabled={disabled || item.disabled}
			{...(tabs
				? {
						role: 'tab',
						id: `${tabs.id}-${item.value}`,
						'aria-controls': tabs.panelId,
						'aria-selected': value === item.value,
					}
				: { 'aria-pressed': value === item.value })}
			tabIndex={
				value === item.value ||
				(!enabled.some((choice) => choice.value === value) &&
					enabled[0]?.value === item.value)
					? 0
					: -1
			}
			onKeyDown={onKeyDown}
			onClick={() => onChange(item.value)}
		>
			{item.label}
		</button>
	));
	return tabs ? (
		<div aria-label={label} className={`ui-tabs ${className}`} role="tablist">
			{content}
		</div>
	) : (
		<div
			aria-label={label}
			className={`segmented-control ${className}`}
			role="group"
		>
			{content}
		</div>
	);
}

export function SegmentedControl<T extends string>(props: SelectionProps<T>) {
	return <SelectionControl {...props} />;
}

/** The caller's panel uses panelId and aria-labelledby={`${id}-${value}`}. */
export function Tabs<T extends string>(
	props: SelectionProps<T> & { id: string; panelId: string }
) {
	return (
		<SelectionControl
			{...props}
			tabs={{ id: props.id, panelId: props.panelId }}
		/>
	);
}
