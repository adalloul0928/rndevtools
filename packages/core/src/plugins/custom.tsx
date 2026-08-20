import { type ComponentType, lazy, type ReactNode, Suspense } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { PanelShell } from '../components/panel-shell';
import { colors } from '../components/panel-ui';
import type {
	DevToolsActionConfirmation,
	DevToolsActionContext,
	DevToolsActionPlugin,
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsPluginMetadata,
} from '../types';

export type CustomPluginOptions = DevToolsPluginMetadata & {
	render: (props: DevToolsPanelProps) => ReactNode;
};

export type ActionPluginOptions = DevToolsPluginMetadata & {
	confirmation?: DevToolsActionConfirmation;
	action: (context: DevToolsActionContext) => void | Promise<void>;
};

export type LazyCustomPluginOptions = DevToolsPluginMetadata & {
	load: () => Promise<ComponentType<DevToolsPanelProps>>;
};

export function createCustomPlugin({
	render,
	...metadata
}: CustomPluginOptions): DevToolsPanelPlugin {
	function CustomPanel(props: DevToolsPanelProps) {
		return <>{render(props)}</>;
	}

	return {
		...metadata,
		kind: 'panel',
		Panel: CustomPanel,
	};
}

export function createActionPlugin({
	action,
	...metadata
}: ActionPluginOptions): DevToolsActionPlugin {
	return {
		...metadata,
		kind: 'action',
		onPress: action,
	};
}

export function createLazyCustomPlugin({
	load,
	...metadata
}: LazyCustomPluginOptions): DevToolsPanelPlugin {
	const LazyPanel = lazy(async () => ({ default: await load() }));

	function LazyCustomPanel(props: DevToolsPanelProps) {
		return (
			<Suspense
				fallback={
					<PanelShell onBack={props.onBack} title={metadata.title}>
						<View
							accessible
							accessibilityLabel={`Loading ${metadata.title}`}
							accessibilityRole="progressbar"
							style={styles.loading}
						>
							<ActivityIndicator color={colors.blue} />
						</View>
					</PanelShell>
				}
			>
				<LazyPanel {...props} />
			</Suspense>
		);
	}

	return {
		...metadata,
		kind: 'panel',
		Panel: LazyCustomPanel,
	};
}

const styles = StyleSheet.create({
	loading: {
		alignItems: 'center',
		justifyContent: 'center',
		minHeight: 160,
	},
});
