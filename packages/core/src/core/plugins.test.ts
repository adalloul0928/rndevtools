import type { DevToolsPlugin } from '../types';
import {
	assertUniquePluginIds,
	groupPlugins,
	hasPillQuickAction,
	isPanelPlugin,
} from './plugins';

const Panel = () => null;

describe('plugin helpers', () => {
	it('groups plugins by section while preserving declaration order', () => {
		const plugins: DevToolsPlugin[] = [
			{
				id: 'network',
				title: 'Network',
				description: 'Requests',
				systemImage: 'network',
				Panel,
			},
			{
				id: 'feedback',
				title: 'Feedback',
				description: 'Report an issue',
				systemImage: 'exclamationmark.bubble',
				section: 'PUMPD',
				kind: 'action',
				onPress: () => {},
			},
			{
				id: 'queries',
				title: 'Queries',
				description: 'Cache',
				systemImage: 'square.stack.3d.up',
				Panel,
			},
		];

		expect(groupPlugins(plugins)).toEqual([
			{ title: 'Diagnostics', plugins: [plugins[0], plugins[2]] },
			{ title: 'PUMPD', plugins: [plugins[1]] },
		]);
	});

	it('distinguishes panels from actions', () => {
		const panel: DevToolsPlugin = {
			id: 'panel',
			title: 'Panel',
			description: 'Panel',
			systemImage: 'square',
			Panel,
		};
		const action: DevToolsPlugin = {
			id: 'action',
			title: 'Action',
			description: 'Action',
			systemImage: 'bolt',
			kind: 'action',
			onPress: () => {},
		};

		expect(isPanelPlugin(panel)).toBe(true);
		expect(isPanelPlugin(action)).toBe(false);
		expect(hasPillQuickAction(panel)).toBe(false);
	});

	it('rejects duplicate quick-action option identifiers within a plugin', () => {
		const panelPlugin: DevToolsPlugin = {
			id: 'state',
			title: 'State',
			description: 'State overrides',
			systemImage: 'list.bullet',
			Panel,
			pillQuickAction: {
				options: [
					{ id: 'loading', label: 'Loading', action: () => {} },
					{ id: 'loading', label: 'Still loading', action: () => {} },
				],
			},
		};

		expect(() => assertUniquePluginIds([panelPlugin])).toThrow(
			'Duplicate pill quick-action option id for plugin state: loading',
		);
	});

	it('rejects quick-action menus without options', () => {
		const panelPlugin: DevToolsPlugin = {
			id: 'empty-menu',
			title: 'Empty menu',
			description: 'No actions',
			systemImage: 'ellipsis.circle',
			Panel,
			pillQuickAction: { options: [] },
		};

		expect(() => assertUniquePluginIds([panelPlugin])).toThrow(
			'Pill quick actions require at least one option for plugin: empty-menu',
		);
	});
});

describe('assertUniquePluginIds', () => {
	it('rejects duplicate plugin identifiers', () => {
		const panelPlugin: DevToolsPlugin = {
			id: 'network',
			title: 'Network',
			description: 'Requests',
			systemImage: 'network',
			Panel,
		};
		const duplicate = { ...panelPlugin, id: 'network' };
		expect(() => assertUniquePluginIds([panelPlugin, duplicate])).toThrow(
			'Duplicate developer-tools plugin id: network',
		);
	});
});
