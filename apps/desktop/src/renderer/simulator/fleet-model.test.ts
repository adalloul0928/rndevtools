import { describe, expect, it } from 'vitest';
import type { Lane } from '../../shared/lane-protocol';
import type { DeviceSession } from '../../shared/protocol';
import type {
	SimulatorDevice,
	SimulatorDeviceMetrics,
} from '../../shared/simulator-protocol';
import type { SlimmingSimulatorStatus } from '../../shared/slimming-protocol';
import {
	agentLabel,
	buildFleetRows,
	fleetFilterCounts,
	fleetRowMatches,
	fleetSlimSummary,
	shortPath,
} from './fleet-model';

const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'BBBBBBBB-0000-4000-8000-000000000002';
const C = 'CCCCCCCC-0000-4000-8000-000000000003';
const D = 'DDDDDDDD-0000-4000-8000-000000000004';

function device(
	udid: string,
	name: string,
	state: SimulatorDevice['state']
): SimulatorDevice {
	return { udid, name, state, runtimeIdentifier: RUNTIME, isAvailable: true };
}

function lane(udid: string, overrides: Partial<Lane> = {}): Lane {
	return {
		id: `lane-${udid.slice(0, 8).toLowerCase()}-0000-4000-8000-000000000000`,
		worktreePath: '/Users/dev/code/app-feature',
		branch: 'feature/x',
		simulatorUdid: udid,
		environment: 'development',
		port: 8_100,
		metro: 'ready',
		logPath: '/Users/dev/lane.log',
		startedAt: 1,
		...overrides,
	};
}

function metrics(memoryBytes: number): SimulatorDeviceMetrics {
	return {
		deviceUdid: A,
		sampledAt: 1,
		cpuPercent: 1,
		memoryBytes,
		processCount: 70,
		processes: [],
	} as unknown as SimulatorDeviceMetrics;
}

function session(
	udid: string | undefined,
	status: DeviceSession['status']
): DeviceSession {
	return {
		info: {
			id: `session-${udid ?? 'none'}`,
			name: 'Demo',
			platform: 'ios',
			capabilities: [],
			...(udid ? { simulatorUdid: udid } : {}),
		},
		status,
		connectedAt: 1,
		lastSeenAt: 2,
		sequence: 1,
		tools: {} as DeviceSession['tools'],
	};
}

function slimStatus(
	condition: SlimmingSimulatorStatus['condition'],
	disabled: number
): SlimmingSimulatorStatus {
	return {
		simulatorUdid: A,
		condition,
		managedDisabledServiceIds: [],
		managedDisabledCount: disabled,
		managedServiceCount: 170,
		matchingProfileIds: [],
		checkedAt: 1,
		checkpointAvailable: false,
	} as unknown as SlimmingSimulatorStatus;
}

describe('buildFleetRows', () => {
	it('joins inventory, metrics, slim status, lanes, and sessions into one row per device', () => {
		const rows = buildFleetRows({
			devices: [device(A, 'Agent A', 'booted')],
			runtimes: [{ identifier: RUNTIME, name: 'iOS 26.5', isAvailable: true }],
			metricsByDevice: { [A]: metrics(900_000_000) },
			slimmingByDevice: { [A]: slimStatus('profile-match', 170) },
			lanes: [
				lane(A, { agent: { kind: 'claude', sessionId: 's1', lastSeenAt: 1 } }),
			],
			sessions: [session(A, 'online'), session(B, 'online')],
		});
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row?.runtimeName).toBe('iOS 26.5');
		expect(row?.memoryBytes).toBe(900_000_000);
		expect(row?.slim).toMatchObject({ level: 'slim', label: 'Slim' });
		expect(row?.lane?.port).toBe(8_100);
		expect(row?.laneHealth).toEqual({ label: 'ready', tone: 'success' });
		expect(row?.sessions).toHaveLength(1);
		expect(row?.rank).toBe(0);
	});

	it('ranks busy devices first: agent lane, lane, connected app, idle, transitioning, shut down', () => {
		const rows = buildFleetRows({
			devices: [
				device(A, 'Idle booted', 'booted'),
				device(B, 'Lane with agent', 'booted'),
				device(C, 'Shut down', 'shutdown'),
				device(D, 'Booting', 'booting'),
			],
			runtimes: [],
			metricsByDevice: {},
			slimmingByDevice: {},
			lanes: [
				lane(B, { agent: { kind: 'codex', sessionId: 't1', lastSeenAt: 1 } }),
			],
			sessions: [session(A, 'online')],
		});
		expect(rows.map((row) => row.device.name)).toEqual([
			'Lane with agent',
			'Idle booted',
			'Booting',
			'Shut down',
		]);
	});

	it('hides metrics for shut-down devices and matches UDIDs case-insensitively', () => {
		const rows = buildFleetRows({
			devices: [device(A, 'Sim', 'shutdown')],
			runtimes: [],
			metricsByDevice: { [A]: metrics(1) },
			slimmingByDevice: {},
			lanes: [lane(A.toLowerCase(), { metro: 'stopped' })],
			sessions: [],
		});
		expect(rows[0]?.memoryBytes).toBeUndefined();
		expect(rows[0]?.lane).toBeDefined();
		expect(rows[0]?.laneHealth?.label).toBe('stopped');
		expect(rows[0]?.slim.label).toBe('Stock');
	});
});

describe('fleetSlimSummary', () => {
	it('describes slim, partial, stock, and uninspected devices', () => {
		expect(fleetSlimSummary(slimStatus('profile-match', 170), true).level).toBe(
			'slim'
		);
		expect(fleetSlimSummary(slimStatus('drifted', 12), true)).toMatchObject({
			level: 'partial',
			detail: '12 of 170 managed services disabled',
		});
		expect(fleetSlimSummary(slimStatus('partial', 12), true).level).toBe(
			'partial'
		);
		expect(fleetSlimSummary(slimStatus('managed-clean', 0), true).level).toBe(
			'stock'
		);
		expect(fleetSlimSummary(slimStatus('needs-attention', 3), true).label).toBe(
			'Check required'
		);
		expect(fleetSlimSummary(slimStatus('unknown', 0), true).label).toBe(
			'Not inspected'
		);
		expect(fleetSlimSummary(undefined, true).label).toBe('Not inspected');
		expect(fleetSlimSummary(undefined, false).label).toBe('Stock');
	});
});

describe('fleetRowMatches and counts', () => {
	const rows = buildFleetRows({
		devices: [
			device(A, 'Agent A', 'booted'),
			device(B, 'Plain', 'booted'),
			device(C, 'Off', 'shutdown'),
		],
		runtimes: [{ identifier: RUNTIME, name: 'iOS 26.5', isAvailable: true }],
		metricsByDevice: {},
		slimmingByDevice: {},
		lanes: [
			lane(A, {
				branch: 'feature/checkout',
				agent: { kind: 'claude', sessionId: 'sess-42', lastSeenAt: 1 },
			}),
		],
		sessions: [],
	});

	it('filters by state, lane, and agent', () => {
		expect(fleetFilterCounts(rows)).toEqual({
			all: 3,
			booted: 2,
			shutdown: 1,
			'with-lane': 1,
			'with-agent': 1,
		});
		expect(
			rows
				.filter((row) => fleetRowMatches(row, 'with-lane', ''))
				.map((r) => r.device.name)
		).toEqual(['Agent A']);
		expect(
			rows
				.filter((row) => fleetRowMatches(row, 'shutdown', ''))
				.map((r) => r.device.name)
		).toEqual(['Off']);
	});

	it('searches name, runtime, branch, port, and agent session', () => {
		const names = (query: string) =>
			rows
				.filter((row) => fleetRowMatches(row, 'all', query))
				.map((r) => r.device.name);
		expect(names('checkout')).toEqual(['Agent A']);
		expect(names(':8100')).toEqual(['Agent A']);
		expect(names('claude sess-42')).toEqual(['Agent A']);
		expect(names('26.5')).toHaveLength(3);
		expect(names('nothing-here')).toEqual([]);
	});
});

describe('helpers', () => {
	it('abbreviates home directories and labels agents', () => {
		expect(shortPath('/Users/dev/code/app')).toBe('~/code/app');
		expect(shortPath('/opt/app')).toBe('/opt/app');
		expect(shortPath('/Users/dev')).toBe('~');
		expect(agentLabel('claude')).toBe('Claude');
		expect(agentLabel('codex')).toBe('Codex');
		expect(agentLabel('other')).toBe('Agent');
	});
});
