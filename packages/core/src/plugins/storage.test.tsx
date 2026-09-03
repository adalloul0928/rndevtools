import {
	act,
	fireEvent,
	render,
	screen,
	within,
} from '@testing-library/react-native';
import { Platform } from 'react-native';
import type { DevToolsActionRequest, DevToolsPanelProps } from '../types';
import {
	createStoragePlugin,
	isStorageEntryEditable,
	parseStorageDraft,
	validateStorageSnapshot,
} from './storage';

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const Container = ({ children }: { children?: React.ReactNode }) =>
		ReactRuntime.createElement(Native.View, null, children);
	const DisclosureLabel = ({ children }: { children?: React.ReactNode }) =>
		ReactRuntime.createElement(Native.View, null, children);
	const DisclosureGroup = ({
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
		const kids = ReactRuntime.Children.toArray(children);
		const labelKids = kids.filter(
			(child: React.ReactElement) => child.type === DisclosureLabel,
		);
		const contentKids = kids.filter(
			(child: React.ReactElement) => child.type !== DisclosureLabel,
		);
		return ReactRuntime.createElement(
			Native.View,
			null,
			ReactRuntime.createElement(
				Native.Pressable,
				{
					accessibilityRole: 'button',
					onPress: () => onIsExpandedChange?.(!isExpanded),
				},
				labelKids.length
					? labelKids
					: label
						? ReactRuntime.createElement(Native.Text, null, label)
						: null,
			),
			contentKids,
		);
	};
	DisclosureGroup.Label = DisclosureLabel;
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
				{ accessibilityLabel: label, accessibilityRole: 'button', onPress },
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
		Host: ({
			children,
			testID,
		}: {
			children?: React.ReactNode;
			testID?: string;
		}) => ReactRuntime.createElement(Native.View, { testID }, children),
		HStack: Container,
		Image: ({
			onPress,
			systemName,
		}: {
			onPress?: () => void;
			systemName?: string;
		}) =>
			onPress
				? ReactRuntime.createElement(Native.Pressable, {
						accessibilityLabel: systemName,
						onPress,
					})
				: ReactRuntime.createElement(Native.View, null),
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
			onSelectionChange: (value: string) => void;
			selection: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				ReactRuntime.Children.map(children, (child: React.ReactElement) => {
					const option = child.props as {
						children: string;
						modifiers?: Array<{ tag?: string }>;
					};
					const value = option.modifiers?.find((item) => item.tag)?.tag;
					return ReactRuntime.createElement(
						Native.Pressable,
						{
							accessibilityLabel: option.children,
							accessibilityRole: 'tab',
							accessibilityState: { selected: selection === value },
							onPress: () => value && onSelectionChange(value),
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
		Spacer: () => ReactRuntime.createElement(Native.View, null),
		Text: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(Native.Text, null, children),
		TextField: ({
			onTextChange,
			placeholder,
			text,
		}: {
			onTextChange?: (value: string) => void;
			placeholder?: string;
			text?: { value: string };
		}) =>
			ReactRuntime.createElement(Native.TextInput, {
				accessibilityLabel: placeholder,
				defaultValue: text?.value,
				onChangeText: onTextChange,
			}),
		useNativeState: (initialValue: unknown) => ({ value: initialValue }),
		VStack: Container,
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	autocorrectionDisabled: () => ({}),
	buttonStyle: (value: unknown) => value,
	font: (value: unknown) => value,
	foregroundStyle: (value: unknown) => value,
	frame: (value: unknown) => value,
	lineLimit: (value: unknown) => value,
	listRowBackground: (value: unknown) => value,
	listStyle: (value: unknown) => value,
	pickerStyle: (value: unknown) => value,
	refreshable: (value: unknown) => value,
	tag: (value: unknown) => ({ tag: value }),
	tint: (value: unknown) => value,
}));

function createPanelProps() {
	const run = jest.fn(async (request: DevToolsActionRequest) => {
		await request.action();
		return true;
	});
	const props: DevToolsPanelProps = {
		onBack: jest.fn(),
		onClose: jest.fn(),
		presentationMode: 'sheet',
		onPresentationModeChange: jest.fn(),
		actions: { run },
	};
	return { props, run };
}

describe('storage panel UI', () => {
	it('renders store rows, health, and recent activity on the root view', async () => {
		let theme = 'dark';
		const readSecure = jest.fn(() => 'secret');
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'app',
					title: 'App Storage',
					description: 'Preferences and UI state',
					getAllKeys: () => ['settings/theme'],
					getValue: () => theme,
					setValue: jest.fn(),
				},
				{
					id: 'secure',
					title: 'Secure Storage',
					description: 'Auth session',
					sensitive: true,
					getAllKeys: () => ['auth/token'],
					getValue: readSecure,
				},
			],
			rules: [
				{ adapterId: 'app', key: 'settings/theme', expectedType: 'string' },
			],
		});
		await storage.refresh();
		theme = 'light';
		await storage.refresh();
		const { props } = createPanelProps();
		const Panel = storage.plugin.Panel;
		render(<Panel {...props} />);

		expect(screen.getByText('ON THIS DEVICE · 5 B')).toBeOnTheScreen();
		expect(screen.getByText('App Storage')).toBeOnTheScreen();
		expect(
			screen.getByText('Preferences and UI state · 1 key · 5 B'),
		).toBeOnTheScreen();
		expect(
			screen.getByText('Auth session · 1 key · values hidden'),
		).toBeOnTheScreen();
		expect(readSecure).not.toHaveBeenCalled();
		expect(
			screen.getByText('All expected keys present · 1 check'),
		).toBeOnTheScreen();
		expect(screen.getByText('Updated')).toBeOnTheScreen();
		expect(screen.getByText('settings/theme')).toBeOnTheScreen();
		expect(screen.getByText(/App Storage · (now|\d+[smhd])/)).toBeOnTheScreen();

		fireEvent.press(screen.getByText('See all activity'));
		expect(screen.getByText('JUST NOW')).toBeOnTheScreen();
		expect(
			screen.getByTestId('devtools-storage-clear-activity'),
		).toBeOnTheScreen();

		fireEvent.press(screen.getByTestId('devtools-panel-back'));
		expect(props.onBack).toHaveBeenCalledTimes(1);
	});

	it('lists failing checks as expandable health issues', async () => {
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'app',
					title: 'App Storage',
					getAllKeys: () => [],
				},
			],
			rules: [
				{
					adapterId: 'app',
					key: 'flags/enabled',
					description: 'Feature flag overrides',
				},
			],
		});
		await storage.refresh();
		const { props } = createPanelProps();
		const Panel = storage.plugin.Panel;
		render(<Panel {...props} />);

		expect(screen.getByText('1 of 1 check failing')).toBeOnTheScreen();
		expect(screen.getByText('flags/enabled — Missing')).toBeOnTheScreen();
		expect(screen.getByText('Feature flag overrides')).toBeOnTheScreen();
		expect(screen.getByText('present')).toBeOnTheScreen();
	});

	it('browses a store, edits a value, deletes a key, and clears the store', async () => {
		const setValue = jest.fn();
		const removeValue = jest.fn();
		const clear = jest.fn();
		const values: Record<string, unknown> = {
			'settings/theme-preference': 'dark',
			'settings/haptics': true,
			snapshot: 'x'.repeat(30),
		};
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'app',
					title: 'App Storage',
					getAllKeys: () => Object.keys(values),
					getValue: (key) => values[key],
					setValue,
					removeValue,
					clear,
				},
			],
		});
		await storage.refresh();
		const { props, run } = createPanelProps();
		const Panel = storage.plugin.Panel;
		render(<Panel {...props} />);

		fireEvent.press(screen.getByText('App Storage'));
		expect(screen.getByLabelText('Search 3 keys')).toBeOnTheScreen();
		expect(screen.getByText('SETTINGS · 2 KEYS')).toBeOnTheScreen();
		expect(screen.getByText('other · 1 key')).toBeOnTheScreen();
		expect(screen.getByText('theme-preference')).toBeOnTheScreen();
		expect(screen.getByText('string · 4 chars')).toBeOnTheScreen();
		expect(screen.getByText('"dark"')).toBeOnTheScreen();
		expect(screen.getByText('boolean')).toBeOnTheScreen();
		expect(screen.getByText('string · 30 chars')).toBeOnTheScreen();

		fireEvent.changeText(screen.getByLabelText('Search 3 keys'), 'haptics');
		expect(screen.queryByText('theme-preference')).not.toBeOnTheScreen();
		expect(screen.getByText('haptics')).toBeOnTheScreen();
		fireEvent.changeText(screen.getByLabelText('Search 3 keys'), '');

		fireEvent.press(screen.getByText('theme-preference'));
		expect(screen.getByText('settings/theme-preference')).toBeOnTheScreen();
		fireEvent.changeText(screen.getByLabelText('Value'), 'light');
		await act(async () => {
			fireEvent.press(screen.getByText('Save'));
		});
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'Save storage value' }),
		);
		expect(setValue).toHaveBeenCalledWith('settings/theme-preference', 'light');

		await act(async () => {
			fireEvent.press(screen.getByText('Delete key'));
		});
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'Delete storage value',
				confirmation: expect.objectContaining({
					confirmLabel: 'Delete',
					destructive: true,
				}),
			}),
		);
		expect(removeValue).toHaveBeenCalledWith('settings/theme-preference');

		await act(async () => {
			fireEvent.press(
				within(screen.getByTestId('devtools-storage-clear-store')).getByRole(
					'button',
				),
			);
		});
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'Clear storage adapter',
				confirmation: expect.objectContaining({
					title: 'Clear App Storage?',
					destructive: true,
				}),
			}),
		);
		expect(clear).toHaveBeenCalledTimes(1);

		fireEvent.press(screen.getByTestId('devtools-panel-back'));
		expect(screen.getByText(/ON THIS DEVICE/)).toBeOnTheScreen();
		expect(props.onBack).not.toHaveBeenCalled();
		fireEvent.press(screen.getByTestId('devtools-panel-back'));
		expect(props.onBack).toHaveBeenCalledTimes(1);
	});

	it('supports inspecting, editing, and deleting a key on Android', async () => {
		const originalPlatform = Platform.OS;
		Object.defineProperty(Platform, 'OS', {
			configurable: true,
			value: 'android',
		});
		try {
			const setValue = jest.fn();
			const removeValue = jest.fn();
			const storage = createStoragePlugin({
				adapters: [
					{
						id: 'app',
						title: 'App Storage',
						getAllKeys: () => ['settings/theme'],
						getValue: () => 'dark',
						setValue,
						removeValue,
					},
				],
			});
			await storage.refresh();
			const { props, run } = createPanelProps();
			const Panel = storage.plugin.Panel;
			render(<Panel {...props} />);

			fireEvent.press(screen.getByText('App Storage'));
			fireEvent.press(screen.getByText('settings/theme'));
			fireEvent.changeText(screen.getByPlaceholderText('Value'), 'light');
			await act(async () => {
				fireEvent.press(screen.getByText('Save value'));
			});
			await act(async () => {
				fireEvent.press(screen.getByText('Delete key'));
			});

			expect(run).toHaveBeenCalledWith(
				expect.objectContaining({ label: 'Save storage value' }),
			);
			expect(setValue).toHaveBeenCalledWith('settings/theme', 'light');
			expect(removeValue).toHaveBeenCalledWith('settings/theme');
		} finally {
			Object.defineProperty(Platform, 'OS', {
				configurable: true,
				value: originalPlatform,
			});
		}
	});

	it('shows the activity log with diffs and clears the event store', async () => {
		let value = 'first';
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'app',
					title: 'App Storage',
					getAllKeys: () => ['settings/theme'],
					getValue: () => value,
				},
			],
		});
		await storage.refresh();
		value = 'second';
		await storage.refresh();
		const { props, run } = createPanelProps();
		const Panel = storage.plugin.Panel;
		render(<Panel {...props} />);

		fireEvent.press(screen.getByRole('tab', { name: 'Activity' }));
		expect(screen.getByText('JUST NOW')).toBeOnTheScreen();
		expect(screen.getByText('Updated')).toBeOnTheScreen();
		expect(screen.getByText(/App Storage · .+ · 6 chars/)).toBeOnTheScreen();
		expect(screen.getByText('- first')).toBeOnTheScreen();
		expect(screen.getByText('+ second')).toBeOnTheScreen();

		await act(async () => {
			fireEvent.press(
				within(screen.getByTestId('devtools-storage-clear-activity')).getByRole(
					'button',
				),
			);
		});
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'Clear storage activity',
				confirmation: expect.objectContaining({
					title: 'Clear recorded activity?',
					destructive: true,
				}),
			}),
		);
		expect(storage.getEvents()).toEqual([]);
		expect(screen.getByText('No storage activity')).toBeOnTheScreen();
		expect(
			screen.getByText('Storage mutations will appear here.'),
		).toBeOnTheScreen();
	});

	it('keeps protected values unread in the store browser', async () => {
		const readSecure = jest.fn(() => 'secret');
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'secure',
					title: 'Secure Storage',
					sensitive: true,
					getAllKeys: () => ['auth/token'],
					getValue: readSecure,
				},
			],
		});
		await storage.refresh();
		const { props } = createPanelProps();
		const Panel = storage.plugin.Panel;
		render(<Panel {...props} />);

		fireEvent.press(screen.getByText('Secure Storage'));
		expect(screen.getByLabelText('Search 1 key')).toBeOnTheScreen();
		expect(screen.getByText('AUTH · 1 KEY')).toBeOnTheScreen();
		expect(screen.getByText('Value protected')).toBeOnTheScreen();

		fireEvent.press(screen.getByText('token'));
		expect(
			screen.getByText(
				'This store exposes key metadata only. Its values are never read.',
			),
		).toBeOnTheScreen();
		expect(screen.queryByLabelText('Value')).not.toBeOnTheScreen();
		expect(screen.queryByText('Save')).not.toBeOnTheScreen();
		expect(screen.queryByText('Delete key')).not.toBeOnTheScreen();
		expect(readSecure).not.toHaveBeenCalled();
	});
});

describe('createStoragePlugin', () => {
	it('loads registered values but never reads protected adapter values', async () => {
		const readStandard = jest.fn(() => 'value');
		const readSecure = jest.fn(() => 'secret');
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys: () => ['key'],
					getValue: readStandard,
				},
				{
					id: 'secure',
					title: 'Secure',
					sensitive: true,
					getAllKeys: () => ['token'],
					getValue: readSecure,
				},
			],
		});

		await storage.refresh();

		expect(readStandard).toHaveBeenCalledWith('key');
		expect(readSecure).not.toHaveBeenCalled();
		expect(storage.getSnapshot().adapters[1]?.entries[0]).toEqual({
			binary: false,
			key: 'token',
			truncated: false,
			valueHidden: true,
		});
	});

	it('bounds adapter snapshots by entry count and reports incomplete validation', async () => {
		const getValue = jest.fn((key: string) => `value:${key}`);
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys: () => ['third', 'first', 'second'],
					getValue,
				},
			],
			maxEntriesPerAdapter: 2,
			rules: [{ adapterId: 'standard', key: 'third' }],
		});

		await storage.refresh();

		const snapshot = storage.getSnapshot();
		expect(snapshot.adapters[0]).toEqual(
			expect.objectContaining({
				omittedKeyCount: 1,
				totalKeyCount: 3,
				truncated: true,
			}),
		);
		expect(snapshot.adapters[0]?.entries.map((entry) => entry.key)).toEqual([
			'first',
			'second',
		]);
		expect(getValue).toHaveBeenCalledTimes(2);
		expect(
			validateStorageSnapshot(snapshot, [
				{ adapterId: 'standard', key: 'third' },
			]),
		).toEqual([expect.objectContaining({ status: 'notCaptured' })]);
	});

	it('bounds the serialized bytes retained by each adapter', async () => {
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys: () => ['first', 'second'],
					getValue: () => 'x'.repeat(4_096),
				},
			],
			maxAdapterBytes: 512,
			maxValueBytes: 4_096,
		});

		await storage.refresh();

		const snapshot = storage.getSnapshot().adapters[0];
		expect(snapshot?.estimatedBytes).toBeLessThanOrEqual(512);
		expect(snapshot?.truncated).toBe(true);
		expect(snapshot?.entries[0]?.truncated).toBe(true);
	});

	it('does not fabricate activity while either snapshot is incomplete', async () => {
		let keys = ['first', 'second'];
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys: () => keys,
					getValue: (key) => key,
				},
			],
			maxEntriesPerAdapter: 1,
		});

		await storage.refresh();
		keys = ['second'];
		await storage.refresh();

		expect(storage.getEvents()).toEqual([]);
	});

	it('validates expected keys and records adapter changes after its baseline', async () => {
		let value = 'first';
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys: () => ['key'],
					getValue: () => value,
				},
			],
			rules: [{ adapterId: 'standard', key: 'key', expectedType: 'string' }],
		});
		await storage.refresh();
		expect(
			validateStorageSnapshot(storage.getSnapshot(), [
				{ adapterId: 'standard', key: 'key', expectedType: 'string' },
			])[0]?.status,
		).toBe('valid');

		value = 'second';
		await storage.refresh();
		expect(storage.getEvents()).toEqual([
			expect.objectContaining({
				adapterId: 'standard',
				key: 'key',
				type: 'updated',
				previousValue: 'first',
				value: 'second',
			}),
		]);
	});

	it('preserves primitive types and rejects unsafe storage edits', () => {
		expect(parseStorageDraft('42', 'number')).toBe(42);
		expect(parseStorageDraft('false', 'boolean')).toBe(false);
		expect(parseStorageDraft('{"ok":true}', 'object')).toEqual({ ok: true });
		expect(() => parseStorageDraft('no', 'boolean')).toThrow('true or false');
		const adapter = {
			id: 'standard',
			title: 'Standard',
			getAllKeys: () => [],
			setValue: jest.fn(),
		};
		expect(
			isStorageEntryEditable(adapter, {
				key: 'large',
				value: 'partial',
				valueType: 'string',
				truncated: true,
				valueHidden: false,
				binary: false,
			}),
		).toBe(false);
	});

	it('redacts credential-shaped values and disables edits of altered previews', async () => {
		const adapter = {
			id: 'standard',
			title: 'Standard',
			getAllKeys: () => ['session'],
			getValue: () => ({ accessToken: 'private-token', ready: true }),
			setValue: jest.fn(),
		};
		const storage = createStoragePlugin({ adapters: [adapter] });

		await storage.refresh();
		const entry = storage.getSnapshot().adapters[0]?.entries[0];
		expect(entry?.value).toContain('[REDACTED]');
		expect(entry?.value).not.toContain('private-token');
		expect(entry?.redacted).toBe(true);
		expect(entry && isStorageEntryEditable(adapter, entry)).toBe(false);
	});

	it('never invokes accessors returned as storage values or key-list items', async () => {
		const valueGetter = jest.fn(() => 'must not run');
		const value = {} as Record<string, unknown>;
		Object.defineProperty(value, 'unsafe', {
			enumerable: true,
			get: valueGetter,
		});
		const keys: string[] = [];
		const keyGetter = jest.fn(() => 'unsafe-key');
		Object.defineProperty(keys, '0', {
			enumerable: true,
			get: keyGetter,
		});
		keys.length = 1;
		const safeStorage = createStoragePlugin({
			adapters: [
				{
					id: 'safe',
					title: 'Safe',
					getAllKeys: () => ['value'],
					getValue: () => value,
				},
			],
		});
		const unsafeKeys = createStoragePlugin({
			adapters: [{ id: 'unsafe', title: 'Unsafe', getAllKeys: () => keys }],
		});

		await safeStorage.refresh();
		await unsafeKeys.refresh();
		expect(valueGetter).not.toHaveBeenCalled();
		expect(keyGetter).not.toHaveBeenCalled();
		expect(safeStorage.getSnapshot().adapters[0]?.entries[0]?.truncated).toBe(
			true,
		);
		expect(unsafeKeys.getSnapshot().adapters[0]?.error).toContain(
			'holes or accessors',
		);
	});

	it('rolls back subscriptions if a later adapter fails to subscribe', () => {
		const unsubscribe = jest.fn();
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'first',
					title: 'First',
					getAllKeys: () => [],
					subscribe: () => unsubscribe,
				},
				{
					id: 'second',
					title: 'Second',
					getAllKeys: () => [],
					subscribe: () => {
						throw new Error('subscribe failed');
					},
				},
			],
		});

		expect(() => storage.plugin.install?.()).toThrow('subscribe failed');
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('rejects invalid subscription disposers and rolls back earlier adapters', () => {
		const unsubscribe = jest.fn();
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'first',
					title: 'First',
					getAllKeys: () => [],
					subscribe: () => unsubscribe,
				},
				{
					id: 'invalid',
					title: 'Invalid',
					getAllKeys: () => [],
					subscribe: (() => undefined) as unknown as () => () => void,
				},
			],
		});

		expect(() => storage.plugin.install?.()).toThrow(
			'did not return an unsubscribe function',
		);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('does not fabricate removals when an adapter refresh fails', async () => {
		let fail = false;
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys: () => {
						if (fail) throw new Error('offline');
						return ['key'];
					},
					getValue: () => 'value',
				},
			],
		});
		await storage.refresh();
		fail = true;
		await storage.refresh();
		expect(storage.getEvents()).toEqual([]);
		expect(storage.getSnapshot().adapters[0]?.error).toBe('offline');
	});

	it('rejects invalid value bounds', () => {
		expect(() =>
			createStoragePlugin({ adapters: [], maxValueBytes: 0 }),
		).toThrow('maxValueBytes');
		expect(() =>
			createStoragePlugin({ adapters: [], maxEntriesPerAdapter: 1.5 }),
		).toThrow('maxEntriesPerAdapter');
		expect(() =>
			createStoragePlugin({ adapters: [], maxAdapterBytes: 0 }),
		).toThrow('maxAdapterBytes');
		expect(() =>
			createStoragePlugin({ adapters: [], maxTotalBytes: 0 }),
		).toThrow('maxTotalBytes');
	});

	it('rejects ambiguous adapter registrations', () => {
		expect(() =>
			createStoragePlugin({
				adapters: [
					{ id: 'duplicate', title: 'First', getAllKeys: () => [] },
					{ id: 'duplicate', title: 'Second', getAllKeys: () => [] },
				],
			}),
		).toThrow('Duplicate storage adapter id');
	});

	it('validates storage rules and does not invoke configuration accessors', () => {
		const adapter = { id: 'standard', title: 'Standard', getAllKeys: () => [] };
		expect(() =>
			createStoragePlugin({
				adapters: [adapter],
				rules: [{ adapterId: 'missing', key: 'key' }],
			}),
		).toThrow('known adapter');
		expect(() =>
			createStoragePlugin({
				adapters: [adapter],
				rules: [
					{ adapterId: 'standard', key: 'key' },
					{ adapterId: 'standard', key: 'key' },
				],
			}),
		).toThrow('Duplicate storage validation rule');

		const getter = jest.fn(() => 'standard');
		const unsafeRule = { key: 'key' } as Record<string, unknown>;
		Object.defineProperty(unsafeRule, 'adapterId', {
			enumerable: true,
			get: getter,
		});
		expect(() =>
			createStoragePlugin({
				adapters: [adapter],
				rules: [unsafeRule] as unknown as Parameters<
					typeof createStoragePlugin
				>[0]['rules'],
			}),
		).toThrow('cannot be an accessor');
		expect(getter).not.toHaveBeenCalled();
	});

	it('restarts an in-flight refresh when the collector lifecycle changes', async () => {
		let resolveFirst: (() => void) | undefined;
		const getAllKeys = jest
			.fn<Promise<readonly string[]>, []>()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = () => resolve(['first']);
					}),
			)
			.mockResolvedValue(['second']);
		const storage = createStoragePlugin({
			adapters: [{ id: 'standard', title: 'Standard', getAllKeys }],
		});
		const initialRefresh = storage.refresh();
		const dispose = storage.plugin.install?.();
		resolveFirst?.();
		await initialRefresh;
		await Promise.resolve();

		expect(getAllKeys).toHaveBeenCalledTimes(2);
		expect(storage.getSnapshot().loading).toBe(false);
		expect(storage.getSnapshot().adapters[0]?.entries[0]?.key).toBe('second');
		dispose?.();
	});

	it('cancels a queued subscription refresh when disposed', async () => {
		let listener: (() => void) | undefined;
		const getAllKeys = jest.fn(() => ['key']);
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys,
					subscribe: (nextListener) => {
						listener = nextListener;
						return jest.fn();
					},
				},
			],
		});
		const dispose = storage.plugin.install?.();
		await storage.refresh();
		getAllKeys.mockClear();

		listener?.();
		dispose?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(getAllKeys).not.toHaveBeenCalled();
	});

	it('ignores retained adapter callbacks after reinstallation', async () => {
		const listeners: Array<() => void> = [];
		const getAllKeys = jest.fn(() => ['key']);
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys,
					subscribe: (listener) => {
						listeners.push(listener);
						return () => {};
					},
				},
			],
		});
		const firstDispose = storage.plugin.install?.();
		await storage.refresh();
		const staleListener = listeners[0];
		firstDispose?.();
		const secondDispose = storage.plugin.install?.();
		await storage.refresh();
		getAllKeys.mockClear();

		staleListener?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(getAllKeys).not.toHaveBeenCalled();
		secondDispose?.();
	});

	it('keeps another install active when a disposer is called twice', () => {
		const unsubscribe = jest.fn();
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys: () => [],
					subscribe: () => unsubscribe,
				},
			],
		});
		const firstDispose = storage.plugin.install?.();
		const secondDispose = storage.plugin.install?.();

		firstDispose?.();
		firstDispose?.();
		expect(unsubscribe).not.toHaveBeenCalled();
		secondDispose?.();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('clears loading state when disposed during an in-flight refresh', async () => {
		let resolveKeys: ((keys: readonly string[]) => void) | undefined;
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'standard',
					title: 'Standard',
					getAllKeys: () =>
						new Promise<readonly string[]>((resolve) => {
							resolveKeys = resolve;
						}),
				},
			],
		});

		const dispose = storage.plugin.install?.();
		expect(storage.getSnapshot().loading).toBe(true);
		dispose?.();
		expect(storage.getSnapshot().loading).toBe(false);

		resolveKeys?.(['late']);
		await Promise.resolve();
		await Promise.resolve();
		expect(storage.getSnapshot().loading).toBe(false);
		expect(storage.getSnapshot().adapters).toEqual([]);
	});
});

describe('storage snapshot key accounting', () => {
	it('does not count adapter-reported duplicate keys as omitted', async () => {
		const storage = createStoragePlugin({
			adapters: [
				{
					id: 'app',
					title: 'App Storage',
					description: 'Preferences',
					// A duplicate is de-duplicated before capture, so nothing was
					// dropped. Counting it as omitted would flip `truncated`, which makes
					// validateStorageSnapshot report every rule as `notCaptured`.
					getAllKeys: () => ['a', 'a', 'b'],
					getValue: (key: string) => `value-${key}`,
				},
			],
		});
		await storage.refresh();
		const adapter = storage.getSnapshot().adapters[0];
		expect(adapter?.entries.map((entry) => entry.key)).toEqual(['a', 'b']);
		expect(adapter?.totalKeyCount).toBe(2);
		expect(adapter?.omittedKeyCount).toBe(0);
		expect(adapter?.truncated).toBe(false);
	});
});
