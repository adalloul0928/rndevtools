import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import {
	createMutationSnapshot,
	createQueryPlugin,
	createQuerySnapshot,
	formatQueryKey,
	formatQueryKeyRemainder,
	formatRelativeTime,
	type QueryPlugin,
	summarizeError,
} from './query';

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const Container = ({ children }: { children?: React.ReactNode }) =>
		ReactRuntime.createElement(Native.View, null, children);
	const DisclosureGroup = Object.assign(
		({
			children,
			isExpanded,
			onIsExpandedChange,
		}: {
			children?: React.ReactNode;
			isExpanded?: boolean;
			onIsExpandedChange?: (isExpanded: boolean) => void;
		}) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{ onPress: () => onIsExpandedChange?.(!isExpanded) },
				children,
			),
		{ Label: Container },
	);
	const SwipeActions = Object.assign(Container, { Actions: Container });
	return {
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
		DisclosureGroup,
		Host: Container,
		HStack: Container,
		Image: () => ReactRuntime.createElement(Native.View),
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
					: label,
				children,
			),
		List: Container,
		Picker: ({
			children,
			onSelectionChange,
			selection,
		}: {
			children?: React.ReactNode;
			onSelectionChange?: (value: string) => void;
			selection?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				ReactRuntime.Children.map(children, (child: React.ReactElement) => {
					const option = child.props as {
						children?: React.ReactNode;
						modifiers?: ReadonlyArray<Record<string, unknown>>;
					};
					const tagged = option.modifiers?.find(
						(modifier) => 'tag' in modifier,
					) as { tag?: string } | undefined;
					const value = tagged?.tag;
					return ReactRuntime.createElement(
						Native.Pressable,
						{
							accessibilityRole: 'tab',
							accessibilityState: { selected: selection === value },
							onPress: () => {
								if (value !== undefined) onSelectionChange?.(value);
							},
						},
						ReactRuntime.createElement(Native.Text, null, option.children),
					);
				}),
			),
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
		SwipeActions,
		Text: ({
			children,
			modifiers,
		}: {
			children?: React.ReactNode;
			modifiers?: unknown[];
		}) => ReactRuntime.createElement(Native.Text, { modifiers }, children),
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
		VStack: Container,
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	autocorrectionDisabled: () => ({ autocorrectionDisabled: true }),
	badge: (value: unknown) => ({ badge: value }),
	font: (value: unknown) => ({ font: value }),
	foregroundColor: (value: unknown) => ({ foregroundColor: value }),
	frame: (value: unknown) => ({ frame: value }),
	listStyle: (value: unknown) => ({ listStyle: value }),
	pickerStyle: (value: unknown) => ({ pickerStyle: value }),
	tag: (value: unknown) => ({ tag: value }),
	tint: (value: unknown) => ({ tint: value }),
}));

function renderPanel(plugin: QueryPlugin) {
	const run = jest.fn(async () => true);
	const Panel = plugin.Panel;
	render(
		<Panel
			actions={{ run }}
			onBack={jest.fn()}
			onClose={jest.fn()}
			onPresentationModeChange={jest.fn()}
			presentationMode="window"
		/>,
	);
	return run;
}

describe('createQuerySnapshot', () => {
	it('formats query keys as readable breadcrumbs', () => {
		expect(formatQueryKey(['workouts', 'today', { userId: 42 }])).toBe(
			'workouts › today › { "userId": 42 }',
		);
		expect(formatQueryKey(undefined)).toBe('Anonymous mutation');
	});

	it('captures public query state and optional data', () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { gcTime: Number.POSITIVE_INFINITY } },
		});
		queryClient.setQueryData(['workouts', { page: 1 }], { items: [1, 2] });
		const query = queryClient.getQueryCache().getAll()[0];
		if (!query) throw new Error('Expected cached query');

		const snapshot = createQuerySnapshot(query, true, 1024);

		expect(snapshot.key).toContain('workouts');
		expect(snapshot.status).toBe('success');
		expect(snapshot.data).toContain('items');
		expect(snapshot.dataUpdateCount).toBe(1);
		queryClient.clear();
	});
});

describe('query panel formatting helpers', () => {
	it('titles rows with the key segments after the grouping segment', () => {
		expect(formatQueryKeyRemainder(['workouts', 'list', 'week-12'])).toBe(
			'list · week-12',
		);
		expect(formatQueryKeyRemainder(['stats', 12])).toBe('12');
		expect(formatQueryKeyRemainder(['workouts'])).toBe('workouts');
	});

	it('formats relative update times', () => {
		const now = Date.now();
		expect(formatRelativeTime(0, now)).toBeUndefined();
		expect(formatRelativeTime(now - 500, now)).toBe('now');
		expect(formatRelativeTime(now - 5_000, now)).toBe('5s');
		expect(formatRelativeTime(now - 120_000, now)).toBe('2m');
		expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2h');
		expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe('3d');
	});

	it('summarizes live and serialized errors to one line', () => {
		expect(summarizeError(undefined, new Error('boom\nstack'))).toBe(
			'Error: boom',
		);
		expect(
			summarizeError('{"name":"ZodError","message":"expected number"}', null),
		).toBe('ZodError: expected number');
		expect(summarizeError('plain text\nsecond line', null)).toBe('plain text');
		expect(summarizeError(undefined, null)).toBeUndefined();
	});
});

describe('createQueryPlugin', () => {
	it('limits raw cache entries before snapshotting and defers payload serialization', () => {
		const queryClient = new QueryClient();
		for (let index = 0; index < 10; index += 1) {
			queryClient.setQueryData(['query', index], {
				payload: 'x'.repeat(10_000),
			});
		}
		const plugin = createQueryPlugin({
			queryClient,
			captureData: true,
			maxQueries: 2,
			maxStoreBytes: 32 * 1024,
		});
		const dispose = plugin.install?.();

		expect(plugin.getSnapshot().queries).toHaveLength(2);
		expect(plugin.getSnapshot().queries[0]?.data).toBeUndefined();

		dispose?.();
		queryClient.clear();
	});

	it('supports reusable metadata overrides', () => {
		const queryClient = new QueryClient();
		const plugin = createQueryPlugin({
			queryClient,
			id: 'pumpd-query',
			title: 'PUMPD Query',
			description: 'Custom description',
			section: 'Diagnostics',
			systemImage: 'bolt.fill',
		});

		expect(plugin).toEqual(
			expect.objectContaining({
				id: 'pumpd-query',
				title: 'PUMPD Query',
				description: 'Custom description',
				section: 'Diagnostics',
				systemImage: 'bolt.fill',
			}),
		);
	});

	it('rejects invalid retention bounds', () => {
		const queryClient = new QueryClient();
		expect(() => createQueryPlugin({ queryClient, maxQueries: 0 })).toThrow(
			'maxQueries',
		);
		expect(() =>
			createQueryPlugin({ queryClient, maxStoreBytes: Number.NaN }),
		).toThrow('maxStoreBytes');
	});
});

describe('createMutationSnapshot', () => {
	it('captures mutation metadata and variables without private state APIs', () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { gcTime: Number.POSITIVE_INFINITY } },
		});
		const mutation = queryClient.getMutationCache().build(queryClient, {
			mutationKey: ['save-workout'],
			mutationFn: async (variables: { id: string }) => variables,
		});

		const snapshot = createMutationSnapshot(mutation, true, 1024);

		expect(snapshot.key).toContain('save-workout');
		expect(snapshot.status).toBe('idle');
		expect(snapshot.id).toBe(mutation.mutationId);
		queryClient.clear();
	});
});

describe('QueryPanel', () => {
	it('keeps cache-wide confirmations on Android', () => {
		const originalPlatform = Platform.OS;
		Object.defineProperty(Platform, 'OS', {
			configurable: true,
			value: 'android',
		});
		try {
			const queryClient = new QueryClient();
			const plugin = createQueryPlugin({ queryClient });
			const dispose = plugin.install?.();
			const run = renderPanel(plugin);

			fireEvent.press(screen.getByText('Invalidate all'));
			expect(run).toHaveBeenCalledWith(
				expect.objectContaining({
					confirmation: expect.objectContaining({
						title: 'Invalidate all queries?',
					}),
				}),
			);
			fireEvent.press(screen.getByText('Clear query cache'));
			expect(run).toHaveBeenCalledWith(
				expect.objectContaining({
					confirmation: expect.objectContaining({ destructive: true }),
				}),
			);

			dispose?.();
		} finally {
			Object.defineProperty(Platform, 'OS', {
				configurable: true,
				value: originalPlatform,
			});
		}
	});

	it('groups queries by first key segment with a summary header and search', () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(['workouts', 'list', 'week-12'], { items: [1] });
		queryClient.setQueryData(['workouts', 'detail', 'wko_1'], { id: 'wko_1' });
		queryClient.setQueryData(['stats', 'weekly-volume'], { total: 3 });
		const plugin = createQueryPlugin({ queryClient });
		const dispose = plugin.install?.();
		renderPanel(plugin);

		expect(
			screen.getByText('3 CACHED · 0 FETCHING · 0 STALE · 0 ERRORS'),
		).toBeOnTheScreen();
		expect(screen.getByText('workouts · 2')).toBeOnTheScreen();
		expect(screen.getByText('stats · 1')).toBeOnTheScreen();
		expect(screen.getByText('list · week-12')).toBeOnTheScreen();
		expect(screen.getByText('weekly-volume')).toBeOnTheScreen();
		expect(screen.getAllByText('0 observers · fresh')).toHaveLength(3);

		fireEvent.changeText(
			screen.getByPlaceholderText('Search query keys'),
			'stats',
		);
		expect(screen.queryByText('workouts · 2')).toBeNull();
		expect(screen.getByText('stats · 1')).toBeOnTheScreen();

		dispose?.();
		queryClient.clear();
	});

	it('expands a query row into metadata rows and lazy data previews', () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(['home', 'snapshot'], { count: 2 });
		const plugin = createQueryPlugin({ queryClient, captureData: true });
		const dispose = plugin.install?.();
		renderPanel(plugin);

		expect(screen.queryByText('Hash')).toBeNull();
		fireEvent.press(screen.getByText('snapshot'));
		expect(screen.getByText('Hash')).toBeOnTheScreen();
		expect(screen.getByText('Status')).toBeOnTheScreen();
		expect(screen.getByText('Fetch status')).toBeOnTheScreen();
		expect(screen.getByText('Observers')).toBeOnTheScreen();
		expect(screen.getByText('Updated at')).toBeOnTheScreen();
		expect(screen.getByText('Failure count')).toBeOnTheScreen();
		expect(screen.getByText('Data')).toBeOnTheScreen();
		expect(screen.getByText(/"count": 2/)).toBeOnTheScreen();

		dispose?.();
		queryClient.clear();
	});

	it('surfaces query errors in the summary, subtitle, and message line', async () => {
		const queryClient = new QueryClient();
		await queryClient.prefetchQuery({
			queryKey: ['stats', 'progression'],
			queryFn: async () => {
				throw new Error('expected number, got null');
			},
			retry: false,
		});
		const plugin = createQueryPlugin({ queryClient });
		const dispose = plugin.install?.();
		renderPanel(plugin);

		expect(
			screen.getByText('1 CACHED · 0 FETCHING · 1 STALE · 1 ERROR'),
		).toBeOnTheScreen();
		expect(screen.getByText('0 observers · error')).toBeOnTheScreen();
		expect(
			screen.getByText('Error: expected number, got null'),
		).toBeOnTheScreen();

		dispose?.();
		queryClient.clear();
	});

	it('runs row swipe actions through the action service', () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(['workouts', 'list'], { items: [] });
		const plugin = createQueryPlugin({ queryClient });
		const dispose = plugin.install?.();
		const run = renderPanel(plugin);

		fireEvent.press(screen.getByLabelText('Refetch'));
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				pluginId: 'queries',
				label: 'Refetch query',
				confirmation: undefined,
			}),
		);
		fireEvent.press(screen.getByLabelText('Invalidate'));
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'Invalidate query' }),
		);
		fireEvent.press(screen.getByLabelText('Remove'));
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'Remove query',
				confirmation: expect.objectContaining({
					destructive: true,
					title: 'Remove query?',
				}),
			}),
		);

		dispose?.();
		queryClient.clear();
	});

	it('switches to the mutations tab and expands mutation details', () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { gcTime: Number.POSITIVE_INFINITY } },
		});
		queryClient.getMutationCache().build(queryClient, {
			mutationKey: ['save-workout'],
			mutationFn: async (variables: { id: string }) => variables,
		});
		const plugin = createQueryPlugin({ queryClient, captureData: true });
		const dispose = plugin.install?.();
		renderPanel(plugin);

		fireEvent.press(screen.getByRole('tab', { name: 'Mutations' }));
		expect(screen.getByPlaceholderText('Search mutations')).toBeOnTheScreen();
		expect(screen.getByText('recent · 1')).toBeOnTheScreen();
		expect(screen.getByText('0 failures')).toBeOnTheScreen();
		fireEvent.press(screen.getByText('save-workout'));
		expect(screen.getByText('Submitted at')).toBeOnTheScreen();
		expect(screen.getByText('Paused')).toBeOnTheScreen();

		dispose?.();
		queryClient.clear();
	});

	it('renders an empty state per tab', () => {
		const queryClient = new QueryClient();
		const plugin = createQueryPlugin({ queryClient });
		const dispose = plugin.install?.();
		renderPanel(plugin);

		expect(screen.getByText('No queries to show')).toBeOnTheScreen();
		expect(
			screen.getByText('Query cache activity will appear here.'),
		).toBeOnTheScreen();
		fireEvent.press(screen.getByRole('tab', { name: 'Mutations' }));
		expect(screen.getByText('No mutations yet')).toBeOnTheScreen();
		expect(
			screen.getByText('Mutation activity will appear here.'),
		).toBeOnTheScreen();

		dispose?.();
	});

	it('offers cache-wide actions with confirmations', () => {
		const queryClient = new QueryClient();
		const plugin = createQueryPlugin({ queryClient });
		const dispose = plugin.install?.();
		const run = renderPanel(plugin);

		fireEvent.press(screen.getByLabelText('Invalidate all'));
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'Invalidate all queries',
				confirmation: expect.objectContaining({
					title: 'Invalidate all queries?',
				}),
			}),
		);
		fireEvent.press(screen.getByLabelText('Clear query cache'));
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'Clear query cache',
				confirmation: expect.objectContaining({ destructive: true }),
			}),
		);

		dispose?.();
	});
});
