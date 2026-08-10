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
									<SystemIcon systemName={plugin.systemImage} size={20} />
								</View>
								<View
									style={[
										styles.rowContent,
										index < section.plugins.length - 1 && styles.separator,
									]}
								>
									<View style={styles.copy}>
										<Text style={styles.title}>{plugin.title}</Text>
										<Text numberOfLines={2} style={styles.description}>
											{plugin.description}
										</Text>
									</View>
									<SystemIcon
										systemName={
											plugin.kind === 'action'
												? 'arrow.up.right'
												: 'chevron.right'
										}
										size={13}
										color={colors.secondaryLabel}
									/>
								</View>
							</RectButton>
						))}
					</View>
				</View>
			))}
			<Text style={styles.footer}>
				Collectors continue recording while tools are minimized.
			</Text>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: {
		gap: 18,
		paddingBottom: 32,
		paddingHorizontal: 12,
		paddingTop: 14,
	},
	section: {
		gap: 7,
	},
	sectionTitle: {
		color: colors.secondaryLabel,
		fontSize: 12,
		fontWeight: '600',
		letterSpacing: 0.4,
		paddingHorizontal: 10,
		textTransform: 'uppercase',
	},
	group: {
		backgroundColor: colors.card,
		borderRadius: 16,
		overflow: 'hidden',
	},
	row: {
		alignItems: 'center',
		alignSelf: 'stretch',
		flexDirection: 'row',
		minHeight: 72,
		paddingLeft: 12,
		width: '100%',
	},
	iconSurface: {
		alignItems: 'center',
		backgroundColor: colors.background,
		borderRadius: 10,
		height: 38,
		justifyContent: 'center',
		width: 38,
	},
	rowContent: {
		alignItems: 'center',
		flex: 1,
		flexDirection: 'row',
		marginLeft: 11,
		minHeight: 72,
		paddingVertical: 9,
		paddingRight: 14,
	},
	separator: {
		borderBottomColor: colors.separator,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	copy: {
		flex: 1,
		gap: 2,
	},
	title: {
		color: colors.label,
		fontSize: 15,
		fontWeight: '600',
	},
	description: {
		color: colors.secondaryLabel,
		fontSize: 12,
		lineHeight: 16,
	},
	footer: {
		color: colors.secondaryLabel,
		fontSize: 12,
		lineHeight: 17,
		paddingHorizontal: 10,
	},
});
