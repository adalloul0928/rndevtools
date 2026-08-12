import { StyleSheet, Text, View } from 'react-native';
import { RectButton, ScrollView } from 'react-native-gesture-handler';
import { groupPlugins } from '../core/plugins';
import type { DevToolsPlugin } from '../types';
import { colors } from './panel-ui';
import { SystemIcon } from './system-icon';

type ToolListProps = {
	plugins: readonly DevToolsPlugin[];
	onSelect: (plugin: DevToolsPlugin) => void;
};

export function ToolList({ plugins, onSelect }: ToolListProps) {
	const sections = groupPlugins(plugins);

	return (
		<ScrollView
			contentContainerStyle={styles.content}
			showsVerticalScrollIndicator={false}
		>
			{sections.map((section) => (
				<View key={section.title} style={styles.section}>
					<Text style={styles.sectionTitle}>{section.title}</Text>
					<View style={styles.group}>
						{section.plugins.map((plugin, index) => (
							<RectButton
								key={plugin.id}
								accessibilityHint={plugin.description}
								accessibilityLabel={plugin.title}
								accessibilityRole="button"
								onPress={() => onSelect(plugin)}
								style={styles.row}
								testID={`devtools-tool-row-${plugin.id}`}
							>
								<View style={styles.iconSurface}>
									<SystemIcon
										color={colors.blue}
										systemName={plugin.systemImage}
										size={16}
									/>
								</View>
								<View
									style={[
										styles.rowContent,
										index < section.plugins.length - 1 && styles.separator,
									]}
								>
									<View style={styles.copy}>
										<Text style={styles.title}>{plugin.title}</Text>
									</View>
									<SystemIcon
										systemName={
											plugin.kind === 'action'
												? 'arrow.up.right'
												: 'chevron.right'
										}
										size={12}
										color={colors.secondaryLabel}
									/>
								</View>
							</RectButton>
						))}
					</View>
				</View>
			))}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: {
		gap: 14,
		paddingBottom: 20,
		paddingHorizontal: 12,
		paddingTop: 10,
	},
	section: {
		gap: 7,
	},
	sectionTitle: {
		color: colors.secondaryLabel,
		fontSize: 13,
		fontWeight: '600',
		paddingHorizontal: 4,
	},
	group: {
		backgroundColor: colors.card,
		borderRadius: 13,
		overflow: 'hidden',
	},
	row: {
		alignItems: 'center',
		alignSelf: 'stretch',
		flexDirection: 'row',
		minHeight: 48,
		paddingLeft: 13,
		width: '100%',
	},
	iconSurface: {
		alignItems: 'center',
		height: 24,
		justifyContent: 'center',
		width: 22,
	},
	rowContent: {
		alignItems: 'center',
		flex: 1,
		flexDirection: 'row',
		marginLeft: 10,
		minHeight: 48,
		paddingRight: 14,
	},
	separator: {
		borderBottomColor: colors.separator,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	copy: {
		flex: 1,
	},
	title: {
		color: colors.label,
		fontSize: 15,
		fontWeight: '400',
	},
});
