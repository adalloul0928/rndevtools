import {
	Host,
	Picker,
	Button as SwiftUIButton,
	Text as SwiftUIText,
} from '@expo/ui/swift-ui';
import {
	buttonStyle,
	controlSize,
	disabled as disabledModifier,
	pickerStyle,
	tag,
	tint,
} from '@expo/ui/swift-ui/modifiers';
import type { PropsWithChildren } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
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
		<Host style={styles.segmentedHost}>
			<Picker<T>
				label={accessibilityLabel ?? 'Selection'}
				modifiers={[pickerStyle('segmented')]}
				onSelectionChange={onChange}
				selection={selected}
			>
				{options.map((option) => (
					<SwiftUIText key={option.id} modifiers={[tag(option.id)]}>
						{option.label}
					</SwiftUIText>
				))}
			</Picker>
		</Host>
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
		<Host matchContents style={styles.buttonHost}>
			<SwiftUIButton
				label={label}
				modifiers={[
					buttonStyle(selected ? 'borderedProminent' : 'bordered'),
					controlSize('regular'),
					disabledModifier(disabled),
					...(tone === 'danger' ? [tint(colors.red)] : []),
				]}
				onPress={onPress}
				role={tone === 'danger' ? 'destructive' : 'default'}
			/>
		</Host>
	);
}

const styles = StyleSheet.create({
	toolbar: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 6,
	},
	searchContainer: {
		alignItems: 'center',
		backgroundColor: colors.card,
		borderColor: colors.separator,
		borderRadius: 14,
		borderWidth: StyleSheet.hairlineWidth,
		flexDirection: 'row',
		gap: 8,
		minHeight: 38,
		paddingLeft: 12,
		paddingRight: 4,
	},
	search: {
		color: colors.label,
		flex: 1,
		fontSize: 15,
		minHeight: 38,
		paddingVertical: 7,
	},
	segmentedHost: {
		height: 32,
		width: '100%',
	},
	buttonHost: {
		minHeight: 34,
	},
});
