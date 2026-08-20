import {
	cleanup,
	fireEvent,
	render,
	screen,
} from '@testing-library/react-native';
import type { DevToolsPanelPlugin, DevToolsPanelProps } from '../types';
import {
	createNavigationPlugin,
	getPinnedRoutes,
	inferNavigationRouteKind,
	navigationRouteDisplayName,
	setRoutePinned,
	subscribePinnedRoutes,
} from './navigation';

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const Container = ({ children }: { children?: React.ReactNode }) =>
		ReactRuntime.createElement(Native.View, null, children);
	const SwipeActionsMock = Object.assign(Container, {
		Actions: Container,
	});
	return {
		Host: ({
			children,
			testID,
		}: {
			children?: React.ReactNode;
			testID?: string;
		}) => ReactRuntime.createElement(Native.View, { testID }, children),
		HStack: Container,
		VStack: Container,
		List: Container,
		Spacer: () => ReactRuntime.createElement(Native.View),
		SwipeActions: SwipeActionsMock,
		Section: ({
			children,
			footer,
			header,
			title,
		}: {
			children?: React.ReactNode;
			footer?: React.ReactNode;
			header?: React.ReactNode;
			title?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				title ? ReactRuntime.createElement(Native.Text, null, title) : null,
				header ?? null,
				children,
				footer ?? null,
			),
		Button: ({
			children,
			label,
			onPress,
		}: {
			children?: React.ReactNode;
			label?: string;
			onPress?: () => void;
		}) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{ accessibilityLabel: label, onPress },
				children ?? ReactRuntime.createElement(Native.Text, null, label),
			),
		DisclosureGroup: ({
			children,
			isExpanded,
			label,
			onIsExpandedChange,
		}: {
			children?: React.ReactNode;
			isExpanded?: boolean;
			label?: string;
			onIsExpandedChange?: (isExpanded: boolean) => void;
		}) => {
			const [open, setOpen] = ReactRuntime.useState(false);
			const expanded = isExpanded ?? open;
			return ReactRuntime.createElement(
				Native.View,
				null,
				ReactRuntime.createElement(
					Native.Pressable,
					{
						onPress: () => {
							setOpen(!expanded);
							onIsExpandedChange?.(!expanded);
						},
					},
					ReactRuntime.createElement(Native.Text, null, label),
				),
				expanded ? children : null,
			);
		},
		Image: ({ systemName }: { systemName?: string }) =>
			ReactRuntime.createElement(Native.View, {
				testID: `sf-${systemName}`,
			}),
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
		Text: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(Native.Text, null, children),
		TextField: ({
			onTextChange,
			placeholder,
		}: {
			onTextChange?: (text: string) => void;
			placeholder?: string;
		}) =>
			ReactRuntime.createElement(Native.TextInput, {
				onChangeText: onTextChange,
				placeholder,
			}),
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	autocorrectionDisabled: (value: unknown) => value,
	buttonStyle: (value: unknown) => value,
	controlSize: (value: unknown) => value,
	disabled: (value: unknown) => value,
	font: (value: unknown) => value,
	foregroundStyle: (value: unknown) => value,
	frame: (value: unknown) => value,
	keyboardType: (value: unknown) => value,
	fixedSize: (value?: unknown) => value,
	lineLimit: (value: unknown) => value,
	listStyle: (value: unknown) => value,
	onSubmit: (value: unknown) => value,
	textInputAutocapitalization: (value: unknown) => value,
	tint: (value: unknown) => value,
}));

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

afterEach(() => {
	for (const path of [...getPinnedRoutes()]) setRoutePinned(path, false);
	cleanup();
});

describe('createNavigationPlugin', () => {
	it('records route changes and deduplicates identical consecutive routes', () => {
		const navigation = createNavigationPlugin();
		navigation.record('/home', { segments: ['(tabs)', 'home'] });
		navigation.record('/home', { segments: ['(tabs)', 'home'] });
		navigation.record('/profile');

		expect(navigation.getEvents().map((event) => event.route)).toEqual([
			'/home',
			'/profile',
		]);
	});

	it('stores route inventory and live stack snapshots', () => {
		const navigation = createNavigationPlugin();
		navigation.updateRoutes([
			{
				id: 'workout',
				path: '/workouts/[id]',
				kind: inferNavigationRouteKind('/workouts/[id]'),
			},
		]);
		navigation.updateStack([
			{ key: 'home', name: 'index', depth: 0, visible: true },
		]);

		expect(navigation.getRoutes()[0]?.kind).toBe('dynamic');
		expect(navigation.getStack()[0]?.visible).toBe(true);
	});

	it('records metadata changes and identifies grouped layout routes as layouts', () => {
		const navigation = createNavigationPlugin();
		navigation.record('/home', { metadata: { source: 'tab' } });
		navigation.record('/home', { metadata: { source: 'deep-link' } });

		expect(navigation.getEvents()).toHaveLength(2);
		expect(inferNavigationRouteKind('(tabs)/_layout')).toBe('layout');
	});

	it('defaults to the Screens title while keeping the navigation plugin id', () => {
		const navigation = createNavigationPlugin();

		expect(navigation.plugin.title).toBe('Screens');
		expect(navigation.plugin.id).toBe('navigation');
	});

	it('derives human names from the last meaningful path segment', () => {
		expect(navigationRouteDisplayName('/(tabs)/(home)')).toBe('Home');
		expect(navigationRouteDisplayName('/train/session/[sessionId]')).toBe(
			'Session Id',
		);
		expect(navigationRouteDisplayName('/train/workout-complete')).toBe(
			'Workout Complete',
		);
		expect(navigationRouteDisplayName('/')).toBe('Root');
	});
});

describe('Screens panel', () => {
	it('renders the current route, stack summary, and back host action', async () => {
		const backRun = jest.fn();
		const navigation = createNavigationPlugin({
			actions: [{ id: 'back', title: 'Go back', run: backRun }],
			onNavigate: jest.fn(),
		});
		navigation.record('/(tabs)/(home)', { segments: ['(tabs)', '(home)'] });
		navigation.updateStack([
			{ key: 'tabs', name: '(tabs)', depth: 0, visible: true },
			{
				key: 'home',
				name: '(home)',
				path: '/(tabs)/(home)',
				depth: 1,
				visible: false,
			},
		]);

		renderPanel(navigation.plugin);
		expect(screen.getByText('Screens')).toBeOnTheScreen();
		expect(screen.getByText('Home')).toBeOnTheScreen();
		expect(screen.getByText('/(tabs)/(home)')).toBeOnTheScreen();
		expect(
			screen.getByText('tabs › home — 2 mounted, 1 visible'),
		).toBeOnTheScreen();

		fireEvent.press(screen.getByLabelText('Back'));
		await Promise.resolve();
		expect(panelProps.actions.run).toHaveBeenCalledWith(
			expect.objectContaining({ pluginId: 'navigation', label: 'Go back' }),
		);
		expect(backRun).toHaveBeenCalledTimes(1);

		expect(screen.queryByText('Visible')).not.toBeOnTheScreen();
		fireEvent.press(screen.getByText(/Stack · \d+/));
		expect(screen.getByText('Visible')).toBeOnTheScreen();
		expect(screen.getByText('Mounted')).toBeOnTheScreen();
	});

	it('jumps to routes, expands dynamic params, and remembers the last value', () => {
		const onNavigate = jest.fn();
		const makePlugin = () => {
			const navigation = createNavigationPlugin({ onNavigate });
			navigation.updateRoutes([
				{ id: 'train', path: '/(tabs)/(train)', kind: 'group' },
				{ id: 'block', path: '/plan/block/[blockId]', kind: 'dynamic' },
				{ id: 'layout', path: '/(tabs)/_layout', kind: 'layout' },
			]);
			return navigation;
		};

		const first = renderPanel(makePlugin().plugin);
		expect(screen.getByText('TABS')).toBeOnTheScreen();
		expect(screen.getByText('All screens · 2')).toBeOnTheScreen();

		fireEvent.press(screen.getByText('Train'));
		expect(onNavigate).toHaveBeenCalledWith('/(tabs)/(train)');

		fireEvent.press(screen.getByText('Block Id'));
		fireEvent.changeText(screen.getByPlaceholderText('blockId'), 'blk_81');
		fireEvent.press(screen.getByLabelText('Go'));
		expect(onNavigate).toHaveBeenCalledWith('/plan/block/blk_81');

		expect(screen.queryByText('/(tabs)/_layout')).not.toBeOnTheScreen();
		fireEvent.press(screen.getByText('Internal & layouts · 1'));
		expect(screen.getByText('/(tabs)/_layout')).toBeOnTheScreen();

		first.unmount();
		renderPanel(makePlugin().plugin);
		fireEvent.press(screen.getByText('Block Id'));
		expect(
			screen.getByPlaceholderText('blockId — last: blk_81'),
		).toBeOnTheScreen();
	});

	it('pins and unpins routes through swipe actions and the module store', () => {
		const pinListener = jest.fn();
		const unsubscribe = subscribePinnedRoutes(pinListener);
		const navigation = createNavigationPlugin({ onNavigate: jest.fn() });
		navigation.updateRoutes([
			{ id: 'coach', path: '/(tabs)/(coach)', kind: 'group' },
		]);

		renderPanel(navigation.plugin);
		expect(screen.getByText('Nothing pinned yet.')).toBeOnTheScreen();
		expect(
			screen.getByText('Swipe any screen to pin it here.'),
		).toBeOnTheScreen();

		fireEvent.press(screen.getByLabelText('Pin'));
		expect(getPinnedRoutes()).toEqual(['/(tabs)/(coach)']);
		expect(pinListener).toHaveBeenCalled();
		expect(screen.getAllByText('/(tabs)/(coach)')).toHaveLength(2);
		expect(screen.getByTestId('sf-star.fill')).toBeOnTheScreen();

		const [unpinButton] = screen.getAllByLabelText('Unpin');
		if (!unpinButton) throw new Error('missing Unpin swipe action');
		fireEvent.press(unpinButton);
		expect(getPinnedRoutes()).toEqual([]);
		expect(screen.getByText('Nothing pinned yet.')).toBeOnTheScreen();
		unsubscribe();
	});

	it('hides jump and deep link affordances when the host handlers are absent', () => {
		const navigation = createNavigationPlugin();
		navigation.updateRoutes([
			{ id: 'settings', path: '/settings', kind: 'static' },
		]);

		renderPanel(navigation.plugin);
		expect(screen.getByText('/settings')).toBeOnTheScreen();
		expect(screen.queryByTestId('sf-chevron.right')).not.toBeOnTheScreen();
		expect(screen.queryByPlaceholderText('pumpd://…')).not.toBeOnTheScreen();
		expect(
			screen.queryByTestId('devtools-navigation-deeplink'),
		).not.toBeOnTheScreen();
	});

	it('opens deep links and filters route rows by search', () => {
		const onOpenDeepLink = jest.fn();
		const navigation = createNavigationPlugin({
			onNavigate: jest.fn(),
			onOpenDeepLink,
		});
		navigation.updateRoutes([
			{ id: 'train', path: '/(tabs)/(train)', kind: 'group' },
			{ id: 'onboarding', path: '/(onboarding)', kind: 'group' },
		]);

		renderPanel(navigation.plugin);
		expect(
			screen.getByTestId('devtools-navigation-deeplink'),
		).toBeOnTheScreen();
		fireEvent.changeText(
			screen.getByPlaceholderText('pumpd://…'),
			'pumpd://train',
		);
		fireEvent.press(screen.getByLabelText('Open'));
		expect(onOpenDeepLink).toHaveBeenCalledWith('pumpd://train');

		expect(screen.getByText('/(onboarding)')).toBeOnTheScreen();
		fireEvent.changeText(
			screen.getByPlaceholderText('Jump to any screen…'),
			'train',
		);
		expect(screen.queryByText('/(onboarding)')).not.toBeOnTheScreen();
		expect(screen.getByText('/(tabs)/(train)')).toBeOnTheScreen();
		expect(screen.getByText('All screens · 1')).toBeOnTheScreen();
	});

	it('lists recent distinct routes and the full history disclosure', () => {
		const onNavigate = jest.fn();
		const navigation = createNavigationPlugin({ onNavigate });
		navigation.record('/subscribe');
		navigation.record('/train/complete');
		navigation.record('/subscribe');
		navigation.record('/home');

		renderPanel(navigation.plugin);
		expect(screen.getByText('Recent')).toBeOnTheScreen();
		expect(screen.getAllByText(/\/subscribe · /)).toHaveLength(1);
		expect(screen.getByText(/\/train\/complete · /)).toBeOnTheScreen();

		fireEvent.press(screen.getByText('Subscribe'));
		expect(onNavigate).toHaveBeenCalledWith('/subscribe');

		fireEvent.press(screen.getByText('History · 4'));
		expect(screen.getAllByText('/subscribe').length).toBeGreaterThanOrEqual(2);
		fireEvent.press(screen.getByLabelText('Clear history'));
		expect(navigation.getEvents()).toHaveLength(0);
	});
});
