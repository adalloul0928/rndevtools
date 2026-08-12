import { Host, Image } from '@expo/ui/swift-ui';
import { frame } from '@expo/ui/swift-ui/modifiers';
import { type ColorValue, PlatformColor, StyleSheet, View } from 'react-native';
import type { DevToolsSystemImage } from '../types';

type SystemIconProps = {
	systemName: DevToolsSystemImage;
	size?: number;
	color?: ColorValue;
};

export function SystemIcon({
	systemName,
	size = 20,
	color = PlatformColor('systemBlueColor'),
}: SystemIconProps) {
	return (
		<View pointerEvents="none" style={{ height: size, width: size }}>
			<Host style={styles.host}>
				<Image
					color={color}
					modifiers={[frame({ width: size, height: size })]}
					size={size}
					systemName={systemName}
				/>
			</Host>
		</View>
	);
}

const styles = StyleSheet.create({
	host: {
		flex: 1,
	},
});
