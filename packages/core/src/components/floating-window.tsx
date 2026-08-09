import { useCallback, useEffect, useMemo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import {
	Gesture,
	GestureDetector,
	RectButton,
} from 'react-native-gesture-handler';
import Animated, {
	useAnimatedStyle,
	useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import type {
	DevToolsActionServices,
	DevToolsPanelPlugin,
	DevToolsPlugin,
	DevToolsPosition,
	DevToolsPresentationMode,
} from '../types';
import { colors } from './panel-ui';
import { PluginPanelRenderer } from './plugin-panel-renderer';
import { PresentationSwitcher } from './presentation-switcher';
import { SystemIcon } from './system-icon';
import { ToolList } from './tool-list';

const OUTER_MARGIN = 12;

type FloatingWindowProps = {
	title: string;
	plugins: readonly DevToolsPlugin[];
	selectedPlugin?: DevToolsPanelPlugin;
	onSelectPlugin: (plugin: DevToolsPlugin) => void;
	onBack: () => void;
	onClose: () => void;
	onPresentationModeChange: (mode: DevToolsPresentationMode) => void;
	initialPosition?: DevToolsPosition;
	onPositionChange?: (position: DevToolsPosition) => void;
	onPluginError?: (error: unknown, pluginId: string) => void;
	actions: DevToolsActionServices;
};

function clamp(value: number, minimum: number, maximum: number): number {
	'worklet';
	return Math.min(Math.max(value, minimum), maximum);
}

export function FloatingWindow({
	title,
	plugins,
	selectedPlugin,
	onSelectPlugin,
	onBack,
	onClose,
	onPresentationModeChange,
	initialPosition,
	onPositionChange,
	onPluginError,
	actions,
}: FloatingWindowProps) {
	const { width, height } = useWindowDimensions();
	const insets = useSafeAreaInsets();
	const windowWidth = Math.min(390, Math.max(300, width - OUTER_MARGIN * 2));
	const windowHeight = Math.min(
		620,
		Math.max(360, height - insets.top - insets.bottom - OUTER_MARGIN * 2),
	);
	const maximumX = Math.max(OUTER_MARGIN, width - windowWidth - OUTER_MARGIN);
	const minimumY = insets.top + OUTER_MARGIN;
	const maximumY = Math.max(
		minimumY,
		height - windowHeight - insets.bottom - OUTER_MARGIN,
	);
	const resolvedX = clamp(
		initialPosition?.x ?? (width - windowWidth) / 2,
		OUTER_MARGIN,
		maximumX,
	);
	const resolvedY = clamp(
		initialPosition?.y ?? (height - windowHeight) / 2,
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
				.minDistance(4)
				.onBegin(() => {
					startX.value = translateX.value;
					startY.value = translateY.value;
				})
				.onUpdate((event) => {
					translateX.value = clamp(
						startX.value + event.translationX,
						OUTER_MARGIN,
						maximumX,
					);
					translateY.value = clamp(
						startY.value + event.translationY,
						minimumY,
						maximumY,
					);
				})
				.onEnd(() => {
					scheduleOnRN(commitPosition, translateX.value, translateY.value);
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
		],
	);

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [
			{ translateX: translateX.value },
			{ translateY: translateY.value },
		],
	}));

	const panelProps = {
		onBack,
		onClose,
		presentationMode: 'window' as const,
		onPresentationModeChange,
		actions,
	};

	return (
		<Animated.View
			style={[
				styles.positioner,
				{ height: windowHeight, width: windowWidth },
				animatedStyle,
			]}
		>
			<View style={styles.window}>
				<View style={styles.header}>
					<GestureDetector gesture={dragGesture}>
						<Animated.View
							accessibilityHint="Drag to move the tools window"
							accessibilityLabel={title}
							style={styles.dragArea}
						>
							<View style={styles.headerIcon}>
								<SystemIcon
									systemName="wrench.and.screwdriver.fill"
									size={17}
								/>
							</View>
							<View style={styles.headerCopy}>
								<Text numberOfLines={1} style={styles.headerTitle}>
									{title}
								</Text>
								<Text style={styles.headerSubtitle}>Floating window</Text>
							</View>
						</Animated.View>
					</GestureDetector>
					<RectButton
						accessibilityLabel="Close developer tools"
						accessibilityRole="button"
						onPress={onClose}
						style={styles.closeButton}
					>
						<SystemIcon
							systemName="xmark"
							size={13}
							color={colors.secondaryLabel}
						/>
					</RectButton>
				</View>
				<View style={styles.switcher}>
					<PresentationSwitcher
						mode="window"
						onModeChange={onPresentationModeChange}
					/>
				</View>
				<View style={styles.content}>
					{selectedPlugin ? (
						<PluginPanelRenderer
							plugin={selectedPlugin}
							panelProps={panelProps}
							onError={onPluginError}
						/>
					) : (
						<ToolList plugins={plugins} onSelect={onSelectPlugin} />
					)}
				</View>
			</View>
		</Animated.View>
	);
}

const styles = StyleSheet.create({
	positioner: {
		left: 0,
		position: 'absolute',
		shadowColor: colors.shadow,
		shadowOffset: { width: 0, height: 14 },
		shadowOpacity: 0.28,
		shadowRadius: 30,
		top: 0,
		zIndex: 10_001,
	},
	window: {
		backgroundColor: colors.background,
		borderColor: colors.separator,
		borderRadius: 26,
		borderWidth: StyleSheet.hairlineWidth,
		flex: 1,
		overflow: 'hidden',
	},
	header: {
		alignItems: 'center',
		backgroundColor: colors.card,
		borderBottomColor: colors.separator,
		borderBottomWidth: StyleSheet.hairlineWidth,
		flexDirection: 'row',
		height: 58,
		paddingLeft: 12,
		paddingRight: 9,
	},
	dragArea: {
		alignItems: 'center',
		flex: 1,
		flexDirection: 'row',
		height: '100%',
	},
	headerIcon: {
		alignItems: 'center',
		backgroundColor: colors.background,
		borderRadius: 9,
		height: 34,
		justifyContent: 'center',
		width: 34,
	},
	headerCopy: {
		flex: 1,
		marginLeft: 10,
	},
	headerTitle: {
		color: colors.label,
		fontSize: 15,
		fontWeight: '700',
	},
	headerSubtitle: {
		color: colors.secondaryLabel,
		fontSize: 11,
		fontWeight: '400',
		marginTop: 1,
	},
	closeButton: {
		alignItems: 'center',
		backgroundColor: colors.background,
		borderRadius: 16,
		height: 32,
		justifyContent: 'center',
		width: 32,
	},
	switcher: {
		backgroundColor: colors.card,
		paddingBottom: 9,
		paddingHorizontal: 12,
	},
	content: {
		flex: 1,
	},
});
