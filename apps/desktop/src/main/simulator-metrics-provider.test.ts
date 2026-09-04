import { describe, expect, it } from 'vitest';
import {
	parseHostMemoryPressure,
	parseProcessSamples,
	parseSimulatorDiskAllocations,
	parseSimulatorServiceProcesses,
} from './simulator-metrics-provider';

const UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

describe('simulator metrics parsing', () => {
	it('projects bounded host pressure without exposing unrelated output', () => {
		expect(
			parseHostMemoryPressure(`
The system has 16000000000 (100 pages with a page size of 16384).
System-wide memory free percentage: 12%
`)
		).toEqual({
			memoryPressure: 'warning',
			totalMemoryBytes: 16_000_000_000,
			freeMemoryBytes: 1_920_000_000,
			usedMemoryBytes: 14_080_000_000,
			freePercent: 12,
		});
	});

	it('reads only active launchctl service PIDs and semantic app identifiers', () => {
		const processes = parseSimulatorServiceProcesses(`
user/501 = {
  environment = {
    API_TOKEN => must-not-project
  }
  services = {
    123 - com.apple.runningboardd
    456 (pe) UIKitApplication:com.example.pumpd[abcd][rb-legacy]
    0 - com.apple.not-running
    789 - bad label with spaces
  }
}
`);
		expect(processes).toEqual([
			{ processId: 123, label: 'com.apple.runningboardd' },
			{
				processId: 456,
				label: 'UIKitApplication:com.example.pumpd[abcd][rb-legacy]',
				bundleIdentifier: 'com.example.pumpd',
			},
		]);
		expect(JSON.stringify(processes)).not.toContain('API_TOKEN');
	});

	it('parses process resource samples and simulator allocation sizes', () => {
		expect(parseProcessSamples(' 123 12.5 2048 /private/process\n').get(123)).toEqual({
			processId: 123,
			cpuPercent: 12.5,
			memoryBytes: 2_097_152,
		});
		expect(
			parseSimulatorDiskAllocations(
				JSON.stringify({
					devices: {
						runtime: [
							{
								udid: UDID,
								dataPath: '/private/device',
								dataPathSize: 100,
								logPathSize: 20,
							},
						],
					},
				})
			)
		).toEqual(new Map([[UDID, 120]]));
	});
});
