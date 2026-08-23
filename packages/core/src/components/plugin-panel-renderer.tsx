import {
	Button,
	ContentUnavailableView,
	Host,
	List,
	Section,
	Text as UIText,
} from '@expo/ui/swift-ui';
import { foregroundStyle, listStyle } from '@expo/ui/swift-ui/modifiers';
import { Component, type ErrorInfo } from 'react';
import { Platform, PlatformColor, Pressable, Text } from 'react-native';
import type { DevToolsPanelPlugin, DevToolsPanelProps } from '../types';
import { PanelShell } from './panel-shell';

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
				<PanelShell onBack={panelProps.onBack} title={plugin.title}>
					{Platform.OS === 'ios' ? (
						<Host style={{ flex: 1 }}>
							<List modifiers={[listStyle('insetGrouped')]}>
								<Section>
									<ContentUnavailableView
										description="The collector is still isolated; return to the tool list and try opening this panel again."
										systemImage="exclamationmark.triangle.fill"
										title="This tool could not render"
									/>
								</Section>
								<Section title="Technical detail">
									<UIText
										modifiers={[
											foregroundStyle(PlatformColor('systemRedColor')),
										]}
									>
										{error.message}
									</UIText>
								</Section>
								<Section>
									<Button label="Return to tools" onPress={panelProps.onBack} />
								</Section>
							</List>
						</Host>
					) : (
						<Pressable accessibilityRole="button" onPress={panelProps.onBack}>
							<Text>{`This tool could not render: ${error.message}`}</Text>
						</Pressable>
					)}
				</PanelShell>
			);
		}

		return <plugin.Panel {...panelProps} />;
	}
}

export function PluginPanelRenderer(props: PluginPanelRendererProps) {
	return <PluginPanelBoundary key={props.plugin.id} {...props} />;
}
