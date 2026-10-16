import { describe, expect, it } from 'vitest';
import {
	DEVICE_HOLD_GRACE_MS,
	decideDeviceAccess,
	freeDevices,
	resolveDeviceHolds,
} from './device-hold';

const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'AAAAAAAA-0000-4000-8000-000000000002';
const C = 'AAAAAAAA-0000-4000-8000-000000000003';
const now = 1_700_000_000_000;
const claude = { kind: 'claude', sessionId: 's1' } as const;
const codex = { kind: 'codex', sessionId: 't1' } as const;

function lane(udid: string, agent?: typeof claude | typeof codex) {
	return {
		id: `lane-${udid.slice(-1)}`,
		simulatorUdid: udid.toLowerCase(),
		metro: 'ready' as const,
		startedAt: now - 60_000,
		...(agent ? { agent: { ...agent, lastSeenAt: now } } : {}),
	};
}

describe('resolveDeviceHolds', () => {
	it('derives one hold per device, lane over claim, canonical UDID', () => {
		const holds = resolveDeviceHolds({
			lanes: [lane(A, claude)],
			claims: [
				{ simulatorUdid: A, ...codex },
				{ simulatorUdid: B, ...codex },
			],
			liveSessionKeys: new Set(['claude:s1', 'codex:t1']),
			missingSince: new Map(),
			now,
		});
		expect(holds.get(A)).toEqual({
			simulatorUdid: A,
			via: 'lane',
			laneId: 'lane-1',
			holder: claude,
			holderLive: true,
		});
		expect(holds.get(B)).toMatchObject({
			via: 'claim',
			holder: codex,
			holderLive: true,
		});
		expect(holds.has(C)).toBe(false);
	});

	it('marks a hold abandoned when its session is gone and schedules the release', () => {
		const since = now - 4 * 60_000;
		const holds = resolveDeviceHolds({
			lanes: [lane(A, claude)],
			claims: [],
			liveSessionKeys: new Set(),
			missingSince: new Map([['claude:s1', since]]),
			now,
		});
		expect(holds.get(A)).toMatchObject({
			holderLive: false,
			abandonedSince: since,
			releaseAt: since + DEVICE_HOLD_GRACE_MS,
		});
		// First sighting of a missing holder starts the clock now.
		const fresh = resolveDeviceHolds({
			lanes: [lane(A, claude)],
			claims: [],
			liveSessionKeys: new Set(),
			missingSince: new Map(),
			now,
		});
		expect(fresh.get(A)?.releaseAt).toBe(now + DEVICE_HOLD_GRACE_MS);
	});

	it('treats an operator-started lane as live and owned by nobody', () => {
		const holds = resolveDeviceHolds({
			lanes: [lane(A)],
			claims: [],
			liveSessionKeys: new Set(),
			missingSince: new Map(),
			now,
		});
		expect(holds.get(A)).toEqual({
			simulatorUdid: A,
			via: 'lane',
			laneId: 'lane-1',
			holderLive: true,
		});
	});
});

describe('decideDeviceAccess', () => {
	const held = resolveDeviceHolds({
		lanes: [lane(A, claude), lane(C)],
		claims: [{ simulatorUdid: B, ...codex }],
		liveSessionKeys: new Set(['claude:s1', 'codex:t1']),
		missingSince: new Map(),
		now,
	});

	it('lets the holder, and the operator, through; refuses other agents with the owner named', () => {
		expect(decideDeviceAccess(held.get(A), claude, now)).toEqual({
			allowed: true,
		});
		expect(decideDeviceAccess(held.get(A), undefined, now)).toEqual({
			allowed: true,
		});
		expect(decideDeviceAccess(undefined, codex, now)).toEqual({
			allowed: true,
		});
		const refused = decideDeviceAccess(held.get(A), codex, now);
		expect(refused.allowed).toBe(false);
		if (!refused.allowed) {
			expect(refused.reason).toContain('claude session s1');
			expect(refused.reason).toContain('lane lane-1');
		}
		const claimRefused = decideDeviceAccess(held.get(B), claude, now);
		expect(claimRefused.allowed).toBe(false);
		if (!claimRefused.allowed) expect(claimRefused.reason).toContain('a claim');
	});

	it('refuses agents on an operator-started lane', () => {
		const refused = decideDeviceAccess(held.get(C), claude, now);
		expect(refused.allowed).toBe(false);
		if (!refused.allowed) expect(refused.reason).toContain('the operator');
	});

	it('opens an abandoned hold only once the grace period has passed', () => {
		const since = now - 3 * 60_000;
		const abandoned = resolveDeviceHolds({
			lanes: [lane(A, claude)],
			claims: [],
			liveSessionKeys: new Set(),
			missingSince: new Map([['claude:s1', since]]),
			now,
		}).get(A);
		const early = decideDeviceAccess(abandoned, codex, now);
		expect(early.allowed).toBe(false);
		if (!early.allowed) expect(early.reason).toMatch(/releases in 7 min/);
		expect(
			decideDeviceAccess(abandoned, codex, since + DEVICE_HOLD_GRACE_MS)
		).toEqual({ allowed: true });
	});
});

describe('freeDevices', () => {
	it('lists devices with no live hold, including abandoned holds past grace', () => {
		const since = now - DEVICE_HOLD_GRACE_MS - 1;
		const holds = resolveDeviceHolds({
			lanes: [lane(A, claude)],
			claims: [{ simulatorUdid: B, ...codex }],
			liveSessionKeys: new Set(['codex:t1']),
			missingSince: new Map([['claude:s1', since]]),
			now,
		});
		expect(freeDevices([A, B, C], holds, now)).toEqual([A, C]);
	});
});
