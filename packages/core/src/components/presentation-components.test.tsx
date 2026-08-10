import { fireEvent, render, screen } from '@testing-library/react-native';
import { PlatformColor, StyleSheet, Text } from 'react-native';
import type {
	DevToolsPlugin,
	DevToolsPluginWithPillQuickAction,
} from '../types';
import { FloatingLauncher } from './floating-launcher';
import { FloatingWindow } from './floating-window';
import { MiniPill } from './mini-pill';
import { PresentationSwitcher } from './presentation-switcher';

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	return {
		Button: ({ label, onPress }: { label?: string; onPress?: () => void }) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{ accessibilityLabel: label, onPress },
				ReactRuntime.createElement(Native.Text, null, label),
			),
		Divider: () => ReactRuntime.createElement(Native.View),
		Host: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(Native.View, null, children),
		Image: () => ReactRuntime.createElement(Native.View),
		Menu: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(Native.View, null, children),
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	accessibilityLabel: (value: unknown) => value,
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
				actions={actions}
				bottomObstructionInset={84}
				label="Network"
				onClose={onClose}
				onQuickActionPinnedChange={jest.fn()}
				onRestore={onRestore}
			/>,
		);

		fireEvent.press(screen.getByLabelText('Network'));
		fireEvent.press(screen.getByLabelText('Close developer tools'));
		expect(onRestore).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('runs and removes pinned quick actions from the mini pill', () => {
		const quickAction = jest.fn();
		const onQuickActionPinnedChange = jest.fn();
		const quickActionPlugin: DevToolsPluginWithPillQuickAction = {
			...plugin,
			id: 'data-source',
			title: 'Data Source',
			pillQuickAction: {
				getSelectedOptionId: () => 'real',
				subscribe: () => () => {},
				options: [
					{ id: 'real', label: 'Real data', action: jest.fn() },
					{ id: 'mock', label: 'Mock data', action: quickAction },
				],
			},
		};
		render(
			<MiniPill
				actions={{
					run: jest.fn(async (request) => {
						await request.action();
						return true;
					}),
				}}
				label="PUMPD Tools"
				onClose={jest.fn()}
				onQuickActionPinnedChange={onQuickActionPinnedChange}
				onRestore={jest.fn()}
				quickActionPlugins={[quickActionPlugin]}
			/>,
		);

		fireEvent.press(screen.getByLabelText('Mock data'));
		fireEvent.press(screen.getByLabelText('Remove from Pill'));

		expect(quickAction).toHaveBeenCalledTimes(1);
		expect(onQuickActionPinnedChange).toHaveBeenCalledWith(
			'data-source',
			false,
		);
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
				onQuickActionPinnedChange={jest.fn()}
				onSelectPlugin={onSelectPlugin}
				pinnedPillQuickActionIds={[]}
				plugins={[plugin]}
				title="Developer Tools"
			/>,
		);

		fireEvent.press(screen.getByTestId('devtools-tool-row-example'));
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
		).toEqual(PlatformColor('labelColor'));
		fireEvent.press(screen.getByLabelText('Window presentation'));
		expect(onModeChange).toHaveBeenCalledWith('window');
	});
});
