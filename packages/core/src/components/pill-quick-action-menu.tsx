import { MenuView } from '@expo/ui/community/menu';
import {
	Divider,
	Host,
	Image,
	Menu,
	Button as NativeMenuButton,
} from '@expo/ui/swift-ui';
import { accessibilityLabel, frame } from '@expo/ui/swift-ui/modifiers';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type {
	DevToolsActionServices,
	DevToolsPillQuickActionOption,
	DevToolsPluginWithPillQuickAction,
} from '../types';
import { colors } from './panel-ui';
import { SystemIcon } from './system-icon';

const subscribeToNothing = () => () => {};
const getNoSelection = () => null;
const getNotHighlighted = () => false;

const SLOT_WIDTH = 38;
const SLOT_HEIGHT = 48;

type PillQuickActionMenuProps = {
	plugin: DevToolsPluginWithPillQuickAction;
	actions: DevToolsActionServices;
	onUnpin: () => void;
	onOpenPanel?: () => void;
};

function resolveOptions(
	options: DevToolsPluginWithPillQuickAction['pillQuickAction']['options'],
): readonly DevToolsPillQuickActionOption[] {
	return typeof options === 'function' ? options() : options;
}

export function PillQuickActionMenu({
	plugin,
	actions,
	onUnpin,
	onOpenPanel,
}: PillQuickActionMenuProps) {
	const { pillQuickAction } = plugin;
	const subscribe = pillQuickAction.subscribe ?? subscribeToNothing;
	const selectedOptionId = useSyncExternalStore(
		subscribe,
		pillQuickAction.getSelectedOptionId ?? getNoSelection,
		pillQuickAction.getSelectedOptionId ?? getNoSelection,
	);
	const isHighlighted = useSyncExternalStore(
		subscribe,
		pillQuickAction.getIsHighlighted ?? getNotHighlighted,
		pillQuickAction.getIsHighlighted ?? getNotHighlighted,
	);
	// Function-typed options produce a fresh array per call, so they cannot be
	// a useSyncExternalStore snapshot (React would re-render forever). Resolve
	// once and again on each store notification instead.
	const [options, setOptions] = useState(() =>
		resolveOptions(pillQuickAction.options),
	);
	useEffect(() => {
		setOptions(resolveOptions(pillQuickAction.options));
		return subscribe(() => setOptions(resolveOptions(pillQuickAction.options)));
	}, [subscribe, pillQuickAction]);

	if (Platform.OS !== 'ios') {
		const openPanelId = '__open-panel';
		const unpinId = '__unpin';
		return (
			<View
				style={styles.container}
				testID={`devtools-pill-quick-action-${plugin.id}`}
			>
				<MenuView
					actions={[
						...options.map((option) => ({
							id: option.id,
							state:
								option.id === selectedOptionId ? ('on' as const) : undefined,
							title: option.label,
						})),
						...(onOpenPanel
							? [
									{
										id: openPanelId,
										title: `Open ${pillQuickAction.openPanelLabel ?? plugin.title}…`,
									},
								]
							: []),
						{ id: unpinId, title: 'Remove from Pill' },
					]}
					onPressAction={(event) => {
						const actionId = event.nativeEvent.event;
						if (actionId === openPanelId) {
							onOpenPanel?.();
							return;
						}
						if (actionId === unpinId) {
							onUnpin();
							return;
						}
						const option = options.find(
							(candidate) => candidate.id === actionId,
						);
						if (!option) return;
						void actions.run({
							pluginId: plugin.id,
							label: option.label,
							confirmation: option.confirmation,
							action: option.action,
						});
					}}
				>
					<View
						accessible
						accessibilityLabel={`${plugin.title} quick actions`}
						style={styles.androidTrigger}
					>
						<SystemIcon
							color={isHighlighted ? colors.orange : colors.blue}
							size={17}
							systemName={pillQuickAction.systemImage ?? plugin.systemImage}
						/>
					</View>
				</MenuView>
				{isHighlighted ? <View style={styles.dot} /> : null}
			</View>
		);
	}

	return (
		<View
			style={styles.container}
			testID={`devtools-pill-quick-action-${plugin.id}`}
		>
			<Host style={styles.host}>
				<Menu
					label={
						<Image
							color={isHighlighted ? colors.orange : colors.blue}
							modifiers={[
								frame({ width: SLOT_WIDTH, height: SLOT_HEIGHT }),
								accessibilityLabel(`${plugin.title} quick actions`),
							]}
							size={17}
							systemName={pillQuickAction.systemImage ?? plugin.systemImage}
						/>
					}
				>
					{options.map((option) => (
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
					{onOpenPanel ? (
						<NativeMenuButton
							label={`Open ${pillQuickAction.openPanelLabel ?? plugin.title}…`}
							onPress={onOpenPanel}
							systemImage="arrow.up.forward.app"
						/>
					) : null}
					<NativeMenuButton
						label="Remove from Pill"
						onPress={onUnpin}
						systemImage="minus.circle"
					/>
				</Menu>
			</Host>
			{isHighlighted ? <View style={styles.dot} /> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	androidTrigger: {
		alignItems: 'center',
		height: SLOT_HEIGHT,
		justifyContent: 'center',
		width: SLOT_WIDTH,
	},
	container: {
		borderLeftColor: colors.separator,
		borderLeftWidth: StyleSheet.hairlineWidth,
		height: SLOT_HEIGHT,
		width: SLOT_WIDTH,
	},
	host: {
		flex: 1,
	},
	dot: {
		backgroundColor: colors.orange,
		borderColor: colors.card,
		borderRadius: 5,
		borderWidth: 1.5,
		height: 10,
		position: 'absolute',
		right: 3,
		top: 5,
		width: 10,
	},
});
