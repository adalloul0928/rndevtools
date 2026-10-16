import { describe, expect, it } from 'vitest';
import {
	allocateLanePort,
	DEFAULT_LANE_ENVIRONMENTS,
	findLaneConflict,
	type Lane,
	laneAgentFromEnvironment,
	laneDeepLink,
	laneDevClientLaunchUrl,
	laneHealth,
	laneOperationSchema,
	laneSchema,
	laneSlimSummary,
	laneStateSchema,
} from './lane-protocol';

const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const OTHER_UDID = 'FFFFFFFF-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

function lane(overrides: Partial<Lane> = {}): Lane {
	return {
		id: 'lane-11111111-2222-4333-8444-555555555555',
		worktreePath: '/Users/dev/app-feature-a',
		branch: 'feature/a',
		simulatorUdid: UDID,
		environment: 'development',
		port: 8_100,
		metroPid: 4_242,
		metro: 'ready',
		logPath: '/Users/dev/Library/Logs/lane.log',
		bundleIdentifier: 'com.example.app',
		scheme: 'exampleapp',
		startedAt: 1_700_000_000_000,
		...overrides,
	};
}

describe('lane protocol schemas', () => {
	it('accepts a complete lane and rejects product-identity drift', () => {
		expect(laneSchema.parse(lane())).toEqual(lane());
		expect(
			laneSchema.safeParse({ ...lane(), bundleIdentifier: 'not valid!' })
				.success
		).toBe(false);
		expect(
			laneSchema.safeParse({ ...lane(), worktreePath: 'relative/path' }).success
		).toBe(false);
		expect(laneSchema.safeParse({ ...lane(), port: 80 }).success).toBe(false);
	});

	it('ships non-overlapping default environment ranges', () => {
		const ranges = DEFAULT_LANE_ENVIRONMENTS.map((env) => env.portRange);
		for (let index = 1; index < ranges.length; index += 1) {
			expect(ranges[index]?.[0]).toBeGreaterThan(ranges[index - 1]?.[1] ?? 0);
		}
	});

	it('defaults lane.start to development with launch enabled', () => {
		const parsed = laneOperationSchema.parse({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: '/Users/dev/app',
			simulatorUdid: UDID,
		});
		expect(parsed).toMatchObject({ environment: 'development', launch: true });
	});

	it('rejects unknown operation fields and bad environment ids', () => {
		expect(
			laneOperationSchema.safeParse({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app',
				simulatorUdid: UDID,
				shell: 'rm -rf /',
			}).success
		).toBe(false);
		expect(
			laneOperationSchema.safeParse({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app',
				simulatorUdid: UDID,
				environment: 'Production Env',
			}).success
		).toBe(false);
	});

	it('validates a lane state snapshot end to end', () => {
		const state = laneStateSchema.parse({
			revision: 1,
			updatedAt: 1,
			environments: DEFAULT_LANE_ENVIRONMENTS,
			lanes: [lane()],
			worktrees: [
				{
					path: '/Users/dev/app-feature-a',
					branch: 'feature/a',
					repositoryRoot: '/Users/dev/app',
					dirty: false,
					laneId: lane().id,
				},
			],
			repositories: ['/Users/dev/app'],
		});
		expect(state.lanes).toHaveLength(1);
	});
});

describe('laneDevClientLaunchUrl', () => {
	it('builds the SDK 57 legacy launch form with automation parameters', () => {
		const url = laneDevClientLaunchUrl('exampleapp', 8_123);
		expect(url).toBe(
			'exampleapp://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8123&disableOnboarding=1&disableAutoLaunch=1'
		);
	});
});

describe('laneDeepLink', () => {
	it('prefixes bare paths with the lane scheme and passes URLs through', () => {
		expect(laneDeepLink({ scheme: 'exampleapp' }, '/checkout')).toBe(
			'exampleapp://checkout'
		);
		expect(
			laneDeepLink({ scheme: 'exampleapp' }, 'https://example.com/x')
		).toBe('https://example.com/x');
	});

	it('refuses a bare path when the lane has no scheme', () => {
		expect(() => laneDeepLink({}, 'checkout')).toThrow(/no URL scheme/);
	});
});

describe('laneSlimSummary', () => {
	it('describes every slim status for rows and CLI output', () => {
		expect(laneSlimSummary(undefined)).toBeUndefined();
		const at = { profileId: 'rndevtools-development', updatedAt: 1 };
		expect(laneSlimSummary({ ...at, status: 'applied' })).toEqual({
			label: 'slim: rndevtools-development',
			tone: 'success',
		});
		expect(laneSlimSummary({ ...at, status: 'applying' })).toEqual({
			label: 'slimming: rndevtools-development',
			tone: 'warning',
		});
		expect(laneSlimSummary({ ...at, status: 'failed' })?.tone).toBe('danger');
		expect(laneSlimSummary({ ...at, status: 'skipped' })?.tone).toBe('muted');
	});

	it('accepts lane.start with a slim profile and has no separate approval operation', () => {
		expect(
			laneOperationSchema.parse({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app',
				simulatorUdid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
				slimProfileId: 'rndevtools-development',
			})
		).toMatchObject({ slimProfileId: 'rndevtools-development', launch: true });
		expect(() =>
			laneOperationSchema.parse({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app',
				simulatorUdid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
				slimProfileId: '../escape',
			})
		).toThrow();
		// A start may leave the Simulator to the desktop.
		expect(
			laneOperationSchema.parse({
				actionId: 'op-3',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app',
			})
		).not.toHaveProperty('simulatorUdid');
		// Settling a parked start names the request and, for use/clone, a device.
		expect(
			laneOperationSchema.parse({
				actionId: 'op-4',
				kind: 'lane.provide-device',
				requestId: 'device-request-1',
				decision: 'clone',
				simulatorUdid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
			})
		).toMatchObject({ decision: 'clone' });
		// Slimming is applied by the desktop during lane start, gated on the
		// SimSlim setting, compatibility, and who holds the device; there is no
		// approve/dismiss operation to carry over the wire.
		expect(() =>
			laneOperationSchema.parse({
				actionId: 'op-2',
				kind: 'lane.slim',
				laneId: 'lane-11111111-2222-4333-8444-555555555555',
				decision: 'approve',
			})
		).toThrow();
	});
});

describe('laneHealth', () => {
	it('maps metro status to a label and tone', () => {
		expect(laneHealth({ metro: 'ready' })).toEqual({
			label: 'ready',
			tone: 'success',
		});
		expect(laneHealth({ metro: 'starting' }).tone).toBe('warning');
		expect(laneHealth({ metro: 'stopped' }).tone).toBe('danger');
	});
});

describe('allocateLanePort', () => {
	const environment =
		DEFAULT_LANE_ENVIRONMENTS[0] as (typeof DEFAULT_LANE_ENVIRONMENTS)[number];

	it('skips ports leased by live lanes and ports that fail the bind probe', async () => {
		const busy = new Set([8_101]);
		const port = await allocateLanePort({
			environment,
			lanes: [lane({ port: 8_100, metro: 'ready' })],
			isPortFree: async (candidate) => !busy.has(candidate),
		});
		expect(port).toBe(8_102);
	});

	it('reuses a port whose lane Metro has stopped', async () => {
		const port = await allocateLanePort({
			environment,
			lanes: [lane({ port: 8_100, metro: 'stopped' })],
			isPortFree: async () => true,
		});
		expect(port).toBe(8_100);
	});

	it('honours a free preferred port inside the range and rejects others', async () => {
		await expect(
			allocateLanePort({
				environment,
				lanes: [],
				isPortFree: async () => true,
				preferredPort: 8_150,
			})
		).resolves.toBe(8_150);
		await expect(
			allocateLanePort({
				environment,
				lanes: [],
				isPortFree: async () => true,
				preferredPort: 9_000,
			})
		).rejects.toThrow(/outside/);
		await expect(
			allocateLanePort({
				environment,
				lanes: [lane({ port: 8_150 })],
				isPortFree: async () => true,
				preferredPort: 8_150,
			})
		).rejects.toThrow(/already in use/);
	});

	it('fails when the range is exhausted', async () => {
		await expect(
			allocateLanePort({
				environment: { id: 'tiny', portRange: [8_100, 8_101] },
				lanes: [],
				isPortFree: async () => false,
			})
		).rejects.toThrow(/No free Metro port/);
	});
});

describe('findLaneConflict', () => {
	it('refuses to steal a worktree or a simulator from a live lane', () => {
		const existing = [lane()];
		expect(
			findLaneConflict(existing, {
				worktreePath: '/Users/dev/app-feature-a',
				simulatorUdid: OTHER_UDID,
			})
		).toMatch(/already has lane/);
		expect(
			findLaneConflict(existing, {
				worktreePath: '/Users/dev/app-feature-b',
				simulatorUdid: UDID.toLowerCase(),
			})
		).toMatch(/already assigned/);
		expect(
			findLaneConflict(existing, {
				worktreePath: '/Users/dev/app-feature-b',
				simulatorUdid: OTHER_UDID,
			})
		).toBeUndefined();
	});
});

describe('laneAgentFromEnvironment', () => {
	it('prefers Claude, then Codex, then the generic variable', () => {
		expect(
			laneAgentFromEnvironment({
				CLAUDE_CODE_SESSION_ID: 'claude-1',
				CODEX_THREAD_ID: 'codex-1',
			})
		).toEqual({ kind: 'claude', sessionId: 'claude-1' });
		expect(laneAgentFromEnvironment({ CODEX_THREAD_ID: 'codex-1' })).toEqual({
			kind: 'codex',
			sessionId: 'codex-1',
		});
		expect(
			laneAgentFromEnvironment({ RNDEVTOOLS_AGENT_SESSION_ID: 'kiro:abc' })
		).toEqual({ kind: 'other', sessionId: 'kiro:abc' });
	});

	it('ignores malformed or missing identifiers', () => {
		expect(laneAgentFromEnvironment({})).toBeUndefined();
		expect(
			laneAgentFromEnvironment({ CLAUDE_CODE_SESSION_ID: 'has spaces' })
		).toBeUndefined();
	});
});
