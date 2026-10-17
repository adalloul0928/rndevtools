import { describe, expect, it } from 'vitest';
import {
	clampFleetTile,
	FLEET_TILE_RANGE,
	parseSimulatorCreateCount,
	simulatorEraseAvailability,
	simulatorOpenPresentation,
} from './fleet-panel';

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
			simulatorEraseAvailability(
				{ isAvailable: true, state: 'shutdown' },
				false
			)
		).toMatchObject({ allowed: false });
		expect(
			simulatorEraseAvailability(
				{ isAvailable: false, state: 'shutdown' },
				true
			)
		).toMatchObject({
			allowed: false,
			reason: expect.stringContaining('unavailable'),
		});
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

describe('Simulator Fleet wall tiles', () => {
	it('clamps and steps the wall tile size, falling back to the default', () => {
		expect(clampFleetTile(Number.NaN)).toBe(FLEET_TILE_RANGE.default);
		expect(clampFleetTile(0)).toBe(FLEET_TILE_RANGE.min);
		expect(clampFleetTile(10_000)).toBe(FLEET_TILE_RANGE.max);
		expect(clampFleetTile(207)).toBe(200);
		expect(clampFleetTile(211)).toBe(220);
	});
});
