import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import type { DevToolsPlugin } from '../types';
import { FloatingLauncher } from './floating-launcher';
import { FloatingWindow } from './floating-window';
import { MiniPill } from './mini-pill';
import { PresentationSwitcher } from './presentation-switcher';

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	return {
		Host: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(Native.View, null, children),
		Image: () => ReactRuntime.createElement(Native.View),
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	frame: (value: unknown) => value,
	glassEffect: (value: unknown) => value,
	padding: (value: unknown) => value,
}));

jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));

jest.mock('react-native-worklets', () => ({
	scheduleOnRN: (
		callback: (...args: readonly unknown[]) => void,
		...args: []
	) => callback(...args),
}));

jest.mock('react-native-reanimated', () => {
	const Native = jest.requireActual('react-native');
	return {
		__esModule: true,
		default: { View: Native.View },
		ReduceMotion: { System: 'system' },
		useAnimatedStyle: (factory: () => unknown) => factory(),
		useSharedValue: (value: unknown) => ({ value }),
		withSpring: (value: unknown) => value,
	};
});

jest.mock('react-native-gesture-handler', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const createPan = () => {
		const gesture = {
			minDistance: () => gesture,
			onBegin: () => gesture,
			onUpdate: () => gesture,
			onEnd: () => gesture,
		};
		return gesture;
	};
	return {
		Gesture: { Pan: createPan },
		GestureDetector: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(ReactRuntime.Fragment, null, children),
		RectButton: Native.Pressable,
		ScrollView: Native.ScrollView,
		FlatList: Native.FlatList,
	};
});

const actions = { run: jest.fn(async () => true) };
const plugin: DevToolsPlugin = {
	id: 'example',
	title: 'Example',
	description: 'Example diagnostics',
	systemImage: 'wrench',
	Panel: () => <Text>Example panel</Text>,
};

describe('presentation components', () => {
	it('opens from the draggable launcher', () => {
		const onOpen = jest.fn();
		render(
			<FloatingLauncher
				bottomObstructionInset={84}
				label="Open diagnostics"
				onOpen={onOpen}
			/>,
		);

		fireEvent.press(screen.getByLabelText('Open diagnostics'));
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it('restores or closes from the mini pill', () => {
		const onRestore = jest.fn();
		const onClose = jest.fn();
		render(
			<MiniPill
				bottomObstructionInset={84}
				label="Network"
				onClose={onClose}
				onRestore={onRestore}
			/>,
		);

		fireEvent.press(screen.getByLabelText('Network'));
		fireEvent.press(screen.getByLabelText('Close developer tools'));
		expect(onRestore).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('selects tools and switches modes in the floating window', () => {
		const onSelectPlugin = jest.fn();
		const onPresentationModeChange = jest.fn();
		const onClose = jest.fn();
		render(
			<FloatingWindow
				actions={actions}
				onBack={jest.fn()}
				onClose={onClose}
				onPresentationModeChange={onPresentationModeChange}
				onSelectPlugin={onSelectPlugin}
				plugins={[plugin]}
				title="Developer Tools"
			/>,
		);

		fireEvent.press(screen.getByLabelText('Example'));
		fireEvent.press(screen.getByLabelText('Pill presentation'));
		fireEvent.press(screen.getByLabelText('Close developer tools'));
		expect(onSelectPlugin).toHaveBeenCalledWith(plugin);
		expect(onPresentationModeChange).toHaveBeenCalledWith('pill');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('marks and changes the selected presentation', () => {
		const onModeChange = jest.fn();
		render(<PresentationSwitcher mode="sheet" onModeChange={onModeChange} />);

		expect(
			screen.getByLabelText('Sheet presentation').props.accessibilityState,
		).toEqual({ selected: true });
		expect(
			StyleSheet.flatten(screen.getByText('Sheet').props.style).color,
		).toBe('#FFFFFF');
		fireEvent.press(screen.getByLabelText('Window presentation'));
		expect(onModeChange).toHaveBeenCalledWith('window');
	});
});
