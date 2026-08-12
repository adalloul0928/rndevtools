import { Host, Image } from '@expo/ui/swift-ui';
import { frame, glassEffect, padding } from '@expo/ui/swift-ui/modifiers';
import { useCallback, useEffect, useMemo } from 'react';
import {
	Platform,
	PlatformColor,
	StyleSheet,
	useWindowDimensions,
	View,
} from 'react-native';
import {
	Gesture,
	GestureDetector,
	RectButton,
} from 'react-native-gesture-handler';
import Animated, {
	ReduceMotion,
	useAnimatedStyle,
	useSharedValue,
	withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import type { DevToolsPosition } from '../types';

const SIZE = 56;
const EDGE_MARGIN = 10;

type FloatingLauncherProps = {
	label: string;
	onOpen: () => void;
	initialPosition?: DevToolsPosition;
	onPositionChange?: (position: DevToolsPosition) => void;
	bottomObstructionInset?: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
	'worklet';
	return Math.min(Math.max(value, minimum), maximum);
}

export function FloatingLauncher({
	label,
	onOpen,
	initialPosition,
	onPositionChange,
	bottomObstructionInset = 0,
}: FloatingLauncherProps) {
	const { width, height } = useWindowDimensions();
	const insets = useSafeAreaInsets();
	const minimumX = EDGE_MARGIN;
	const maximumX = Math.max(minimumX, width - SIZE - EDGE_MARGIN);
	const minimumY = insets.top + EDGE_MARGIN;
	const maximumY = Math.max(
		minimumY,
		height - SIZE - insets.bottom - bottomObstructionInset - EDGE_MARGIN,
	);
	const resolvedX = clamp(initialPosition?.x ?? maximumX, minimumX, maximumX);
	const resolvedY = clamp(
		initialPosition?.y ?? Math.max(minimumY, maximumY - 72),
		minimumY,
		maximumY,
	);
	const translateX = useSharedValue(resolvedX);
	const translateY = useSharedValue(resolvedY);
	const startX = useSharedValue(resolvedX);
	const startY = useSharedValue(resolvedY);
	const commitPosition = useCallback(
		(x: number, y: number) => onPositionChange?.({ x, y }),
		[onPositionChange],
	);

	useEffect(() => {
		translateX.value = resolvedX;
		translateY.value = resolvedY;
		startX.value = resolvedX;
		startY.value = resolvedY;
	}, [resolvedX, resolvedY, startX, startY, translateX, translateY]);

	const dragGesture = useMemo(
		() =>
			Gesture.Pan()
				.minDistance(5)
				.onBegin(() => {
					startX.value = translateX.value;
					startY.value = translateY.value;
				})
				.onUpdate((event) => {
					translateX.value = clamp(
						startX.value + event.translationX,
						minimumX,
						maximumX,
					);
					translateY.value = clamp(
						startY.value + event.translationY,
						minimumY,
						maximumY,
					);
				})
				.onEnd(() => {
					const snapX =
						translateX.value + SIZE / 2 < width / 2 ? minimumX : maximumX;
					const finalY = translateY.value;
					translateX.value = withSpring(snapX, {
						dampingRatio: 0.82,
						duration: 280,
						reduceMotion: ReduceMotion.System,
					});
					scheduleOnRN(commitPosition, snapX, finalY);
				}),
		[
			commitPosition,
			maximumX,
			maximumY,
			minimumY,
			startX,
			startY,
			translateX,
			translateY,
			width,
		],
	);

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [
			{ translateX: translateX.value },
			{ translateY: translateY.value },
		],
	}));

	const supportsLiquidGlass =
		Platform.OS === 'ios' && Number(Platform.Version) >= 26;
	const imageModifiers = supportsLiquidGlass
		? [
				frame({ width: SIZE, height: SIZE }),
				padding({ all: 16 }),
				glassEffect({
					glass: {
						interactive: true,
						tint: PlatformColor('systemBlueColor'),
						variant: 'regular',
					},
					shape: 'circle',
					cornerRadius: SIZE / 2,
				}),
			]
		: [frame({ width: SIZE, height: SIZE }), padding({ all: 16 })];

	return (
		<GestureDetector gesture={dragGesture}>
			<Animated.View style={[styles.positioner, animatedStyle]}>
				<RectButton
					accessibilityLabel={label}
					accessibilityRole="button"
					onPress={onOpen}
					style={[
						styles.fallbackSurface,
						supportsLiquidGlass && styles.liquidGlassSurface,
					]}
				>
					<View pointerEvents="none">
						<Host style={styles.host}>
							<Image
								color="#FFFFFF"
								modifiers={imageModifiers}
								size={22}
								systemName="wrench.and.screwdriver.fill"
							/>
						</Host>
					</View>
				</RectButton>
			</Animated.View>
		</GestureDetector>
	);
}

const styles = StyleSheet.create({
	positioner: {
		left: 0,
		position: 'absolute',
		top: 0,
		zIndex: 10_000,
	},
	fallbackSurface: {
		backgroundColor: PlatformColor('systemBlueColor'),
		borderColor: PlatformColor('separatorColor'),
		borderRadius: SIZE / 2,
		borderWidth: StyleSheet.hairlineWidth,
		height: SIZE,
		overflow: 'hidden',
		shadowColor: PlatformColor('blackColor'),
		shadowOffset: { width: 0, height: 6 },
		shadowOpacity: 0.2,
		shadowRadius: 14,
		width: SIZE,
	},
	liquidGlassSurface: {
		backgroundColor: 'transparent',
		borderColor: 'transparent',
		shadowOpacity: 0.14,
	},
	host: {
		height: SIZE,
		width: SIZE,
	},
});
