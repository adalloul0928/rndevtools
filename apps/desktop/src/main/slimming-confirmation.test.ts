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
	it('no longer asks before apply, undo, or restore: ownership and the tuple acknowledgement gate those', () => {
		for (const target of [
			{
				actionId: 'apply',
				kind: 'profile.apply',
				profileId: 'rndevtools-development',
				simulatorUdids: UDIDS,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			},
			{
				actionId: 'undo',
				kind: 'profile.undo',
				simulatorUdids: [UDIDS[0]],
				confirmation: SLIMMING_CONFIRMATIONS.undo,
			},
			{
				actionId: 'restore',
				kind: 'profile.restore',
				simulatorUdids: [UDIDS[0]],
				confirmation: SLIMMING_CONFIRMATIONS.restore,
			},
		]) {
			expect(
				slimmingConfirmationCopy(
					slimmingConfirmationTargetSchema.parse(target),
					'App Development'
				)
			).toBeUndefined();
		}
	});

	it('still asks before restoring everything and disabling slimming, with the complete target list', () => {
		const disable = slimmingConfirmationTargetSchema.parse({
			actionId: 'disable',
			enabled: false,
			disposition: 'restore-and-verify',
			simulatorUdids: UDIDS,
			confirmation: SLIMMING_CONFIRMATIONS.restore,
		});
		const copy = slimmingConfirmationCopy(disable);
		expect(copy?.title).toBe('Restore managed services and disable slimming?');
		expect(copy?.detail).toContain('then disable experimental slimming');
		expect(copy?.detail).toContain('Targets (20):');
		expect(copy?.detail.match(/[A-Fa-f0-9-]{36}/g)).toHaveLength(20);
	});

	it('binds a one-time approval to the exact profile and complete UDID list', () => {
		const confirmations = new ActionConfirmationStore({
			now: () => 1,
			ttlMs: 100,
		});
		const target = slimmingConfirmationTargetSchema.parse({
			actionId: 'apply',
			kind: 'profile.apply',
			profileId: 'rndevtools-development',
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
			profileId: 'rndevtools-development',
			simulatorUdids: [UDIDS[0]],
		});
		expect(slimmingConfirmationCopy(preview)).toBeUndefined();
	});
});
