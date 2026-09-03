import {
	desktopActionCapability,
	parseDesktopActionEnvelope,
	parseDesktopDeviceAction,
} from './desktop-protocol';

describe('desktop action protocol', () => {
	it.each([
		['network', 'clear', {}],
		['console', 'clear', {}],
		['storage', 'set', { id: 'entry', valueText: 'next' }],
		['query', 'refetch', { id: 'query' }],
		['query', 'invalidate', { id: 'query' }],
		['routes', 'navigate', { path: '/settings' }],
		['zustand', 'refresh', {}],
		['restore', 'capture', { label: 'Before repro' }],
		['restore', 'restore', { id: 'point' }],
		['restore', 'remove', { id: 'point' }],
		['performance', 'start', {}],
		['performance', 'stop', {}],
		['components', 'refresh', {}],
		['components', 'highlight', { id: 'target' }],
	] as const)(
		'accepts the allowlisted %s.%s command',
		(tool, command, payload) => {
			expect(
				parseDesktopDeviceAction({
					actionId: 'action-1',
					deviceId: 'device-1',
					tool,
					command,
					payload,
				}),
			).toMatchObject({ tool, command, payload });
		},
	);

	it('normalizes allowlisted actions and permits an empty storage string', () => {
		expect(
			parseDesktopDeviceAction({
				actionId: ' action-1 ',
				deviceId: ' device-1 ',
				tool: 'storage',
				command: 'set',
				payload: { id: ' storage-1 ', valueText: '' },
			}),
		).toEqual({
			actionId: 'action-1',
			deviceId: 'device-1',
			tool: 'storage',
			command: 'set',
			payload: { id: 'storage-1', valueText: '' },
		});
	});

	it('rejects unsupported commands, extra fields, and malformed payloads', () => {
		const base = {
			actionId: 'action-1',
			deviceId: 'device-1',
			tool: 'network',
			payload: {},
		};
		expect(
			parseDesktopDeviceAction({ ...base, command: 'evaluate' }),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({ ...base, command: 'clear', unexpected: true }),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				...base,
				command: 'clear',
				payload: { unexpected: true },
			}),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'routes',
				command: 'navigate',
				payload: { path: `/${'x'.repeat(4 * 1024)}` },
			}),
		).toBeNull();
	});

	it('parses only an exact action envelope and maps capabilities', () => {
		expect(
			parseDesktopActionEnvelope({
				type: 'action',
				action: {
					actionId: 'action-1',
					deviceId: 'device-1',
					tool: 'performance',
					command: 'start',
					payload: {},
				},
			}),
		).toMatchObject({ tool: 'performance', command: 'start' });
		expect(desktopActionCapability('performance', 'stop')).toBe(
			'performance.review',
		);
		expect(desktopActionCapability('components', 'highlight')).toBe(
			'components.highlight',
		);
		expect(desktopActionCapability('diagnostics', 'clear')).toBeUndefined();
	});

	it('rejects hostile protocol objects instead of throwing', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('ownKeys failed');
				},
			},
		);

		expect(() => parseDesktopDeviceAction(hostile)).not.toThrow();
		expect(parseDesktopDeviceAction(hostile)).toBeNull();
		expect(parseDesktopActionEnvelope(hostile)).toBeNull();
	});

	it('rejects accessors without invoking them and applies byte limits', () => {
		const getter = jest.fn(() => 'action-1');
		const action = {
			deviceId: 'device-1',
			tool: 'network',
			command: 'clear',
			payload: {},
		} as Record<string, unknown>;
		Object.defineProperty(action, 'actionId', {
			enumerable: true,
			get: getter,
		});

		expect(parseDesktopDeviceAction(action)).toBeNull();
		expect(getter).not.toHaveBeenCalled();
		expect(
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'restore',
				command: 'capture',
				payload: { label: '🏋️'.repeat(1_500) },
			}),
		).toBeNull();
	});
});
