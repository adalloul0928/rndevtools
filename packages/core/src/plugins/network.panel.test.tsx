import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react-native';
import { Share } from 'react-native';
import type {
	DevToolsActionRequest,
	DevToolsActionServices,
	DevToolsPanelProps,
} from '../types';
import { createNetworkPlugin } from './network';

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const Container = ({
		children,
		testID,
	}: {
		children?: React.ReactNode;
		testID?: string;
	}) => ReactRuntime.createElement(Native.View, { testID }, children);
	return {
		Host: Container,
		List: Container,
		HStack: Container,
		VStack: Container,
		Spacer: () => ReactRuntime.createElement(Native.View),
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
		Text: ({
			children,
			testID,
		}: {
			children?: React.ReactNode;
			testID?: string;
		}) => ReactRuntime.createElement(Native.Text, { testID }, children),
		Button: ({
			children,
			label,
			onPress,
			testID,
		}: {
			children?: React.ReactNode;
			label?: string;
			onPress?: () => void;
			testID?: string;
		}) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{
					accessibilityLabel: label,
					accessibilityRole: 'button',
					onPress,
					testID,
				},
				children ?? ReactRuntime.createElement(Native.Text, null, label),
			),
		Toggle: ({
			children,
			isOn,
			onIsOnChange,
			testID,
		}: {
			children?: React.ReactNode;
			isOn?: boolean;
			onIsOnChange?: (isOn: boolean) => void;
			testID?: string;
		}) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{
					accessibilityRole: 'switch',
					accessibilityState: { checked: isOn },
					onPress: () => onIsOnChange?.(!isOn),
					testID,
				},
				children,
			),
		Picker: ({
			children,
			onSelectionChange,
		}: {
			children?: React.ReactNode;
			onSelectionChange?: (value: string) => void;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				ReactRuntime.Children.map(
					children,
					(
						child: React.ReactElement<{
							children?: React.ReactNode;
							modifiers?: readonly string[];
						}>,
					) => {
						const value = child?.props?.modifiers?.[0];
						return ReactRuntime.createElement(
							Native.Pressable,
							{
								accessibilityLabel: `network-filter-${value}`,
								onPress: () => onSelectionChange?.(String(value)),
							},
							ReactRuntime.createElement(
								Native.Text,
								null,
								child?.props?.children,
							),
						);
					},
				),
			),
		TextField: ({
			onTextChange,
			placeholder,
			testID,
		}: {
			onTextChange?: (text: string) => void;
			placeholder?: string;
			testID?: string;
		}) =>
			ReactRuntime.createElement(Native.TextInput, {
				onChangeText: onTextChange,
				placeholder,
				testID,
			}),
		Image: ({ onPress, testID }: { onPress?: () => void; testID?: string }) =>
			onPress
				? ReactRuntime.createElement(Native.Pressable, { onPress, testID })
				: ReactRuntime.createElement(Native.View, { testID }),
		LabeledContent: ({
			children,
			label,
		}: {
			children?: React.ReactNode;
			label?: React.ReactNode;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				typeof label === 'string'
					? ReactRuntime.createElement(Native.Text, null, label)
					: (label ?? null),
				children,
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
		ContentUnavailableView: ({
			description,
			testID,
			title,
		}: {
			description?: string;
			testID?: string;
			title?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				{ testID },
				ReactRuntime.createElement(Native.Text, null, title),
				description
					? ReactRuntime.createElement(Native.Text, null, description)
					: null,
			),
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	autocorrectionDisabled: () => 'autocorrectionDisabled',
	badge: (value: unknown) => ({ badge: value }),
	buttonStyle: (value: unknown) => value,
	font: (value: unknown) => value,
	foregroundStyle: (value: unknown) => value,
	frame: (value: unknown) => value,
	listStyle: (value: unknown) => value,
	pickerStyle: (value: unknown) => value,
	tag: (value: unknown) => value,
	textSelection: (value: unknown) => value,
	tint: (value: unknown) => value,
}));

function response(body: string, status = 200): Response {
	const headers = new Headers({
		'content-length': String(new TextEncoder().encode(body).byteLength),
		'content-type': 'application/json',
	});
	return {
		status,
		headers,
		clone: () => ({
			text: async () => body,
		}),
	} as unknown as Response;
}

async function flushCapture(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createActions(): DevToolsActionServices & { run: jest.Mock } {
	return {
		run: jest.fn(async (request: DevToolsActionRequest) => {
			await request.action();
			return true;
		}),
	};
}

function panelProps(actions: DevToolsActionServices): DevToolsPanelProps {
	return {
		actions,
		onBack: jest.fn(),
		onClose: jest.fn(),
		onPresentationModeChange: jest.fn(),
		presentationMode: 'sheet',
		safeAreaTop: 0,
	};
}

async function seededDiagnostics() {
	const diagnostics = createNetworkPlugin();
	const dispose = diagnostics.plugin.install?.();
	const instrumented = diagnostics.instrumentFetch(
		jest
			.fn()
			.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch,
	);
	await instrumented('https://abc.supabase.co/rest/v1/workouts?select=id');
	await instrumented('https://o123.ingest.sentry.io/api/1/envelope/', {
		method: 'POST',
	});
	await flushCapture();
	return { diagnostics, dispose };
}

describe('NetworkPanel', () => {
	it('lists requests, hides system traffic by default, and filters segments', async () => {
		const { diagnostics, dispose } = await seededDiagnostics();
		render(<diagnostics.plugin.Panel {...panelProps(createActions())} />);

		expect(screen.getByText('workouts')).toBeOnTheScreen();
		expect(screen.queryByTestId('devtools-network-row-2')).toBeNull();
		expect(screen.getByText('1 hidden')).toBeOnTheScreen();

		fireEvent.press(screen.getByTestId('devtools-network-hide-system'));
		expect(screen.getByTestId('devtools-network-row-2')).toBeOnTheScreen();
		expect(screen.getByText('1 shown')).toBeOnTheScreen();

		fireEvent.press(screen.getByLabelText('network-filter-errors'));
		expect(screen.queryByText('workouts')).toBeNull();
		expect(screen.getByText('No matches')).toBeOnTheScreen();

		dispose?.();
	});

	it('opens the request detail sub-view and returns to the list', async () => {
		const { diagnostics, dispose } = await seededDiagnostics();
		render(<diagnostics.plugin.Panel {...panelProps(createActions())} />);

		// The native search field does not survive the detail round trip, so the
		// list must come back unfiltered rather than behind an empty search box.
		fireEvent.changeText(
			screen.getByTestId('devtools-network-search'),
			'workouts',
		);
		fireEvent.press(screen.getByTestId('devtools-network-row-1'));
		expect(screen.getByText('GET workouts')).toBeOnTheScreen();
		expect(screen.getByText('Overview')).toBeOnTheScreen();
		expect(screen.getByTestId('devtools-network-share')).toBeOnTheScreen();

		fireEvent.press(screen.getByTestId('devtools-panel-back'));
		expect(screen.getByTestId('devtools-network-search')).toBeOnTheScreen();
		fireEvent.press(screen.getByTestId('devtools-network-hide-system'));
		expect(screen.getByTestId('devtools-network-row-2')).toBeOnTheScreen();

		dispose?.();
	});

	it('clears requests through a destructive confirmation', async () => {
		const { diagnostics, dispose } = await seededDiagnostics();
		const actions = createActions();
		render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

		fireEvent.press(
			within(screen.getByTestId('devtools-network-clear')).getByRole('button'),
		);

		expect(await screen.findByText('No requests')).toBeOnTheScreen();
		expect(actions.run).toHaveBeenCalledWith(
			expect.objectContaining({
				pluginId: 'network',
				label: 'Clear requests',
				confirmation: expect.objectContaining({ destructive: true }),
			}),
		);
		expect(diagnostics.getEvents()).toEqual([]);

		dispose?.();
	});

	it('toggles capture pause from the nav bar', async () => {
		const { diagnostics, dispose } = await seededDiagnostics();
		render(<diagnostics.plugin.Panel {...panelProps(createActions())} />);

		fireEvent.press(
			within(screen.getByTestId('devtools-network-pause')).getByRole('button'),
		);
		expect(diagnostics.isPaused()).toBe(true);
		fireEvent.press(
			within(screen.getByTestId('devtools-network-pause')).getByRole('button'),
		);
		expect(diagnostics.isPaused()).toBe(false);

		dispose?.();
	});

	it('re-sends the captured request and shares a cURL command from the detail view', async () => {
		const { diagnostics, dispose } = await seededDiagnostics();
		const actions = createActions();
		const previousFetch = globalThis.fetch;
		const fetchMock = jest
			.fn()
			.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		const shareSpy = jest
			.spyOn(Share, 'share')
			.mockResolvedValue({ action: 'sharedAction' } as Awaited<
				ReturnType<typeof Share.share>
			>);
		render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

		fireEvent.press(screen.getByTestId('devtools-network-row-1'));
		fireEvent.press(screen.getByTestId('devtools-network-resend'));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				'https://abc.supabase.co/rest/v1/workouts?select=id',
				expect.objectContaining({ method: 'GET' }),
			);
		});
		expect(actions.run).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'Re-send request' }),
		);

		fireEvent.press(screen.getByTestId('devtools-network-copy-curl'));
		expect(shareSpy).toHaveBeenCalledWith({
			message: expect.stringContaining('curl -X GET'),
		});

		shareSpy.mockRestore();
		globalThis.fetch = previousFetch;
		dispose?.();
	});

	it('warns before a replay and never re-sends redacted credentials', async () => {
		const diagnostics = createNetworkPlugin();
		const dispose = diagnostics.plugin.install?.();
		const instrumented = diagnostics.instrumentFetch(
			jest
				.fn()
				.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch,
		);
		await instrumented('https://abc.supabase.co/rest/v1/workouts', {
			method: 'POST',
			headers: {
				authorization: 'Bearer real-token',
				accept: 'application/json',
			},
			body: '{"name":"Push"}',
		});
		await flushCapture();
		const actions = createActions();
		const previousFetch = globalThis.fetch;
		const fetchMock = jest
			.fn()
			.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

		fireEvent.press(screen.getByTestId('devtools-network-row-1'));
		fireEvent.press(screen.getByTestId('devtools-network-resend'));

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		const [, init] = (fetchMock as unknown as jest.Mock).mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(init.headers).toEqual({ accept: 'application/json' });
		expect(actions.run).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'Re-send request',
				confirmation: expect.objectContaining({
					destructive: true,
					message: expect.stringContaining('1 header dropped'),
				}),
			}),
		);

		globalThis.fetch = previousFetch;
		dispose?.();
	});
});
