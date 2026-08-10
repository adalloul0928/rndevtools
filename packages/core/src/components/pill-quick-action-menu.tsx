import {
	Divider,
	Host,
	Image,
	Menu,
	Button as NativeMenuButton,
} from '@expo/ui/swift-ui';
import { accessibilityLabel, frame } from '@expo/ui/swift-ui/modifiers';
import { useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import type {
	DevToolsActionServices,
	DevToolsPluginWithPillQuickAction,
} from '../types';
import { colors } from './panel-ui';

const subscribeToNothing = () => () => {};
const getNoSelection = () => null;

type PillQuickActionMenuProps = {
	plugin: DevToolsPluginWithPillQuickAction;
	actions: DevToolsActionServices;
	onUnpin: () => void;
};

export function PillQuickActionMenu({
	plugin,
	actions,
	onUnpin,
}: PillQuickActionMenuProps) {
	const { pillQuickAction } = plugin;
	const selectedOptionId = useSyncExternalStore(
		pillQuickAction.subscribe ?? subscribeToNothing,
		pillQuickAction.getSelectedOptionId ?? getNoSelection,
		pillQuickAction.getSelectedOptionId ?? getNoSelection,
	);

	return (
		<View
			style={styles.container}
			testID={`devtools-pill-quick-action-${plugin.id}`}
		>
			<Host style={styles.host}>
				<Menu
					label={
						<Image
							color={colors.blue}
							modifiers={[
								frame({ width: 42, height: 48 }),
								accessibilityLabel(`${plugin.title} quick actions`),
							]}
							size={17}
							systemName={pillQuickAction.systemImage ?? plugin.systemImage}
						/>
					}
				>
					{pillQuickAction.options.map((option) => (
						<NativeMenuButton
							key={option.id}
							label={option.label}
							onPress={() => {
								void actions.run({
									pluginId: plugin.id,
									label: option.label,
									confirmation: option.confirmation,
									action: option.action,
								});
							}}
							systemImage={
								option.id === selectedOptionId
									? 'checkmark'
									: option.systemImage
							}
						/>
					))}
					<Divider />
					<NativeMenuButton
						label="Remove from Pill"
						onPress={onUnpin}
						systemImage="minus.circle"
					/>
				</Menu>
			</Host>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		borderLeftColor: colors.separator,
		borderLeftWidth: StyleSheet.hairlineWidth,
		height: 48,
		width: 42,
	},
	host: {
		flex: 1,
	},
});
