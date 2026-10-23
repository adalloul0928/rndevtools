import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
	SlimmingSimulator,
	SlimmingSimulatorStatus,
	SlimmingState,
} from '../../../shared/slimming-protocol';
import { SlimmingPanel } from './slimming-panel';

// What the slimming runtime hook returns while SlimmingPanel renders.
const runtimes = vi.hoisted(() => ({
	slimming: {} as Record<string, unknown>,
}));
vi.mock('@/state/slimming-runtime', () => ({
	useSlimmingRuntime: () => runtimes.slimming,
}));
vi.mock('@/state/simulator-runtime', () => ({
	useSimulatorRuntime: () => ({
		state: { devices: [], metrics: { byDevice: {} } },
	}),
}));

const HEADING = 'Restore points the Simulator list cannot reach';
const DELETED_UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const LISTED_UDID = '11111111-2222-4333-8444-555555555555';
const AVAILABLE_HELPER: SlimmingState['helper'] = {
	status: 'available',
	readOnlyAvailable: true,
};
const UNAVAILABLE_HELPER: SlimmingState['helper'] = {
	status: 'unavailable',
	readOnlyAvailable: false,
	error: 'The native helper is not installed.',
};

const listedSimulator: SlimmingSimulator = {
	udid: LISTED_UDID,
	name: 'ExampleApp test device',
	state: 'booted',
	runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
	isAvailable: true,
};

const deletedSimulatorRecord: SlimmingSimulatorStatus = {
	simulatorUdid: DELETED_UDID,
	condition: 'needs-attention',
	managedDisabledServiceIds: [],
	managedDisabledCount: 0,
	managedServiceCount: 12,
	matchingProfileIds: [],
	checkedAt: 1,
	checkpointAvailable: true,
};

// The panel with one listed Simulator and an interrupted mutation's restore
// point for another that the inventory does not list.
function render(helper: SlimmingState['helper']): string {
	const state: SlimmingState = {
		revision: 1,
		updatedAt: 1,
		setting: { experimentalMutationsEnabled: true },
		helper,
		categories: [],
		profiles: [],
		simulators: [listedSimulator],
		statusBySimulator: { [DELETED_UDID]: deletedSimulatorRecord },
		previewBySimulator: {},
		doctorBySimulator: {},
		jobs: [],
		checkpointBySimulator: {},
		operationsBySimulator: {},
	};
	runtimes.slimming = {
		state,
		isBridgeAvailable: true,
		isLoading: false,
		runtimeError: null,
		refresh: () => undefined,
		setEnabled: () => undefined,
		acknowledgeCompatibility: () => undefined,
		runAction: () => undefined,
		cancelJob: () => undefined,
	};
	return renderToStaticMarkup(createElement(SlimmingPanel));
}

// The list of restore points the Simulator list cannot reach, as markup.
function orphanSection(html: string): string {
	return (
		/<section class="sim-slimming-orphans">.*?<\/section>/s.exec(html)?.[0] ??
		''
	);
}

function textOf(markup: string): string {
	return markup
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

describe('SimSlim restore points the Simulator list cannot reach', () => {
	it.each([
		[
			'the inventory no longer lists the Simulator',
			AVAILABLE_HELPER,
			'The helper inventory no longer lists these Simulators',
		],
		[
			'the helper is unavailable',
			UNAVAILABLE_HELPER,
			'The native helper is unavailable',
		],
	])(
		'limits forgetting to a restore point Undo can no longer use when %s',
		(_case, helper, reason) => {
			const text = textOf(orphanSection(render(helper)));
			expect(text).toContain(HEADING);
			expect(text).toContain(reason);
			expect(text).toContain(
				'Forget a restore point only when Undo can no longer use it'
			);
			// A brief outage must not read as a verdict on the restore point.
			expect(text).not.toContain('can only be forgotten');
		}
	);

	it('is a section of the panel like its neighbours, not a subsection', () => {
		const html = render(AVAILABLE_HELPER);
		expect(html).toContain('<h2>Simulator targets</h2>');
		const section = orphanSection(html);
		expect(section).toContain('<h2>');
		expect(section).not.toMatch(/<h[13-6]/);
	});

	it('titles each UDID with its full value, since the row may truncate it', () => {
		expect(orphanSection(render(AVAILABLE_HELPER))).toContain(
			`<code title="${DELETED_UDID}">${DELETED_UDID}</code>`
		);
	});
});
