import { QueryClient } from '@tanstack/react-query';
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from '@testing-library/react-native';
import type { DevToolsPanelPlugin, DevToolsPanelProps } from '../types';
import { createEnvironmentPlugin } from './environment';
import { createNavigationPlugin } from './navigation';
import { createNetworkPlugin } from './network';
import { createQueryPlugin } from './query';
import { createStoragePlugin } from './storage';

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
		ScrollView: Native.ScrollView,
	};
});

const panelProps: DevToolsPanelProps = {
	onBack: jest.fn(),
	onClose: jest.fn(),
	presentationMode: 'window',
	onPresentationModeChange: jest.fn(),
	actions: {
		run: jest.fn(async (request) => {
			await request.action();
			return true;
		}),
	},
};

function renderPanel(plugin: DevToolsPanelPlugin) {
	const Panel = plugin.Panel;
	return render(<Panel {...panelProps} />);
}

afterEach(cleanup);

describe('built-in diagnostic panels', () => {
	it('renders captured network request details', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			captureUnknownLengthBodies: true,
		});
		const dispose = diagnostics.plugin.install?.();
		const response = {
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			clone: () => ({ text: async () => '{"ok":true}' }),
		} as unknown as Response;
		await diagnostics.instrumentFetch(jest.fn(async () => response))(
			'https://example.test/workouts?limit=10',
		);
		await act(async () => Promise.resolve());

		renderPanel(diagnostics.plugin);
		expect(screen.getByText('Network')).toBeOnTheScreen();
		fireEvent.press(screen.getByText('GET · workouts'));
		expect(screen.getByText('Query parameters')).toBeOnTheScreen();
		expect(screen.getByText(/"ok": true/)).toBeOnTheScreen();
		dispose?.();
	});

	it('renders query cache metadata and lazy data details', () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(['workouts', 'today'], { count: 2 });
		const plugin = createQueryPlugin({ queryClient, captureData: true });
		const dispose = plugin.install?.();

		renderPanel(plugin);
		expect(screen.getAllByText('Queries')[0]).toBeOnTheScreen();
		fireEvent.press(screen.getByText(/workouts/));
		expect(screen.getByText('Metadata')).toBeOnTheScreen();
		expect(screen.getByText('Data')).toBeOnTheScreen();
		dispose?.();
		queryClient.clear();
	});

	it('renders registered storage keys and expected-key validation', async () => {
		const diagnostics = createStoragePlugin({
			adapters: [
				{
					id: 'settings',
					title: 'Settings',
					getAllKeys: () => ['theme'],
					getValue: () => 'dark',
					setValue: jest.fn(),
				},
			],
			rules: [
				{
					adapterId: 'settings',
					key: 'theme',
					expectedType: 'string',
				},
			],
		});
		await act(async () => diagnostics.refresh());

		renderPanel(diagnostics.plugin);
		expect(screen.getByText('Storage')).toBeOnTheScreen();
		expect(screen.getAllByText('theme')[0]).toBeOnTheScreen();
		expect(screen.getByText('Expected keys')).toBeOnTheScreen();
	});

	it('renders declared environment sections and values', () => {
		const plugin = createEnvironmentPlugin({
			sections: [
				{
					title: 'Application',
					values: { API_URL: 'https://example.test', RELEASE: 'development' },
				},
			],
		});

		renderPanel(plugin);
		expect(screen.getByText('Environment')).toBeOnTheScreen();
		expect(screen.getByText('API_URL')).toBeOnTheScreen();
		expect(screen.getByText('https://example.test')).toBeOnTheScreen();
	});

	it('renders navigation history, routes, and live stack tabs', () => {
		const diagnostics = createNavigationPlugin();
		diagnostics.record('/workouts/123');
		diagnostics.updateRoutes([
			{
				id: 'workout-detail',
				path: '/workouts/[id]',
				kind: 'dynamic',
				isInternal: false,
			},
		]);
		diagnostics.updateStack([
			{
				key: 'workout',
				name: 'Workout',
				path: '/workouts/123',
				visible: true,
				depth: 0,
			},
		]);

		renderPanel(diagnostics.plugin);
		expect(screen.getByText('Navigation')).toBeOnTheScreen();
		expect(screen.getAllByText('/workouts/123')[0]).toBeOnTheScreen();
		fireEvent.press(screen.getByRole('tab', { name: 'Routes' }));
		expect(screen.getByText('/workouts/[id]')).toBeOnTheScreen();
		fireEvent.press(screen.getByRole('tab', { name: 'Stack' }));
		expect(screen.getByText('Workout')).toBeOnTheScreen();
	});
});
