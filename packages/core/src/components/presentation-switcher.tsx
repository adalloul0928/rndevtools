import { StyleSheet, Text, View } from 'react-native';
import { RectButton } from 'react-native-gesture-handler';
import type { DevToolsPresentationMode } from '../types';
import { colors } from './panel-ui';

const MODES: ReadonlyArray<{
	mode: DevToolsPresentationMode;
	label: string;
}> = [
	{ mode: 'sheet', label: 'Sheet' },
	{ mode: 'window', label: 'Window' },
	{ mode: 'pill', label: 'Pill' },
];

type PresentationSwitcherProps = {
	mode: DevToolsPresentationMode;
	onModeChange: (mode: DevToolsPresentationMode) => void;
};

export function PresentationSwitcher({
	mode,
	onModeChange,
}: PresentationSwitcherProps) {
	return (
		<View accessibilityRole="tablist" style={styles.container}>
			{MODES.map((item) => {
				const selected = item.mode === mode;
				return (
					<RectButton
						key={item.mode}
						accessibilityLabel={`${item.label} presentation`}
						accessibilityRole="tab"
						accessibilityState={{ selected }}
						onPress={() => onModeChange(item.mode)}
						style={[styles.button, selected && styles.buttonSelected]}
					>
						<Text style={[styles.label, selected && styles.labelSelected]}>
							{item.label}
						</Text>
					</RectButton>
				);
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		backgroundColor: colors.separator,
		borderRadius: 10,
		flexDirection: 'row',
		gap: 2,
		padding: 3,
	},
	button: {
		alignItems: 'center',
		borderRadius: 8,
		flex: 1,
		justifyContent: 'center',
		minHeight: 30,
		paddingHorizontal: 8,
	},
	buttonSelected: {
		backgroundColor: colors.card,
		shadowColor: colors.shadow,
		shadowOffset: { width: 0, height: 1 },
		shadowOpacity: 0.12,
		shadowRadius: 2,
	},
	label: {
		color: colors.secondaryLabel,
		fontSize: 12,
		fontWeight: '600',
	},
	labelSelected: {
		color: colors.label,
	},
});
