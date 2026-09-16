import {
	createEmptyDesktopToolsSnapshot,
	type DesktopDeviceInfoSnapshot,
	type DesktopDeviceToolsSnapshot,
} from '@rndevtools/core/desktop-protocol';
import {
	type DesktopClientHandle,
	getDevtoolsAuthorization,
	shouldStartDesktopClient,
	startDesktopClient,
} from '@rndevtools/react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

/**
 * The desktop client is deliberately ignorant of this app. It handles
 * discovery, framing, replay protection, and admission control; the host
 * adapter below decides what a snapshot contains and what an action may do.
 */
function createDeviceInfo(): DesktopDeviceInfoSnapshot {
	return {
		id: `demo-${Constants.sessionId}`,
		name: Device.deviceName ?? 'Simulator',
		platform:
			Platform.OS === 'ios' || Platform.OS === 'android'
				? Platform.OS
				: 'unknown',
		model: Device.modelName ?? undefined,
		osVersion: Device.osVersion ?? undefined,
		appVersion: Constants.expoConfig?.version ?? '0.0.0',
		// Declaring no capabilities is what makes every privileged desktop
		// control inert for this demo. A host opts in one capability at a time.
		capabilities: [],
	};
}

function captureTools(): DesktopDeviceToolsSnapshot {
	// A real host spreads this and overrides the tools it actually collects:
	// { ...createEmptyDesktopToolsSnapshot(), network: myNetworkProjection }.
	// The desktop validates the whole shape, so every collection must be present.
	return createEmptyDesktopToolsSnapshot();
}

export function connectToDesktop(): DesktopClientHandle | undefined {
	// Never true for a build that reaches a tester: the broker socket is
	// unauthenticated loopback and belongs only on a developer's own machine.
	if (!shouldStartDesktopClient({ isDevelopmentBuild: __DEV__ }))
		return undefined;

	return startDesktopClient({
		host: {
			captureTools,
			createDeviceInfo,
			runAction: async (action) => {
				// Reject anything this app has not explicitly implemented. Throwing
				// is how a host refuses a desktop-issued action.
				throw new Error(`Unsupported action: ${action.tool}.${action.command}`);
			},
			getAuthorization: getDevtoolsAuthorization,
		},
	});
}
