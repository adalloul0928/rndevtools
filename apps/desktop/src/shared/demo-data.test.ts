import { describe, expect, it } from 'vitest';
import { applyDemoAction, createDemoDevice, tickDemoDevice } from './demo-data';
import type { DesktopAction, ToolId } from './protocol';

function action(
	tool: ToolId,
	command: string,
	payload: Record<string, unknown> = {}
): DesktopAction {
	return {
		actionId: `test-${tool}-${command}`,
		deviceId: 'pumpd-demo-ios',
		tool,
		command,
		payload,
	};
}

describe('demo device actions', () => {
	it('applies safe remote mutations without mutating the previous snapshot', () => {
		const original = createDemoDevice(1_000_000);
		const storageEntry = original.tools.storage.find((entry) => entry.editable);
		expect(storageEntry).toBeDefined();

		const updated = applyDemoAction(
			original,
			action('storage', 'set', {
				id: storageEntry?.id,
				valueText: 'updated-from-desktop',
			}),
			1_001_000
		);

		expect(
			original.tools.storage.find((entry) => entry.id === storageEntry?.id)?.valueText
		).not.toBe('updated-from-desktop');
		expect(
			updated.tools.storage.find((entry) => entry.id === storageEntry?.id)?.valueText
		).toBe('updated-from-desktop');
		expect(updated.tools.storageEvents[0]?.kind).toBe('updated');
	});

	it('rejects writes to protected storage', () => {
		const device = createDemoDevice();
		const protectedEntry = device.tools.storage.find((entry) => entry.sensitive);
		expect(() =>
			applyDemoAction(
				device,
				action('storage', 'set', {
					id: protectedEntry?.id,
					valueText: 'leak',
				})
			)
		).toThrow('cannot be edited');
	});

	it('captures, restores, and removes only explicit restore points', () => {
		const device = createDemoDevice(2_000_000);
		const captured = applyDemoAction(
			device,
			action('restore', 'capture', { label: 'Before scenario' }),
			2_001_000
		);
		const point = captured.tools.restorePoints[0];
		expect(point?.label).toBe('Before scenario');
		expect(point?.sources).toHaveLength(1);

		const restored = applyDemoAction(
			captured,
			action('restore', 'restore', { id: point?.id }),
			2_002_000
		);
		expect(restored.tools.diagnostics[0]?.scope).toBe('restore');

		const removed = applyDemoAction(
			restored,
			action('restore', 'remove', { id: point?.id }),
			2_003_000
		);
		expect(
			removed.tools.restorePoints.some((candidate) => candidate.id === point?.id)
		).toBe(false);
	});

	it('records performance samples only while a review is active', () => {
		const device = createDemoDevice(3_000_000);
		const started = applyDemoAction(device, action('performance', 'start'), 3_001_000);
		const ticked = tickDemoDevice(started, 3_002_000);
		expect(ticked.tools.performance.samples).toHaveLength(1);

		const stopped = applyDemoAction(ticked, action('performance', 'stop'), 3_003_000);
		const afterStop = tickDemoDevice(stopped, 3_004_000);
		expect(afterStop.tools.performance.samples).toHaveLength(1);
		expect(afterStop.tools.performance.summary.sampleCount).toBe(1);
	});

	it('bounds the live demo performance window and reports dropped samples', () => {
		const device = createDemoDevice(3_100_000);
		const sample = device.tools.performance.samples[0];
		expect(sample).toBeDefined();
		if (!sample) throw new Error('Demo performance sample is missing.');
		device.tools.performance.samples = Array.from({ length: 1_500 }, (_, index) => ({
			...sample,
			id: `sample-${index}`,
		}));
		device.tools.performance.droppedSampleCount = 2;

		const ticked = tickDemoDevice(device, 3_101_000);
		expect(ticked.tools.performance.samples).toHaveLength(1_500);
		expect(ticked.tools.performance.droppedSampleCount).toBe(3);
	});

	it('highlights only a visible registered component target', () => {
		const device = createDemoDevice(4_000_000);
		const target = device.tools.components[0];
		expect(target).toBeDefined();
		const highlighted = applyDemoAction(
			device,
			action('components', 'highlight', { id: target?.id }),
			4_001_000
		);
		expect(highlighted.tools.diagnostics[0]).toMatchObject({
			scope: 'components',
			level: 'info',
		});
		expect(() =>
			applyDemoAction(
				device,
				action('components', 'highlight', { id: 'missing-target' })
			)
		).toThrow('not currently visible');
	});
});
