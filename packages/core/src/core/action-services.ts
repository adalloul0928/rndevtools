import { Alert } from 'react-native';
import type {
	DevToolsActionConfirmation,
	DevToolsActionRequest,
	DevToolsActionServices,
	DevToolsAuditEvent,
} from '../types';

type ActionServicesOptions = {
	onError?: (error: unknown, pluginId: string) => void;
	onAuditEvent?: (event: DevToolsAuditEvent) => void;
};

function confirmAction(
	confirmation: DevToolsActionConfirmation,
): Promise<boolean> {
	return new Promise((resolve) => {
		Alert.alert(confirmation.title, confirmation.message, [
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
		]);
	});
}

export function createActionServices({
	onError,
	onAuditEvent,
}: ActionServicesOptions): DevToolsActionServices {
	const audit = (event: Omit<DevToolsAuditEvent, 'at'>) => {
		onAuditEvent?.({ ...event, at: Date.now() });
	};

	return {
		run: async (request: DevToolsActionRequest): Promise<boolean> => {
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
				const message = error instanceof Error ? error.message : String(error);
				audit({
					pluginId: request.pluginId,
					label: request.label,
					status: 'failed',
					error: message,
				});
				onError?.(error, request.pluginId);
				Alert.alert(`${request.label} failed`, message);
				return false;
			}
		},
	};
}
