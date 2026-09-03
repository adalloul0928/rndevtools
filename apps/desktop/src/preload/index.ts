import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc';
import {
	type DesktopAction,
	type DesktopActionResult,
	type DesktopBootstrap,
	type DesktopBridge,
	type DesktopState,
	desktopActionResultSchema,
	desktopActionSchema,
	desktopBootstrapSchema,
	desktopStateSchema,
} from '../shared/protocol';

const bridge: DesktopBridge = {
	getBootstrap: async () =>
		desktopBootstrapSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getBootstrap)
		) as DesktopBootstrap,
	subscribe: (listener: (state: DesktopState) => void) => {
		if (typeof listener !== 'function') {
			throw new TypeError('Desktop state listener must be a function.');
		}
		const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => {
			const parsed = desktopStateSchema.safeParse(state);
			if (!parsed.success) return;
			try {
				listener(parsed.data);
			} catch {
				// A renderer callback must not break the isolated IPC event handler.
			}
		};
		ipcRenderer.on(IPC_CHANNELS.stateChanged, wrapped);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.stateChanged, wrapped);
	},
	runAction: async (action: DesktopAction) => {
		const validatedAction = desktopActionSchema.parse(action);
		return desktopActionResultSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.runAction, validatedAction)
		) as DesktopActionResult;
	},
};

contextBridge.exposeInMainWorld('pumpdDesktop', Object.freeze(bridge));
