import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	UpdateOperation,
	UpdateState,
} from '../../shared/update-protocol';

export function useUpdates() {
	const [state, setState] = useState<UpdateState | null>(null);
	const revision = useRef(0);
	useEffect(() => {
		const bridge = window.rnDevtools;
		if (!bridge?.getUpdateState) return;
		let active = true;
		const initialRevision = revision.current;
		const unsubscribe = bridge.subscribeUpdateState((next) => {
			revision.current++;
			if (active) setState(next);
		});
		void bridge
			.getUpdateState()
			.then((next) => {
				if (active && revision.current === initialRevision) setState(next);
			})
			.catch(() => {
				if (active && revision.current === initialRevision)
					setState({
						status: 'error',
						currentVersion: '',
						error: 'Could not contact the updater. Try again.',
					});
			});
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);
	const run = useCallback(async (operation: UpdateOperation) => {
		const before = revision.current;
		try {
			const next = await window.rnDevtools?.runUpdateOperation(operation);
			if (next && before === revision.current) setState(next);
		} catch {
			if (before !== revision.current) return;
			setState((previous) =>
				previous
					? {
							...previous,
							status: 'error',
							error: 'Could not contact the updater. Try again.',
						}
					: previous
			);
		}
	}, []);
	return { state, run };
}

export function updateAction(state: UpdateState): {
	label: string;
	operation: UpdateOperation;
	disabled: boolean;
} {
	switch (state.status) {
		case 'available':
			return {
				label: 'Update available',
				operation: 'download',
				disabled: false,
			};
		case 'downloading':
			return {
				label: `Downloading ${state.percent ?? 0}%`,
				operation: 'download',
				disabled: true,
			};
		case 'verifying':
			return {
				label: 'Verifying update…',
				operation: 'download',
				disabled: true,
			};
		case 'ready':
			return {
				label: 'Restart to update',
				operation: 'install',
				disabled: false,
			};
		case 'installing':
			return { label: 'Restarting…', operation: 'install', disabled: true };
		case 'checking':
			return { label: 'Checking…', operation: 'check', disabled: true };
		case 'error':
			return { label: 'Retry update', operation: 'check', disabled: false };
		default:
			return {
				label: 'Check for updates',
				operation: 'check',
				disabled: state.status === 'unsupported',
			};
	}
}
