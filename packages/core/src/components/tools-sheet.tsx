import { Icon, ListItem } from '@expo/ui';
import {
	BottomSheet,
	Group,
	Host,
	Label,
	List,
	Picker,
	RNHostView,
	Section,
	Text as SwiftUIText,
} from '@expo/ui/swift-ui';
import {
	padding,
	pickerStyle,
	presentationDetents,
	presentationDragIndicator,
	tag,
} from '@expo/ui/swift-ui/modifiers';
import { PlatformColor, StyleSheet, View } from 'react-native';
import { groupPlugins } from '../core/plugins';
import type {
	DevToolsActionServices,
	DevToolsPanelPlugin,
	DevToolsPlugin,
	DevToolsPresentationMode,
} from '../types';
import { PluginPanelRenderer } from './plugin-panel-renderer';

type ToolsSheetProps = {
	isPresented: boolean;
	plugins: readonly DevToolsPlugin[];
	selectedPlugin?: DevToolsPanelPlugin;
	onSelectPlugin: (plugin: DevToolsPlugin) => void;
	onBack: () => void;
	onClose: () => void;
	onPresentationModeChange: (mode: DevToolsPresentationMode) => void;
	title: string;
	onPluginError?: (error: unknown, pluginId: string) => void;
	actions: DevToolsActionServices;
	pinnedPillQuickActionIds: readonly string[];
	onQuickActionPinnedChange: (pluginId: string, isPinned: boolean) => void;
};

export function ToolsSheet({
	isPresented,
	plugins,
	selectedPlugin,
	onSelectPlugin,
	onBack,
	onClose,
	onPresentationModeChange,
	title,
	onPluginError,
	actions,
	pinnedPillQuickActionIds,
	onQuickActionPinnedChange,
}: ToolsSheetProps) {
	const sections = groupPlugins(plugins);
	const panelProps = {
		onBack,
		onClose,
		presentationMode: 'sheet' as const,
		onPresentationModeChange,
		actions,
		...(selectedPlugin?.pillQuickAction
			? {
					pillShortcut: {
						isPinned: pinnedPillQuickActionIds.includes(selectedPlugin.id),
						onPinnedChange: (isPinned: boolean) =>
							onQuickActionPinnedChange(selectedPlugin.id, isPinned),
					},
				}
			: {}),
	};

	return (
		<Host matchContents style={styles.host}>
			<BottomSheet
				isPresented={isPresented}
				onIsPresentedChange={(next) => {
					if (!next) onClose();
				}}
			>
				<Group
					modifiers={[
						presentationDetents(['medium', 'large']),
						presentationDragIndicator('visible'),
					]}
				>
					{selectedPlugin ? (
						<RNHostView>
							<View style={styles.panel}>
								<PluginPanelRenderer
									plugin={selectedPlugin}
									panelProps={panelProps}
									onError={onPluginError}
								/>
							</View>
						</RNHostView>
					) : (
						<List modifiers={[padding({ top: 10 })]}>
							<Section title={title}>
								<Picker<DevToolsPresentationMode>
									label="Presentation"
									selection="sheet"
									onSelectionChange={onPresentationModeChange}
									modifiers={[pickerStyle('segmented')]}
								>
									<SwiftUIText modifiers={[tag('sheet')]}>Sheet</SwiftUIText>
									<SwiftUIText modifiers={[tag('window')]}>Window</SwiftUIText>
									<SwiftUIText modifiers={[tag('pill')]}>Pill</SwiftUIText>
								</Picker>
							</Section>
							{sections.map((section) => (
								<Section key={section.title} title={section.title}>
									{section.plugins.map((plugin) => (
										<ListItem
											key={plugin.id}
											leading={
												<Icon
													color={PlatformColor('systemBlueColor')}
													name={plugin.systemImage}
													size={20}
												/>
											}
											onPress={() => onSelectPlugin(plugin)}
											supportingText={plugin.description}
											testID={`devtools-tool-row-${plugin.id}`}
											trailing={
												<Icon
													color={PlatformColor('secondaryLabelColor')}
													name="chevron.right"
													size={12}
												/>
											}
										>
											{plugin.title}
										</ListItem>
									))}
								</Section>
							))}
							<Section title="Collection">
								<Label
									title="Collectors stay active while this sheet is closed"
									systemImage="checkmark.circle.fill"
								/>
							</Section>
						</List>
					)}
				</Group>
			</BottomSheet>
		</Host>
	);
}

const styles = StyleSheet.create({
	host: {
		height: 1,
		width: 1,
	},
	panel: {
		flex: 1,
	},
});
