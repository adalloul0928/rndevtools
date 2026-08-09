import { type ComponentType, lazy, type ReactNode, Suspense } from 'react';
import { EmptyState, PanelScaffold } from '../components/panel-ui';
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
					<PanelScaffold onBack={props.onBack} title={metadata.title}>
						<EmptyState>Loading tool…</EmptyState>
					</PanelScaffold>
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
