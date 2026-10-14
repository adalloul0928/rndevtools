import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { DesktopErrorBoundary } from './components/error-boundary';
import { DesktopRuntimeProvider } from './state/desktop-runtime';
import { LaneRuntimeProvider } from './state/lane-runtime';
import { RecipeRuntimeProvider } from './state/recipe-runtime';
import { SimulatorRuntimeProvider } from './state/simulator-runtime';
import { SimulatorStreamProvider } from './state/simulator-stream-runtime';
import { SlimmingRuntimeProvider } from './state/slimming-runtime';

const root = document.getElementById('root');
if (!root) throw new Error('Desktop root element was not found.');

createRoot(root).render(
	<StrictMode>
		<DesktopErrorBoundary>
			<DesktopRuntimeProvider>
				<SimulatorRuntimeProvider>
					<SlimmingRuntimeProvider>
						<RecipeRuntimeProvider>
							<LaneRuntimeProvider>
								<SimulatorStreamProvider>
									<App />
								</SimulatorStreamProvider>
							</LaneRuntimeProvider>
						</RecipeRuntimeProvider>
					</SlimmingRuntimeProvider>
				</SimulatorRuntimeProvider>
			</DesktopRuntimeProvider>
		</DesktopErrorBoundary>
	</StrictMode>
);
