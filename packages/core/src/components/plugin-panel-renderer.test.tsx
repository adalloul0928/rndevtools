import { fireEvent, render, screen } from '@testing-library/react-native';
import type { DevToolsPanelPlugin, DevToolsPanelProps } from '../types';
import { PluginPanelRenderer } from './plugin-panel-renderer';

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
	foregroundStyle: (value: unknown) => value,
}));

jest.mock('react-native-gesture-handler', () => {
	const Native = jest.requireActual('react-native');
	return {
		RectButton: Native.Pressable,
		FlatList: Native.FlatList,
	};
});

const panelProps: DevToolsPanelProps = {
	onBack: jest.fn(),
	onClose: jest.fn(),
	presentationMode: 'window',
	onPresentationModeChange: jest.fn(),
	actions: { run: jest.fn(async () => true) },
};

describe('PluginPanelRenderer', () => {
	it('contains a panel crash and reports the plugin identity', () => {
		const consoleError = jest.spyOn(console, 'error').mockImplementation();
		const onError = jest.fn();
		const plugin: DevToolsPanelPlugin = {
			id: 'broken',
			title: 'Broken tool',
			description: 'Crashes for testing',
			systemImage: 'exclamationmark.triangle',
			Panel: () => {
				throw new Error('panel exploded');
			},
		};

		render(
			<PluginPanelRenderer
				onError={onError}
				panelProps={panelProps}
				plugin={plugin}
			/>,
		);

		expect(
			screen.getByText('This tool encountered an error.'),
		).toBeOnTheScreen();
		expect(screen.getByText('panel exploded')).toBeOnTheScreen();
		expect(onError).toHaveBeenCalledWith(expect.any(Error), 'broken');
		fireEvent.press(screen.getByText('Return to tools'));
		expect(panelProps.onBack).toHaveBeenCalledTimes(1);
		consoleError.mockRestore();
	});
});
