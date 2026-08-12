import { Component, type ErrorInfo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DevToolsPanelPlugin, DevToolsPanelProps } from '../types';
import { PanelButton } from './panel-controls';
import {
	colors,
	PanelPresentationProvider,
	PanelScaffold,
	PanelSignalCard,
} from './panel-ui';

type PluginPanelRendererProps = {
	plugin: DevToolsPanelPlugin;
	panelProps: DevToolsPanelProps;
	onError?: (error: unknown, pluginId: string) => void;
};

type BoundaryProps = PluginPanelRendererProps;

type BoundaryState = {
	error: Error | null;
};

class PluginPanelBoundary extends Component<BoundaryProps, BoundaryState> {
	state: BoundaryState = { error: null };

	static getDerivedStateFromError(error: unknown): BoundaryState {
		return {
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}

	componentDidCatch(error: Error, _info: ErrorInfo): void {
		this.props.onError?.(error, this.props.plugin.id);
	}

	render() {
		const { error } = this.state;
		const { panelProps, plugin } = this.props;
		if (error) {
			return (
				<PanelScaffold
					onBack={panelProps.onBack}
					title={plugin.title}
					subtitle="Panel unavailable"
				>
					<PanelSignalCard
						description="The collector is still isolated; return to the tool list and try opening this panel again."
						eyebrow="Panel error"
						systemImage="exclamationmark.triangle.fill"
						title="This tool could not render"
						tone="danger"
					/>
					<View style={styles.errorCard}>
						<Text style={styles.errorTitle}>Technical detail</Text>
						<Text selectable style={styles.errorMessage}>
							{error.message}
						</Text>
						<PanelButton label="Return to tools" onPress={panelProps.onBack} />
					</View>
				</PanelScaffold>
			);
		}

		return <plugin.Panel {...panelProps} />;
	}
}

export function PluginPanelRenderer(props: PluginPanelRendererProps) {
	return (
		<PanelPresentationProvider
			mode={props.panelProps.presentationMode}
			safeAreaTop={props.panelProps.safeAreaTop}
		>
			<PluginPanelBoundary key={props.plugin.id} {...props} />
		</PanelPresentationProvider>
	);
}

const styles = StyleSheet.create({
	errorCard: {
		backgroundColor: colors.card,
		borderColor: colors.separator,
		borderRadius: 12,
		borderWidth: StyleSheet.hairlineWidth,
		gap: 10,
		padding: 16,
	},
	errorTitle: {
		color: colors.label,
		fontSize: 16,
		fontWeight: '700',
	},
	errorMessage: {
		color: colors.red,
		fontFamily: 'Menlo',
		fontSize: 12,
		lineHeight: 18,
	},
});
