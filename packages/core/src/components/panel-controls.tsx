import { Host, Picker, Text as SwiftUIText } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';
import type { DevToolsSystemImage } from '../types';

/**
 * Segmented control for the shell's own chrome (presentation switcher).
 * Panels build their pickers directly in Expo UI.
 */
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

const styles = StyleSheet.create({
	segmentedHost: {
		height: 32,
		width: '100%',
	},
});
