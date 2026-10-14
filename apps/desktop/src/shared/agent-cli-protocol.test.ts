import { describe, expect, it } from 'vitest';
import {
	agentCliRequestSchema,
	RNDEVTOOLS_AGENT_CLI_PROTOCOL,
} from './agent-cli-protocol';

const UDID = '11111111-2222-3333-4444-555555555555';

function request(command: unknown) {
	return {
		protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
		id: 'cli-0123456789abcdef0123456789abcdef',
		command,
	};
}

describe('agent CLI protocol', () => {
	it('applies bounded defaults to inspection commands', () => {
		expect(
			agentCliRequestSchema.parse(request({ kind: 'simulators' })).command
		).toEqual({ kind: 'simulators', includeUnavailable: false });
		expect(
			agentCliRequestSchema.parse({
				...request({ kind: 'elements', target: { udid: UDID } }),
			}).command
		).toMatchObject({ limit: 100 });
	});

	it('rejects arbitrary shell-shaped commands and unknown fields', () => {
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'shell',
					executable: '/bin/zsh',
					args: ['-c', 'whoami'],
				})
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'doctor', environment: { TOKEN: 'secret' } })
			).success
		).toBe(false);
	});

	it('permits semantic actions but rejects destructive connected-app actions', () => {
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'act',
					target: { deviceId: 'device-1' },
					action: {
						tool: 'components',
						command: 'activate',
						payload: { id: 'button-1', screenHash: 'screen-1' },
					},
				})
			).success
		).toBe(true);
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'act',
					target: { deviceId: 'device-1' },
					action: {
						tool: 'restore',
						command: 'restore',
						payload: { id: 'restore-1' },
					},
				})
			).success
		).toBe(false);
	});

	it('allows app-scoped network profiles but not clearing captured traffic', () => {
		for (const [command, payload] of [
			['setProfile', { profileId: 'lte' }],
			['clearProfile', {}],
		] as const) {
			expect(
				agentCliRequestSchema.safeParse(
					request({
						kind: 'act',
						target: { deviceId: 'device-1' },
						action: { tool: 'network', command, payload },
					})
				).success
			).toBe(true);
		}
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'act',
					target: { deviceId: 'device-1' },
					action: { tool: 'network', command: 'clear', payload: {} },
				})
			).success
		).toBe(false);
	});

	it('keeps Simulator Slimming commands read-only', () => {
		for (const command of [
			{ kind: 'slimming', operation: 'status' },
			{ kind: 'slimming', operation: 'doctor', udids: [UDID] },
			{
				kind: 'slimming',
				operation: 'preview',
				udids: [UDID],
				profileId: 'rndevtools-development',
			},
			{
				kind: 'slimming',
				operation: 'verify',
				udids: [UDID],
				profileId: 'rndevtools-development',
			},
		]) {
			expect(agentCliRequestSchema.safeParse(request(command)).success).toBe(
				true
			);
		}
		for (const command of [
			{ kind: 'slimming', operation: 'status', udids: [UDID] },
			{
				kind: 'slimming',
				operation: 'doctor',
				udids: [UDID],
				profileId: 'ignored-profile',
			},
			{ kind: 'slimming', operation: 'preview', udids: [UDID] },
		]) {
			expect(agentCliRequestSchema.safeParse(request(command)).success).toBe(
				false
			);
		}
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'slimming',
					operation: 'apply',
					udids: [UDID],
					confirmation: 'APPLY_EXPERIMENTAL_PROFILE',
				})
			).success
		).toBe(false);
	});

	it('requires exact UDID syntax and bounded target batches', () => {
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'capture', udid: 'booted; rm -rf /' })
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'recipe',
					operation: 'run',
					recipeId: 'smoke',
					udids: Array.from({ length: 21 }, () => UDID),
				})
			).success
		).toBe(false);
	});

	it('shapes lane commands per operation and refuses ambiguous targets', () => {
		const laneId = 'lane-11111111-2222-4333-8444-555555555555';
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'lane',
					operation: 'up',
					worktreePath: '/Users/dev/app',
					udid: UDID,
					agent: { kind: 'codex', sessionId: 'thread-1' },
				})
			).success
		).toBe(true);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'lane', operation: 'up', udid: UDID })
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'lane',
					operation: 'up',
					worktreePath: 'relative/app',
					udid: UDID,
				})
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'lane', operation: 'ls' })
			).success
		).toBe(true);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'lane', operation: 'ls', laneId })
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'lane', operation: 'launch', laneId, url: 'checkout' })
			).success
		).toBe(true);
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'lane',
					operation: 'launch',
					laneId,
					worktreePath: '/Users/dev/app',
				})
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'lane', operation: 'down' })
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'lane', operation: 'log', laneId, url: 'nope' })
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'lane',
					operation: 'up',
					worktreePath: '/a',
					udid: UDID,
					shell: 'x',
				})
			).success
		).toBe(false);
	});
});
