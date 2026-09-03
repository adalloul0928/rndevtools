import { Alert } from 'react-native';
import type {
	DevToolsActionConfirmation,
	DevToolsActionRequest,
	DevToolsActionServices,
	DevToolsAuditEvent,
} from '../types';
import { normalizeActionRequest } from './action-validation';
import { diagnosticErrorText } from './redact';
import { truncateText } from './serialize';

type ActionServicesOptions = {
	onError?: (error: unknown, pluginId: string) => void;
	onAuditEvent?: (event: DevToolsAuditEvent) => void;
};

function confirmAction(
	confirmation: DevToolsActionConfirmation,
): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			Alert.alert(
				confirmation.title,
				confirmation.message,
				[
					{
						text: 'Cancel',
						style: 'cancel',
						onPress: () => resolve(false),
					},
					{
						text: confirmation.confirmLabel ?? 'Continue',
						style: confirmation.destructive ? 'destructive' : 'default',
						onPress: () => resolve(true),
					},
				],
				{
					cancelable: true,
					onDismiss: () => resolve(false),
				},
			);
		} catch {
			resolve(false);
		}
	});
}

export function createActionServices({
	onError,
	onAuditEvent,
}: ActionServicesOptions): DevToolsActionServices {
	const audit = (event: Omit<DevToolsAuditEvent, 'at'>) => {
		try {
			onAuditEvent?.({ ...event, at: Date.now() });
		} catch {
			// Host observability must never affect the requested operation.
		}
	};

	return {
		run: async (request: DevToolsActionRequest): Promise<boolean> => {
			const normalizedRequest = normalizeActionRequest(request);
			if (!normalizedRequest) {
				const error = new Error('Invalid developer-tools action request.');
				try {
					onError?.(error, 'unknown');
				} catch {
					// A faulty host reporter must not escape validation either.
				}
				return false;
			}
			request = normalizedRequest;
			if (
				request.confirmation &&
				!(await confirmAction(request.confirmation))
			) {
				audit({
					pluginId: request.pluginId,
					label: request.label,
					status: 'cancelled',
				});
				return false;
			}

			audit({
				pluginId: request.pluginId,
				label: request.label,
				status: 'started',
			});
			try {
				await request.action();
				audit({
					pluginId: request.pluginId,
					label: request.label,
					status: 'succeeded',
				});
				return true;
			} catch (error) {
				const message = truncateText(diagnosticErrorText(error), 8 * 1024).text;
				audit({
					pluginId: request.pluginId,
					label: request.label,
					status: 'failed',
					error: message,
				});
				try {
					onError?.(error, request.pluginId);
				} catch {
					// A faulty host reporter must not escape an action failure boundary.
				}
				try {
					Alert.alert(`${request.label} failed`, message);
				} catch {
					// Alerts are best-effort on unsupported/test renderers.
				}
				return false;
			}
		},
	};
}
