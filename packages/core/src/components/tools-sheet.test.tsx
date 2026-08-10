import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { DevToolsPanelPlugin } from '../types';
import { ToolsSheet } from './tools-sheet';

jest.mock('@expo/ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	return {
		Icon: () => ReactRuntime.createElement(Native.View),
		ListItem: ({
			children,
			onPress,
			supportingText,
			testID,
		}: {
			children?: React.ReactNode;
			onPress: () => void;
			supportingText?: React.ReactNode;
			testID?: string;
		}) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{ onPress, testID },
				ReactRuntime.createElement(Native.Text, null, children),
				supportingText
					? ReactRuntime.createElement(Native.Text, null, supportingText)
					: null,
			),
	};
});

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const Container = ({ children }: { children?: React.ReactNode }) =>
		ReactRuntime.createElement(Native.View, null, children);
	return {
		Host: Container,
		Group: Container,
		List: Container,
		RNHostView: Container,
		Section: ({
			children,
			title,
		}: {
			children?: React.ReactNode;
			title?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				title ? ReactRuntime.createElement(Native.Text, null, title) : null,
				children,
			),
		BottomSheet: ({
			children,
			onIsPresentedChange,
		}: {
			children?: React.ReactNode;
			onIsPresentedChange: (isPresented: boolean) => void;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				children,
				ReactRuntime.createElement(
					Native.Pressable,
					{
						accessibilityLabel: 'Dismiss native sheet',
						onPress: () => onIsPresentedChange(false),
					},
					ReactRuntime.createElement(Native.Text, null, 'Dismiss'),
				),
			),
		Button: ({
			children,
			label,
			onPress,
		}: {
			children?: React.ReactNode;
			label?: string;
			onPress: () => void;
		}) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{ accessibilityLabel: label, onPress },
				children ?? ReactRuntime.createElement(Native.Text, null, label),
			),
		Label: ({
			children,
			title,
		}: {
			children?: React.ReactNode;
			title?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				children ?? ReactRuntime.createElement(Native.Text, null, title),
			),
		Picker: ({
			children,
			onSelectionChange,
		}: {
			children?: React.ReactNode;
			onSelectionChange: (mode: string) => void;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				children,
				ReactRuntime.createElement(
					Native.Pressable,
					{
						accessibilityLabel: 'Select window presentation',
						onPress: () => onSelectionChange('window'),
					},
					ReactRuntime.createElement(Native.Text, null, 'Window mode'),
				),
			),
		Text: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(Native.Text, null, children),
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	buttonStyle: (value: unknown) => value,
	contentShape: (value: unknown) => value,
	frame: (value: unknown) => value,
	padding: (value: unknown) => value,
	pickerStyle: (value: unknown) => value,
	presentationDetents: (value: unknown) => value,
	presentationDragIndicator: (value: unknown) => value,
	shapes: { rectangle: () => ({ shape: 'rectangle' }) },
	tag: (value: unknown) => value,
}));

const plugin: DevToolsPanelPlugin = {
	id: 'example',
	title: 'Example',
	description: 'Example diagnostics',
	systemImage: 'wrench',
	Panel: ({ presentationMode }) => (
		<Text>{`Panel in ${presentationMode}`}</Text>
	),
};

const actions = { run: jest.fn(async () => true) };

describe('ToolsSheet', () => {
	it('selects a tool, changes presentation, and handles native dismissal', () => {
		const onSelectPlugin = jest.fn();
		const onPresentationModeChange = jest.fn();
		const onClose = jest.fn();
		render(
			<ToolsSheet
				actions={actions}
				isPresented
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
		fireEvent.press(screen.getByLabelText('Select window presentation'));
		fireEvent.press(screen.getByLabelText('Dismiss native sheet'));
		expect(onSelectPlugin).toHaveBeenCalledWith(plugin);
		expect(onPresentationModeChange).toHaveBeenCalledWith('window');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('hosts a selected React Native panel in sheet mode', () => {
		render(
			<ToolsSheet
				actions={actions}
				isPresented
				onBack={jest.fn()}
				onClose={jest.fn()}
				onPresentationModeChange={jest.fn()}
				onQuickActionPinnedChange={jest.fn()}
				onSelectPlugin={jest.fn()}
				pinnedPillQuickActionIds={[]}
				plugins={[plugin]}
				selectedPlugin={plugin}
				title="Developer Tools"
			/>,
		);

		expect(screen.getByText('Panel in sheet')).toBeOnTheScreen();
	});
});
