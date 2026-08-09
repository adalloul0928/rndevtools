import type { PropsWithChildren } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { RectButton } from 'react-native-gesture-handler';
import { colors } from './panel-ui';

export function PanelToolbar({ children }: PropsWithChildren) {
	return <View style={styles.toolbar}>{children}</View>;
}

export function PanelSearchField({
	value,
	onChangeText,
	placeholder = 'Search',
}: {
	value: string;
	onChangeText: (value: string) => void;
	placeholder?: string;
}) {
	return (
		<TextInput
			accessibilityLabel={placeholder}
			autoCapitalize="none"
			autoCorrect={false}
			clearButtonMode="while-editing"
			onChangeText={onChangeText}
			placeholder={placeholder}
			placeholderTextColor={colors.secondaryLabel}
			style={styles.search}
			value={value}
		/>
	);
}

export function PanelButton({
	label,
	onPress,
	selected = false,
	tone = 'default',
	disabled = false,
}: {
	label: string;
	onPress: () => void;
	selected?: boolean;
	tone?: 'default' | 'danger';
	disabled?: boolean;
}) {
	return (
		<RectButton
			accessibilityRole="button"
			accessibilityState={{ disabled, selected }}
			enabled={!disabled}
			onPress={onPress}
			style={[
				styles.button,
				selected && styles.buttonSelected,
				tone === 'danger' && styles.buttonDanger,
				disabled && styles.buttonDisabled,
			]}
		>
			<Text
				style={[
					styles.buttonText,
					selected && styles.buttonTextSelected,
					tone === 'danger' && styles.buttonTextDanger,
				]}
			>
				{label}
			</Text>
		</RectButton>
	);
}

const styles = StyleSheet.create({
	toolbar: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 7,
	},
	search: {
		backgroundColor: colors.card,
		borderColor: colors.separator,
		borderRadius: 12,
		borderWidth: StyleSheet.hairlineWidth,
		color: colors.label,
		fontSize: 15,
		minHeight: 42,
		paddingHorizontal: 13,
		paddingVertical: 9,
	},
	button: {
		backgroundColor: colors.card,
		borderColor: colors.separator,
		borderRadius: 10,
		borderWidth: StyleSheet.hairlineWidth,
		paddingHorizontal: 11,
		paddingVertical: 8,
	},
	buttonSelected: {
		backgroundColor: colors.blue,
		borderColor: colors.blue,
	},
	buttonDanger: {
		backgroundColor: colors.card,
	},
	buttonDisabled: {
		opacity: 0.45,
	},
	buttonText: {
		color: colors.label,
		fontSize: 12,
		fontWeight: '600',
	},
	buttonTextSelected: {
		color: colors.onAccent,
	},
	buttonTextDanger: {
		color: colors.red,
	},
});
