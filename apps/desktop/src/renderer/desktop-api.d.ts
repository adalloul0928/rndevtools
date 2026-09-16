import type { BuildInsightsBridge } from '../shared/build-insights-protocol';
import type { DesktopBridge } from '../shared/protocol';
import type { RecipeBridge } from '../shared/recipe-protocol';
import type { SimulatorBridge } from '../shared/simulator-protocol';
import type { SlimmingBridge } from '../shared/slimming-protocol';

declare global {
	interface Window {
		rnDevtools?: DesktopBridge &
			SimulatorBridge &
			SlimmingBridge &
			RecipeBridge &
			BuildInsightsBridge;
	}
}
