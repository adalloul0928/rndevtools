import { useMemo } from 'react';
import { Platform, PlatformColor, useColorScheme } from 'react-native';

const nativeColor = (iosName: string, androidColor: string) =>
	Platform.OS === 'ios' ? PlatformColor(iosName) : androidColor;

/**
 * iOS system palette for the shell's React Native chrome (launcher, pill,
 * floating window). Panel content renders in Expo UI and takes system
 * colors natively — do not build new panel UI from these tokens.
 */
const iosColors = {
	background: nativeColor('systemGroupedBackgroundColor', '#FFFBFE'),
	card: nativeColor('secondarySystemGroupedBackgroundColor', '#F7F2FA'),
	label: nativeColor('labelColor', '#1D1B20'),
	secondaryLabel: nativeColor('secondaryLabelColor', '#49454F'),
	separator: nativeColor('separatorColor', '#CAC4D0'),
	fill: nativeColor('tertiarySystemFillColor', '#E8DEF8'),
	groupedFill: nativeColor('tertiarySystemGroupedBackgroundColor', '#F3EDF7'),
	blue: nativeColor('systemBlueColor', '#6750A4'),
	green: nativeColor('systemGreenColor', '#386A20'),
	orange: nativeColor('systemOrangeColor', '#8B5000'),
	red: nativeColor('systemRedColor', '#BA1A1A'),
	// PlatformColor('whiteColor') resolves unreliably on iOS 26.
	onAccent: '#FFFFFF',
	shadow: nativeColor('blackColor', '#000000'),
};

/** Legacy static palette; built-in React chrome uses usePanelColors. */
export const colors = iosColors;

const lightColors = {
	background: '#FFFBFE',
	card: '#F7F2FA',
	label: '#1D1B20',
	secondaryLabel: '#49454F',
	separator: '#CAC4D0',
	fill: '#E8DEF8',
	groupedFill: '#F3EDF7',
	blue: '#6750A4',
	green: '#386A20',
	orange: '#8B5000',
	red: '#BA1A1A',
	onAccent: '#FFFFFF',
	shadow: '#000000',
};
const darkColors = {
	background: '#141218',
	card: '#211F26',
	label: '#E6E0E9',
	secondaryLabel: '#CAC4D0',
	separator: '#49454F',
	fill: '#4A4458',
	groupedFill: '#2B2930',
	blue: '#D0BCFF',
	green: '#A3D68B',
	orange: '#FFB77D',
	red: '#FFB4AB',
	onAccent: '#381E72',
	shadow: '#000000',
};
type PanelColors = typeof iosColors;

/** iOS keeps native dynamic colors; Android follows appearance changes in React. */
export function usePanelColors(): PanelColors {
	const scheme = useColorScheme();
	return Platform.OS === 'ios'
		? iosColors
		: scheme === 'dark'
			? darkColors
			: lightColors;
}

/** Keep each component's styles stable until its system palette changes. */
export function createPanelStyles<T>(factory: (colors: PanelColors) => T) {
	return function usePanelStyles() {
		const colors = usePanelColors();
		const styles = useMemo(() => factory(colors), [colors]);
		return { colors, styles };
	};
}
