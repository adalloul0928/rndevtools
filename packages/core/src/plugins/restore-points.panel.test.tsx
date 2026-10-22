import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react-native';
import { Platform } from 'react-native';
import type {
	DevToolsActionRequest,
	DevToolsActionServices,
	DevToolsPanelProps,
} from '../types';
import {
	createRestorePointsPlugin,
	type RestorePointStorage,
} from './restore-points';

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const Container = ({ children }: { children?: React.ReactNode }) =>
		ReactRuntime.createElement(Native.View, null, children);
	return {
		Host: Container,
		List: Container,
		Section: ({
			children,
			footer,
			title,
		}: {
			children?: React.ReactNode;
			footer?: React.ReactNode;
			title?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				title ? ReactRuntime.createElement(Native.Text, null, title) : null,
				children,
				footer ?? null,
			),
		Text: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(Native.Text, null, children),
		Label: ({ title }: { title?: string }) =>
			ReactRuntime.createElement(Native.Text, null, title),
		Button: ({ label, onPress }: { label?: string; onPress?: () => void }) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{ accessibilityLabel: label, accessibilityRole: 'button', onPress },
				ReactRuntime.createElement(Native.Text, null, label),
			),
		ContentUnavailableView: ({
			description,
			title,
		}: {
			description?: string;
			title?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				title ? ReactRuntime.createElement(Native.Text, null, title) : null,
				description
					? ReactRuntime.createElement(Native.Text, null, description)
					: null,
			),
		DisclosureGroup: ({
			children,
			label,
		}: {
			children?: React.ReactNode;
			label?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				ReactRuntime.createElement(Native.Text, null, label),
				children,
			),
		LabeledContent: ({
			children,
			label,
		}: {
			children?: React.ReactNode;
			label?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				ReactRuntime.createElement(Native.Text, null, label),
				children,
			),
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	buttonStyle: (value: unknown) => value,
	disabled: (value: unknown) => value,
	font: (value: unknown) => value,
	foregroundStyle: (value: unknown) => value,
	frame: (value: unknown) => value,
	lineLimit: (value: unknown) => value,
	listStyle: (value: unknown) => value,
	tint: (value: unknown) => value,
}));

// '../components/system-icon', as advanced-android-panels.test.tsx mocks them.
jest.mock('../components/nav-controls', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	return {
		NavIconButton: ({
			accessibilityLabel,
			onPress,
		}: {
			accessibilityLabel: string;
			onPress: () => void;
		}) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{ accessibilityLabel, onPress },
				ReactRuntime.createElement(Native.Text, null, accessibilityLabel),
			),
	};
});

jest.mock('../components/system-icon', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	return {
		SystemIcon: () => ReactRuntime.createElement(Native.View),
	};
});

const KEY = '@rndevtools/core/restore-points/v1';
const STORED = JSON.stringify({
	schemaVersion: 1,
	namespace: 'rndevtools-restore-points',
	points: [
		{
			id: 'kept',
			label: 'Kept',
			createdAt: 1,
			sources: [{ sourceId: 'state', sourceTitle: 'State', json: '1' }],
		},
	],
});

function createStorage(initial: string, failingReads: number) {
	const values = new Map<string, string>([[KEY, initial]]);
	let remaining = failingReads;
	const removeItem = jest.fn((key: string) => {
		values.delete(key);
	});
	const storage: RestorePointStorage = {
		getItem: async (key) => {
			if (remaining > 0) {
				remaining -= 1;
				throw new Error('disk unavailable');
			}
			return values.get(key);
		},
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem,
	};
	return { storage, values, removeItem };
}

function createActions() {
	const requests: DevToolsActionRequest[] = [];
	const actions: DevToolsActionServices = {
		run: jest.fn(async (request: DevToolsActionRequest) => {
			requests.push(request);
			await request.action();
			return true;
		}),
	};
	return { actions, requests };
}

function panelProps(actions: DevToolsActionServices): DevToolsPanelProps {
	return {
		actions,
		onBack: jest.fn(),
		onClose: jest.fn(),
		onPresentationModeChange: jest.fn(),
		presentationMode: 'sheet',
	};
}

const source = {
	id: 'state',
	title: 'State',
	capture: () => 1,
	restore: () => {},
};

describe('RestorePointsPanel load errors', () => {
	it('shows the load error and Retry reloads the stored points', async () => {
		const { storage } = createStorage(STORED, 1);
		const diagnostics = createRestorePointsPlugin({
			sources: [source],
			persistence: { storage },
		});
		await diagnostics.ready;
		expect(diagnostics.getLoadError()).toBe('disk unavailable');
		const { actions, requests } = createActions();
		await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

		expect(
			screen.getByText('Stored restore points unavailable'),
		).toBeOnTheScreen();
		expect(screen.getByText(/disk unavailable/)).toBeOnTheScreen();
		expect(screen.getByText('Saved points · 0')).toBeOnTheScreen();

		await fireEvent.press(screen.getByLabelText('Retry loading'));

		await waitFor(() =>
			expect(
				screen.queryByText('Stored restore points unavailable'),
			).toBeNull(),
		);
		expect(requests).toEqual([
			expect.objectContaining({
				pluginId: 'restore-points',
				label: 'Retry loading restore points',
			}),
		]);
		expect(requests[0]?.confirmation).toBeUndefined();
		expect(diagnostics.getLoadError()).toBeUndefined();
		expect(screen.getByText('Saved points · 1')).toBeOnTheScreen();
		expect(screen.getByText(/^Kept/)).toBeOnTheScreen();
	});

	it('discards the stored data behind a destructive confirmation', async () => {
		const { storage, removeItem, values } = createStorage('{not json', 0);
		const diagnostics = createRestorePointsPlugin({
			sources: [source],
			persistence: { storage },
		});
		await diagnostics.ready;
		const { actions, requests } = createActions();
		await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);
		expect(
			screen.getByText(/Restore-point document is malformed\./),
		).toBeOnTheScreen();

		await fireEvent.press(
			screen.getByLabelText('Discard stored restore points'),
		);

		await waitFor(() =>
			expect(
				screen.queryByText('Stored restore points unavailable'),
			).toBeNull(),
		);
		expect(requests).toEqual([
			expect.objectContaining({
				label: 'Discard stored restore points',
				confirmation: expect.objectContaining({
					confirmLabel: 'Discard',
					destructive: true,
				}),
			}),
		]);
		expect(removeItem).toHaveBeenCalledWith(KEY);
		expect(values.has(KEY)).toBe(false);
		expect(diagnostics.getLoadError()).toBeUndefined();
		await act(async () => {
			await diagnostics.capture('After discard');
		});
		expect(diagnostics.getPoints().map((point) => point.label)).toEqual([
			'After discard',
		]);
	});

	it('refuses a capture while the load error stands and surfaces the reason', async () => {
		const { storage, values } = createStorage(STORED, 1);
		const diagnostics = createRestorePointsPlugin({
			sources: [source],
			persistence: { storage },
		});
		await diagnostics.ready;

		await expect(diagnostics.capture('Lost')).rejects.toThrow(
			'Stored restore points could not be loaded (disk unavailable), so nothing was written.',
		);
		expect(values.get(KEY)).toBe(STORED);
	});

	it('renders the banner and its controls on Android', async () => {
		const originalPlatform = Platform.OS;
		Object.defineProperty(Platform, 'OS', {
			configurable: true,
			value: 'android',
		});
		try {
			const { storage } = createStorage(STORED, 1);
			const diagnostics = createRestorePointsPlugin({
				sources: [source],
				persistence: { storage },
			});
			await diagnostics.ready;
			const { actions, requests } = createActions();
			await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

			expect(
				screen.getByText('Stored restore points unavailable'),
			).toBeOnTheScreen();
			expect(screen.getByText('disk unavailable')).toBeOnTheScreen();
			expect(
				screen.getByText('Discard stored restore points'),
			).toBeOnTheScreen();

			await fireEvent.press(screen.getByText('Retry loading'));

			await waitFor(() =>
				expect(
					screen.queryByText('Stored restore points unavailable'),
				).toBeNull(),
			);
			expect(requests[0]?.label).toBe('Retry loading restore points');
			expect(screen.getByText(/^Kept/)).toBeOnTheScreen();
		} finally {
			Object.defineProperty(Platform, 'OS', {
				configurable: true,
				value: originalPlatform,
			});
		}
	});
});
