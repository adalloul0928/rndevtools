import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { DesktopErrorBoundary } from './components/error-boundary';
import { DesktopRuntimeProvider } from './state/desktop-runtime';

const root = document.getElementById('root');
if (!root) throw new Error('Desktop root element was not found.');

createRoot(root).render(
	<StrictMode>
		<DesktopErrorBoundary>
			<DesktopRuntimeProvider>
				<App />
			</DesktopRuntimeProvider>
		</DesktopErrorBoundary>
	</StrictMode>
);
