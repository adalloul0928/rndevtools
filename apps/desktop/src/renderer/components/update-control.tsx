import { Button } from '@heroui/react/button';
import { Tooltip } from '@heroui/react/tooltip';
import { Download, RotateCw } from 'lucide-react';
import { updateAction, useUpdates } from '@/lib/updates';

export function UpdateControl({ settings = false }: { settings?: boolean }) {
	const { state, run } = useUpdates();
	if (!state) return null;
	const action = updateAction(state);
	const visible =
		['available', 'downloading', 'verifying', 'ready', 'installing'].includes(
			state.status
		) ||
		(state.status === 'error' && state.version);
	if (!settings && !visible) return null;
	const control =
		state.status === 'unsupported' ? null : (
			<Tooltip delay={500}>
				<Button
					className={settings ? '' : 'titlebar-update no-drag'}
					size="sm"
					variant="secondary"
					isDisabled={action.disabled}
					onPress={() => void run(action.operation)}
				>
					{state.status === 'ready' || state.status === 'installing' ? (
						<RotateCw aria-hidden="true" className="h-3.5 w-3.5" />
					) : (
						<Download aria-hidden="true" className="h-3.5 w-3.5" />
					)}
					{action.label}
				</Button>
				<Tooltip.Content>
					{state.error ??
						(state.version
							? `RN Devtools ${state.version}`
							: 'Check for a newer release')}
				</Tooltip.Content>
			</Tooltip>
		);
	if (!settings) return control;
	return (
		<section className="sim-surface">
			<header className="sim-surface-header">
				<h2>Updates</h2>
			</header>
			<div className="sim-capability-list">
				<div className="sim-capability-row">
					<span className="sim-capability-icon">
						<Download className="h-4 w-4" />
					</span>
					<div className="sim-capability-copy">
						<strong>RN Devtools {state.currentVersion}</strong>
						<p role="status">
							{state.status === 'unsupported'
								? 'Updates are available in the installed macOS release.'
								: (state.error ??
									(state.status === 'current'
										? 'You’re up to date.'
										: state.version
											? `Version ${state.version} ${state.status === 'ready' ? 'is ready to install.' : 'is available.'}`
											: 'Checks for published releases automatically.'))}
						</p>
					</div>
					{control}
				</div>
			</div>
		</section>
	);
}
