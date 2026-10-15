import { describe, expect, it } from 'vitest';
import {
	AGENT_TOUCH_TTL_MS,
	agentOperationSchema,
	agentStateSchema,
	attributeAgents,
} from './agent-protocol';

const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'BBBBBBBB-0000-4000-8000-000000000002';
const now = 1_700_000_000_000;
const claude = {
	kind: 'claude' as const,
	sessionId: 'claude-1',
	title: 'checkout',
	cwd: '/Users/dev/app-checkout',
	pid: 100,
	updatedAt: now - 1_000,
};
const codex = {
	kind: 'codex' as const,
	sessionId: 'codex-1',
	title: 'onboarding',
	cwd: '/Users/dev/app-onboarding/',
	status: 'recent',
	updatedAt: now - 2_000,
};

describe('attributeAgents', () => {
	it('orders claims before touches before lane matches and never repeats a session per device', () => {
		const byDevice = attributeAgents({
			sessions: [claude, codex],
			claims: [
				{
					simulatorUdid: A.toLowerCase(),
					kind: 'codex',
					sessionId: 'codex-1',
					claimedAt: now - 60_000,
					note: 'reviewing',
				},
			],
			touches: [
				{
					simulatorUdid: A,
					kind: 'claude',
					sessionId: 'claude-1',
					lastSeenAt: now - 5_000,
				},
				// Same session as the claim: must not appear twice.
				{
					simulatorUdid: A,
					kind: 'codex',
					sessionId: 'codex-1',
					lastSeenAt: now - 1_000,
				},
			],
			lanes: [{ simulatorUdid: B, appDirectory: '/Users/dev/app-onboarding' }],
			now,
		});
		expect(byDevice[A]?.map((agent) => [agent.sessionId, agent.via])).toEqual([
			['codex-1', 'claim'],
			['claude-1', 'touch'],
		]);
		expect(byDevice[A]?.[0]).toMatchObject({
			note: 'reviewing',
			live: true,
			title: 'onboarding',
		});
		// Lane attribution matches the session cwd (trailing slash tolerated).
		expect(byDevice[B]?.map((agent) => [agent.sessionId, agent.via])).toEqual([
			['codex-1', 'lane'],
		]);
	});

	it('expires touches after the TTL and marks claims from vanished sessions as not live', () => {
		const byDevice = attributeAgents({
			sessions: [],
			claims: [
				{
					simulatorUdid: A,
					kind: 'claude',
					sessionId: 'gone',
					claimedAt: now - 10,
				},
			],
			touches: [
				{
					simulatorUdid: B,
					kind: 'claude',
					sessionId: 'old',
					lastSeenAt: now - AGENT_TOUCH_TTL_MS - 1,
				},
				{
					simulatorUdid: B,
					kind: 'claude',
					sessionId: 'fresh',
					lastSeenAt: now - AGENT_TOUCH_TTL_MS,
				},
			],
			lanes: [],
			now,
		});
		expect(byDevice[A]?.[0]).toMatchObject({
			sessionId: 'gone',
			live: false,
			title: 'claude gone',
		});
		expect(byDevice[B]?.map((agent) => agent.sessionId)).toEqual(['fresh']);
	});

	it('matches a lane to a session working in a subdirectory of the app, not a sibling', () => {
		const byDevice = attributeAgents({
			sessions: [
				{ ...claude, cwd: '/Users/dev/app-checkout/src/features' },
				{ ...codex, cwd: '/Users/dev/app-checkout-2' },
			],
			claims: [],
			touches: [],
			lanes: [{ simulatorUdid: A, appDirectory: '/Users/dev/app-checkout' }],
			now,
		});
		expect(byDevice[A]?.map((agent) => agent.sessionId)).toEqual(['claude-1']);
	});
});

describe('agent schemas', () => {
	it('validates operations and a state snapshot', () => {
		expect(
			agentOperationSchema.parse({
				kind: 'agent.claim',
				simulatorUdid: A,
				agent: { kind: 'claude', sessionId: 'claude-1' },
				note: 'mine',
			}).kind
		).toBe('agent.claim');
		expect(() =>
			agentOperationSchema.parse({
				kind: 'agent.claim',
				simulatorUdid: 'booted',
				agent: { kind: 'claude', sessionId: 'claude-1' },
			})
		).toThrow();
		expect(
			agentStateSchema.parse({
				revision: 1,
				updatedAt: now,
				sessions: [claude],
				byDevice: {
					[A]: [{ ...claude, via: 'touch', lastSeenAt: now, live: true }],
				},
				claims: [],
				discovery: { claude: 'ok', codex: 'unavailable' },
			}).sessions
		).toHaveLength(1);
	});
});
