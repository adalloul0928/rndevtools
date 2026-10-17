import { describe, expect, it } from 'vitest';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
	SUPABASE_DEMO_NOW,
} from '../../../shared/supabase-demo-data';
import type {
	SupabaseAvailability,
	SupabaseStackSummary,
	SupabaseState,
} from '../../../shared/supabase-protocol';
import {
	supabaseActionReasons,
	supabaseNoticeControls,
	supabaseStudioControls,
} from './supabase-stack-detail';

const ids = SUPABASE_DEMO_IDS;
const context = { bridgeAvailable: true, now: SUPABASE_DEMO_NOW };
const allowed: SupabaseAvailability = { allowed: true };

function refused(reason: string): SupabaseAvailability {
	return { allowed: false, reason, check: 'state' };
}

function stackIn(state: SupabaseState, id: string): SupabaseStackSummary {
	const stack = state.stacks.find((candidate) => candidate.id === id);
	if (!stack) throw new Error(`No demo stack ${id}`);
	return stack;
}

describe('supabaseNoticeControls', () => {
	it('drops notice buttons the action row already shows', () => {
		const control = (id: string) => ({
			id,
			label: id,
			availability: allowed,
			confirmation: { kind: 'none' } as const,
		});
		expect(
			supabaseNoticeControls(
				{ controls: [control('try-again'), control('destroy')] },
				new Set(['try-again', 'open-logs'])
			).map((item) => item.id)
		).toEqual(['destroy']);
	});
});

describe('supabaseActionReasons', () => {
	it('lists each refusal once, with every control it explains', () => {
		expect(
			supabaseActionReasons([
				{ id: 'stop', availability: refused('Another operation is running.') },
				{ id: 'restart', availability: allowed },
				{ id: 'pin', availability: refused('Another operation is running.') },
				{ id: 'resume', availability: refused('The worktree moved.') },
			])
		).toEqual([
			{
				reason: 'Another operation is running.',
				controlIds: ['stop', 'pin'],
			},
			{ reason: 'The worktree moved.', controlIds: ['resume'] },
		]);
		expect(
			supabaseActionReasons([{ id: 'stop', availability: allowed }])
		).toEqual([]);
	});
});

describe('supabaseStudioControls', () => {
	it('offers Enable Studio… while it is excluded, through the native dialog', () => {
		const state = createSupabaseDemoState();
		const controls = supabaseStudioControls(
			stackIn(state, ids.featCheckout),
			state,
			context
		);
		expect(controls.map((control) => control.label)).toEqual([
			'Enable Studio…',
		]);
		expect(controls[0]).toMatchObject({
			operation: {
				kind: 'set-studio',
				stackId: ids.featCheckout,
				enabled: true,
			},
			confirmation: { kind: 'native' },
			availability: { allowed: true },
		});
	});

	it('offers Open and Disable once Studio runs, Disable confirming with live agents', () => {
		const base = createSupabaseDemoState();
		const state: SupabaseState = {
			...base,
			stacks: base.stacks.map((stack) =>
				stack.id === ids.featCheckout
					? {
							...stack,
							studio: { included: true, operatorEnabled: true },
							excluded: ['analytics'],
							studioUrl: 'http://127.0.0.1:21737',
							ports: { ...stack.ports, studio: 21_737 },
						}
					: stack
			),
		};
		const controls = supabaseStudioControls(
			stackIn(state, ids.featCheckout),
			state,
			context
		);
		expect(controls.map((control) => control.label)).toEqual([
			'Open Studio',
			'Disable Studio',
		]);
		expect(controls[1]?.confirmation).toEqual({
			kind: 'inline',
			agents: ['Claude 7f3a2c91'],
		});
	});

	it('shows the reason when the stack belongs to someone else', () => {
		const state = createSupabaseDemoState();
		const [enable] = supabaseStudioControls(
			stackIn(state, ids.legacyMain),
			state,
			context
		);
		expect(enable?.availability).toMatchObject({
			allowed: false,
			reason: "RN Devtools didn't start this stack. Adopt it first.",
		});
	});
});
