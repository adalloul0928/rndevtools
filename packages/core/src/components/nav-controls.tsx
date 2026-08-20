import { Button, Host, Image } from '@expo/ui/swift-ui';
import { buttonStyle, tint } from '@expo/ui/swift-ui/modifiers';
import { Platform, PlatformColor, Pressable, Text } from 'react-native';
import type { DevToolsSystemImage } from '../types';

/**
 * Icon button for the panel shell's trailing slot, composed entirely from
 * Expo UI on iOS (SwiftUI plain Button + SF Symbol). Android falls back to
 * a text button until the Jetpack panel variants land.
 */
export function NavIconButton({
	systemImage,
	accessibilityLabel,
	destructive = false,
	onPress,
	testID,
}: {
	systemImage: DevToolsSystemImage;
	accessibilityLabel: string;
	destructive?: boolean;
	onPress: () => void;
	testID?: string;
}) {
	if (Platform.OS !== 'ios') {
		return (
			<Pressable
				accessibilityLabel={accessibilityLabel}
				accessibilityRole="button"
				onPress={onPress}
				testID={testID}
			>
				<Text style={{ color: destructive ? '#D32F2F' : '#1976D2' }}>
					{accessibilityLabel}
				</Text>
			</Pressable>
		);
	}
	return (
		<Host matchContents testID={testID}>
			<Button
				modifiers={[
					buttonStyle('plain'),
					tint(
						destructive
							? PlatformColor('systemRedColor')
							: PlatformColor('systemBlueColor'),
					),
				]}
				onPress={onPress}
			>
				<Image
					color={
						destructive
							? PlatformColor('systemRedColor')
							: PlatformColor('systemBlueColor')
					}
					size={18}
					systemName={systemImage}
				/>
			</Button>
		</Host>
	);
}
