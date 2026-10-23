import type { IpcMainInvokeEvent } from 'electron';
import { updateOperationSchema } from '../shared/update-protocol';
import type { UpdateService } from './update-service';

export function createUpdateIpcHandlers(
	service: UpdateService,
	assertTrustedRenderer: (event: IpcMainInvokeEvent) => void
) {
	return {
		getState(event: IpcMainInvokeEvent) {
			assertTrustedRenderer(event);
			return service.getState();
		},
		runOperation(event: IpcMainInvokeEvent, value: unknown) {
			assertTrustedRenderer(event);
			return service.run(updateOperationSchema.parse(value));
		},
	};
}
