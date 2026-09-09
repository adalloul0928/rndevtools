import {
	AppWindow,
	Bot,
	Camera,
	Gauge,
	Layers3,
	Settings2,
	Smartphone,
} from 'lucide-react';
import type { ComponentType } from 'react';

export type SimulatorToolId =
	| 'fleet'
	| 'actions'
	| 'slimming'
	| 'captures'
	| 'automation'
	| 'builds'
	| 'settings';

export type SimulatorToolDefinition = {
	id: SimulatorToolId;
	label: string;
	description: string;
	icon: ComponentType<{ className?: string }>;
	shortcut: number;
};

export const simulatorTools: SimulatorToolDefinition[] = [
	{
		id: 'fleet',
		label: 'Simulators',
		description: 'Boot, inspect, and manage local Simulator and device targets.',
		icon: Smartphone,
		shortcut: 1,
	},
	{
		id: 'actions',
		label: 'App Actions',
		description:
			'Drive deep links, permissions, locations, appearance, and semantic input.',
		icon: AppWindow,
		shortcut: 2,
	},
	{
		id: 'slimming',
		label: 'SimSlim',
		description:
			'Preview, apply, verify, and roll back experimental Simulator service profiles.',
		icon: Layers3,
		shortcut: 3,
	},
	{
		id: 'captures',
		label: 'Captures',
		description:
			'Create, annotate, frame, compare, and export screenshots and recordings.',
		icon: Camera,
		shortcut: 4,
	},
	{
		id: 'automation',
		label: 'Automation',
		description: 'Run repeatable simulator scenarios and agent-friendly workflows.',
		icon: Bot,
		shortcut: 5,
	},
	{
		id: 'builds',
		label: 'Build Insights',
		description: 'Review build timing, warnings, cache health, and artifact trends.',
		icon: Gauge,
		shortcut: 6,
	},
	{
		id: 'settings',
		label: 'Settings',
		description: 'Finish capability onboarding and configure local integrations.',
		icon: Settings2,
		shortcut: 7,
	},
];

export function isSimulatorToolId(value: string): value is SimulatorToolId {
	return simulatorTools.some((tool) => tool.id === value);
}
