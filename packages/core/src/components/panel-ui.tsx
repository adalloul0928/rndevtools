import { PlatformColor } from 'react-native';

/**
 * iOS system palette for the shell's React Native chrome (launcher, pill,
 * floating window). Panel content renders in Expo UI and takes system
 * colors natively — do not build new panel UI from these tokens.
 */
export const colors = {
	background: PlatformColor('systemGroupedBackgroundColor'),
	card: PlatformColor('secondarySystemGroupedBackgroundColor'),
	label: PlatformColor('labelColor'),
	secondaryLabel: PlatformColor('secondaryLabelColor'),
	separator: PlatformColor('separatorColor'),
	fill: PlatformColor('tertiarySystemFillColor'),
	groupedFill: PlatformColor('tertiarySystemGroupedBackgroundColor'),
	blue: PlatformColor('systemBlueColor'),
	green: PlatformColor('systemGreenColor'),
	orange: PlatformColor('systemOrangeColor'),
	red: PlatformColor('systemRedColor'),
	// PlatformColor('whiteColor') resolves unreliably on iOS 26.
	onAccent: '#FFFFFF',
	shadow: PlatformColor('blackColor'),
};
