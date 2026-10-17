import {
	AppWindow,
	Bot,
	Camera,
	DatabaseZap,
	Gauge,
	Layers3,
	Settings2,
	Smartphone,
	Waypoints,
} from 'lucide-react';
import type { ComponentType } from 'react';

export type SimulatorToolId =
	| 'fleet'
	| 'actions'
	| 'slimming'
	| 'captures'
	| 'automation'
	| 'builds'
	| 'lanes'
	| 'supabase'
	| 'settings';

/**
 * The sidebar section a tool is listed under.
 * @public
 */
export type SimulatorToolGroup = 'simulator' | 'backend' | 'system';

export type SimulatorToolDefinition = {
	id: SimulatorToolId;
	label: string;
	description: string;
	icon: ComponentType<{ className?: string }>;
	shortcut: number;
	group: SimulatorToolGroup;
};

/**
 * The sidebar sections in order. Tools are listed in the order below and
 * their shortcuts count up across the sections, so the digits read 1–9 from
 * top to bottom.
 */
export const SIMULATOR_TOOL_GROUPS: readonly {
	id: SimulatorToolGroup;
	label: string;
}[] = [
	{ id: 'simulator', label: 'Simulator' },
	{ id: 'backend', label: 'Backend' },
	{ id: 'system', label: 'System' },
];

export const simulatorTools: SimulatorToolDefinition[] = [
	{
		id: 'fleet',
		label: 'Simulators',
		description:
			'Boot, inspect, and manage local Simulator and device targets.',
		icon: Smartphone,
		shortcut: 1,
		group: 'simulator',
	},
	{
		id: 'actions',
		label: 'App Actions',
		description:
			'Drive deep links, permissions, locations, appearance, and semantic input.',
		icon: AppWindow,
		shortcut: 2,
		group: 'simulator',
	},
	{
		id: 'slimming',
		label: 'SimSlim',
		description:
			'Preview, apply, verify, and roll back experimental Simulator service profiles.',
		icon: Layers3,
		shortcut: 3,
		group: 'simulator',
	},
	{
		id: 'captures',
		label: 'Captures',
		description:
			'Create, annotate, frame, compare, and export screenshots and recordings.',
		icon: Camera,
		shortcut: 4,
		group: 'simulator',
	},
	{
		id: 'automation',
		label: 'Automation',
		description:
			'Run repeatable simulator scenarios and agent-friendly workflows.',
		icon: Bot,
		shortcut: 5,
		group: 'simulator',
	},
	{
		id: 'builds',
		label: 'Build Insights',
		description:
			'Review build timing, warnings, cache health, and artifact trends.',
		icon: Gauge,
		shortcut: 6,
		group: 'simulator',
	},
	{
		id: 'lanes',
		label: 'Lanes',
		description:
			'Run one worktree per Simulator with its own leased Metro port, for parallel branches and agents.',
		icon: Waypoints,
		shortcut: 7,
		group: 'simulator',
	},
	{
		id: 'supabase',
		label: 'Supabase',
		description:
			'Track, start, stop and clean up one local Supabase stack per worktree and branch.',
		icon: DatabaseZap,
		shortcut: 8,
		group: 'backend',
	},
	{
		id: 'settings',
		label: 'Settings',
		description:
			'Finish capability onboarding and configure local integrations.',
		icon: Settings2,
		shortcut: 9,
		group: 'system',
	},
];

export function isSimulatorToolId(value: string): value is SimulatorToolId {
	return simulatorTools.some((tool) => tool.id === value);
}

/** The sidebar sections with their tools; sections without tools are left out. */
export function simulatorToolSections(
	tools: readonly SimulatorToolDefinition[] = simulatorTools
): {
	id: SimulatorToolGroup;
	label: string;
	tools: SimulatorToolDefinition[];
}[] {
	return SIMULATOR_TOOL_GROUPS.flatMap((group) => {
		const members = tools.filter((tool) => tool.group === group.id);
		return members.length === 0 ? [] : [{ ...group, tools: members }];
	});
}
