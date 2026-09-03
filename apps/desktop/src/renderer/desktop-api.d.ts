import type { DesktopBridge } from '../shared/protocol';

declare global {
	interface Window {
		pumpdDesktop?: DesktopBridge;
	}
}
