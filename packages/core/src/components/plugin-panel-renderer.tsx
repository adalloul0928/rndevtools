import { Component, type ErrorInfo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { RectButton } from 'react-native-gesture-handler';
import type { DevToolsPanelPlugin, DevToolsPanelProps } from '../types';
import { colors, PanelScaffold } from './panel-ui';

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
					<View style={styles.errorCard}>
						<Text style={styles.errorTitle}>
							This tool encountered an error.
						</Text>
						<Text selectable style={styles.errorMessage}>
							{error.message}
						</Text>
						<RectButton
							accessibilityRole="button"
							onPress={panelProps.onBack}
							style={styles.button}
						>
							<Text style={styles.buttonText}>Return to tools</Text>
						</RectButton>
					</View>
				</PanelScaffold>
			);
		}

		return <plugin.Panel {...panelProps} />;
	}
}

export function PluginPanelRenderer(props: PluginPanelRendererProps) {
	return <PluginPanelBoundary key={props.plugin.id} {...props} />;
}

const styles = StyleSheet.create({
	errorCard: {
		backgroundColor: colors.card,
		borderRadius: 16,
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
	button: {
		alignItems: 'center',
		backgroundColor: colors.blue,
		borderRadius: 12,
		marginTop: 4,
		paddingHorizontal: 14,
		paddingVertical: 11,
	},
	buttonText: {
		color: colors.onAccent,
		fontSize: 14,
		fontWeight: '700',
	},
});
