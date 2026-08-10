import type { PropsWithChildren } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { RectButton } from 'react-native-gesture-handler';
import type { DevToolsSystemImage } from '../types';
import { colors } from './panel-ui';
import { SystemIcon } from './system-icon';

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
		<View style={styles.searchContainer}>
			<SystemIcon
				systemName="magnifyingglass"
				size={16}
				color={colors.secondaryLabel}
			/>
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
		</View>
	);
}

export function PanelSegmentedControl<T extends string>({
	options,
	selected,
	onChange,
	accessibilityLabel,
}: {
	options: ReadonlyArray<{
		id: T;
		label: string;
		systemImage?: DevToolsSystemImage;
	}>;
	selected: T;
	onChange: (value: T) => void;
	accessibilityLabel?: string;
}) {
	return (
		<View
			accessibilityLabel={accessibilityLabel}
			accessibilityRole="tablist"
			style={styles.segmentedControl}
		>
			{options.map((option) => {
				const isSelected = option.id === selected;
				return (
					<RectButton
						key={option.id}
						accessibilityLabel={option.label}
						accessibilityRole="tab"
						accessibilityState={{ selected: isSelected }}
						onPress={() => onChange(option.id)}
						style={[styles.segment, isSelected && styles.segmentSelected]}
					>
						{option.systemImage ? (
							<SystemIcon
								systemName={option.systemImage}
								size={13}
								color={isSelected ? colors.label : colors.secondaryLabel}
							/>
						) : null}
						<Text
							numberOfLines={1}
							style={[
								styles.segmentText,
								isSelected && styles.segmentTextSelected,
							]}
						>
							{option.label}
						</Text>
					</RectButton>
				);
			})}
		</View>
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
			accessibilityLabel={label}
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
	searchContainer: {
		alignItems: 'center',
		backgroundColor: colors.card,
		borderRadius: 12,
		flexDirection: 'row',
		gap: 8,
		minHeight: 42,
		paddingLeft: 12,
		paddingRight: 4,
	},
	search: {
		color: colors.label,
		flex: 1,
		fontSize: 15,
		minHeight: 42,
		paddingVertical: 9,
	},
	segmentedControl: {
		backgroundColor: colors.separator,
		borderRadius: 11,
		flexDirection: 'row',
		gap: 2,
		padding: 2,
	},
	segment: {
		alignItems: 'center',
		borderRadius: 9,
		flex: 1,
		flexDirection: 'row',
		gap: 5,
		justifyContent: 'center',
		minHeight: 36,
		paddingHorizontal: 7,
	},
	segmentSelected: {
		backgroundColor: colors.card,
		shadowColor: colors.shadow,
		shadowOffset: { height: 1, width: 0 },
		shadowOpacity: 0.12,
		shadowRadius: 2,
	},
	segmentText: {
		color: colors.secondaryLabel,
		fontSize: 12,
		fontWeight: '600',
	},
	segmentTextSelected: {
		color: colors.label,
	},
	button: {
		backgroundColor: colors.card,
		borderColor: colors.separator,
		borderRadius: 10,
		borderWidth: StyleSheet.hairlineWidth,
		justifyContent: 'center',
		minHeight: 44,
		paddingHorizontal: 11,
		paddingVertical: 7,
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
