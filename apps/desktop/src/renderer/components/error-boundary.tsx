import { Button } from '@heroui/react/button';
import { diagnosticErrorText } from '@rndevtools/core/redact';
import { CircleAlert, RotateCcw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

type ErrorBoundaryState = {
	error: Error | null;
};

export class DesktopErrorBoundary extends Component<
	{ children: ReactNode },
	ErrorBoundaryState
> {
	override state: ErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { error };
	}

	override componentDidCatch(_error: Error, _info: ErrorInfo): void {
		// The fallback is intentionally local. Renderer details never cross into
		// the device broker or an external telemetry service automatically.
	}

	override render(): ReactNode {
		if (!this.state.error) return this.props.children;
		return (
			<main className="fatal-error" role="alert">
				<div className="fatal-error-icon">
					<CircleAlert className="h-5 w-5" />
				</div>
				<p className="fatal-error-eyebrow">Renderer failure</p>
				<h1>RN Devtools could not render this view</h1>
				<p>{diagnosticErrorText(this.state.error).slice(0, 8 * 1024)}</p>
				<Button variant="secondary" onPress={() => window.location.reload()}>
					<RotateCcw className="h-3.5 w-3.5" /> Reload desktop app
				</Button>
			</main>
		);
	}
}
