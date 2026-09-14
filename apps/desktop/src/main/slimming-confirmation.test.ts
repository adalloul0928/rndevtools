import { describe, expect, it } from 'vitest';
import {
	SLIMMING_CONFIRMATIONS,
	slimmingConfirmationTargetSchema,
} from '../shared/slimming-protocol';
import { ActionConfirmationStore } from './action-confirmation-store';
import { slimmingConfirmationCopy } from './slimming-confirmation';

const UDIDS = Array.from(
	{ length: 20 },
	(_, index) =>
		`11111111-2222-3333-4444-${index.toString(16).padStart(12, '0')}`
);

describe('slimming confirmation copy', () => {
	it('shows the exact operation, profile, and complete bounded target list', () => {
		const target = slimmingConfirmationTargetSchema.parse({
			actionId: 'apply',
			kind: 'profile.apply',
			profileId: 'pumpd-development',
			simulatorUdids: UDIDS,
			confirmation: SLIMMING_CONFIRMATIONS.apply,
		});
		const copy = slimmingConfirmationCopy(target, 'PUMPD Development');
		expect(copy?.detail).toContain('Operation: Apply experimental profile');
		expect(copy?.detail).toContain(
			'Profile: PUMPD Development (pumpd-development)'
		);
		expect(copy?.detail).toContain('Targets (20):');
		for (const udid of UDIDS) expect(copy?.detail).toContain(udid);
		expect(copy?.detail.match(/[A-Fa-f0-9-]{36}/g)).toHaveLength(20);
	});

	it('distinguishes restore-and-disable from a direct profile restore', () => {
		const restore = slimmingConfirmationTargetSchema.parse({
			actionId: 'restore',
			kind: 'profile.restore',
			simulatorUdids: [UDIDS[0]],
			confirmation: SLIMMING_CONFIRMATIONS.restore,
		});
		const disable = slimmingConfirmationTargetSchema.parse({
			actionId: 'disable',
			enabled: false,
			disposition: 'restore-and-verify',
			simulatorUdids: [UDIDS[0]],
			confirmation: SLIMMING_CONFIRMATIONS.restore,
		});
		expect(slimmingConfirmationCopy(restore)?.detail).toContain(
			'Operation: Restore all PUMPD-managed services'
		);
		expect(slimmingConfirmationCopy(disable)?.detail).toContain(
			'then disable experimental slimming'
		);
	});

	it('binds a one-time approval to the exact profile and complete UDID list', () => {
		const confirmations = new ActionConfirmationStore({
			now: () => 1,
			ttlMs: 100,
		});
		const target = slimmingConfirmationTargetSchema.parse({
			actionId: 'apply',
			kind: 'profile.apply',
			profileId: 'pumpd-development',
			simulatorUdids: [UDIDS[0], UDIDS[1]],
			confirmation: SLIMMING_CONFIRMATIONS.apply,
		});
		const changedProfile = confirmations.issue('slimming', 7, target);
		expect(
			confirmations.consume(
				'slimming',
				7,
				{ ...target, profileId: 'maximum-density' },
				changedProfile.token
			)
		).toBe(false);

		const changedTargets = confirmations.issue('slimming', 7, target);
		expect(
			confirmations.consume(
				'slimming',
				7,
				{ ...target, simulatorUdids: [UDIDS[0], UDIDS[2]] },
				changedTargets.token
			)
		).toBe(false);

		const exact = confirmations.issue('slimming', 7, target);
		expect(confirmations.consume('slimming', 7, target, exact.token)).toBe(
			true
		);
		expect(confirmations.consume('slimming', 7, target, exact.token)).toBe(
			false
		);
	});

	it('does not create confirmation copy for read-only actions', () => {
		const preview = slimmingConfirmationTargetSchema.parse({
			actionId: 'preview',
			kind: 'profile.preview',
			profileId: 'pumpd-development',
			simulatorUdids: [UDIDS[0]],
		});
		expect(slimmingConfirmationCopy(preview)).toBeUndefined();
	});
});
