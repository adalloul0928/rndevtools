import type {
	DevToolsPanelPlugin,
	DevToolsPlugin,
	DevToolsPluginWithPillQuickAction,
} from '../types';

export type DevToolsPluginSection = {
	title: string;
	plugins: readonly DevToolsPlugin[];
};

export function isPanelPlugin(
	plugin: DevToolsPlugin,
): plugin is DevToolsPanelPlugin {
	return plugin.kind !== 'action';
}

export function hasPillQuickAction(
	plugin: DevToolsPlugin,
): plugin is DevToolsPluginWithPillQuickAction {
	return plugin.pillQuickAction !== undefined;
}

export function groupPlugins(
	plugins: readonly DevToolsPlugin[],
): readonly DevToolsPluginSection[] {
	const sections = new Map<string, DevToolsPlugin[]>();

	for (const plugin of plugins) {
		const section = plugin.section ?? 'Diagnostics';
		const entries = sections.get(section) ?? [];
		entries.push(plugin);
		sections.set(section, entries);
	}

	return [...sections].map(([title, entries]) => ({
		title,
		plugins: entries,
	}));
}

export function assertUniquePluginIds(
	plugins: readonly DevToolsPlugin[],
): void {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const plugin of plugins) {
		if (!plugin.id.trim()) {
			throw new Error('Developer-tools plugin ids cannot be empty.');
		}
		if (seen.has(plugin.id)) duplicates.add(plugin.id);
		seen.add(plugin.id);

		if (plugin.pillQuickAction) {
			if (plugin.pillQuickAction.options.length === 0) {
				throw new Error(
					`Pill quick actions require at least one option for plugin: ${plugin.id}`,
				);
			}
			const optionIds = new Set<string>();
			for (const option of plugin.pillQuickAction.options) {
				if (!option.id.trim()) {
					throw new Error(
						`Pill quick-action option ids cannot be empty for plugin: ${plugin.id}`,
					);
				}
				if (optionIds.has(option.id)) {
					throw new Error(
						`Duplicate pill quick-action option id for plugin ${plugin.id}: ${option.id}`,
					);
				}
				optionIds.add(option.id);
			}
		}
	}
	if (duplicates.size > 0) {
		throw new Error(
			`Duplicate developer-tools plugin id${duplicates.size === 1 ? '' : 's'}: ${[
				...duplicates,
			].join(', ')}`,
		);
	}
}
