import { describe, expect, it } from 'vitest';
import type { DeviceSession } from '../../../shared/protocol';
import {
	connectedSessionsForSimulator,
	parseSimulatorCreateCount,
	simulatorEraseAvailability,
	simulatorOpenPresentation,
} from './fleet-panel';

const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

function session(
	id: string,
	status: DeviceSession['status'],
	simulatorUdid: string | undefined,
	lastSeenAt: number
): DeviceSession {
	return {
		info: {
			id,
			name: id,
			platform: 'ios',
			capabilities: [],
			...(simulatorUdid ? { simulatorUdid } : {}),
		},
		status,
		connectedAt: 1,
		lastSeenAt,
		sequence: 1,
		tools: {} as DeviceSession['tools'],
	};
}

describe('Simulator Fleet destructive-action policy', () => {
	it('allows erase only for an available, shut-down target on a live bridge', () => {
		expect(
			simulatorEraseAvailability({ isAvailable: true, state: 'shutdown' }, true)
		).toEqual({
			allowed: true,
			reason: 'Permanently removes installed apps, accounts, and local data.',
		});
	});

	it.each(['booted', 'booting', 'shuttingDown'] as const)(
		'disables erase while the target is %s and tells the operator to shut down first',
		(state) => {
			const availability = simulatorEraseAvailability(
				{ isAvailable: true, state },
				true
			);
			expect(availability.allowed).toBe(false);
			expect(availability.reason).toContain('Shut down');
		}
	);

	it('fails closed when the bridge or target is unavailable', () => {
		expect(
			simulatorEraseAvailability({ isAvailable: true, state: 'shutdown' }, false)
		).toMatchObject({ allowed: false });
		expect(
			simulatorEraseAvailability({ isAvailable: false, state: 'shutdown' }, true)
		).toMatchObject({ allowed: false, reason: expect.stringContaining('unavailable') });
	});
});

describe('Simulator Fleet create validation', () => {
	it.each([
		['1', 1],
		[' 12 ', 12],
		['20', 20],
	] as const)('accepts bounded whole count %s', (value, expected) => {
		expect(parseSimulatorCreateCount(value)).toBe(expected);
	});

	it.each(['', '0', '-1', '1.5', 'abc', '21', '200'])(
		'rejects surprising or out-of-range count %j',
		(value) => {
			expect(parseSimulatorCreateCount(value)).toBeNull();
		}
	);
});

describe('Simulator Fleet open behavior', () => {
	it('opens an already booted target and boots a shutdown target', () => {
		expect(
			simulatorOpenPresentation({ isAvailable: true, state: 'booted' }, true)
		).toEqual({ allowed: true, label: 'Open Simulator' });
		expect(
			simulatorOpenPresentation({ isAvailable: true, state: 'shutdown' }, true)
		).toEqual({ allowed: true, label: 'Boot & open' });
	});

	it('disables open while unavailable or transitioning', () => {
		expect(
			simulatorOpenPresentation({ isAvailable: false, state: 'booted' }, true)
		).toMatchObject({ allowed: false });
		expect(
			simulatorOpenPresentation({ isAvailable: true, state: 'booting' }, true)
		).toMatchObject({ allowed: false });
		expect(
			simulatorOpenPresentation({ isAvailable: true, state: 'shutdown' }, false)
		).toMatchObject({ allowed: false });
	});
});

describe('Simulator Fleet connected-session association', () => {
	it('matches UDIDs case-insensitively and orders online sessions first', () => {
		const result = connectedSessionsForSimulator(UDID, [
			session('offline-newer', 'offline', UDID, 30),
			session('unmatched', 'online', '11111111-2222-4333-8444-555555555555', 40),
			session('online-older', 'online', UDID.toLowerCase(), 10),
			session('simulated', 'simulated', UDID, 100),
			session('v1', 'online', undefined, 50),
		]);

		expect(result.map((candidate) => candidate.info.id)).toEqual([
			'online-older',
			'simulated',
			'offline-newer',
		]);
	});
});
