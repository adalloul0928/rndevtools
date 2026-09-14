import { z } from 'zod';
import { desktopActionSchema } from './protocol';

export const PUMPD_AGENT_CLI_PROTOCOL = 'pumpd-devtools/1' as const;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_SHORT_TEXT_LENGTH = 4 * 1024;
const MAX_QUERY_LENGTH = 8 * 1024;

const identifierSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_IDENTIFIER_LENGTH)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const shortTextSchema = z.string().max(MAX_SHORT_TEXT_LENGTH);
const udidSchema = z
	.string()
	.regex(/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i);
const timeoutSchema = z
	.number()
	.int()
	.min(100)
	.max(10 * 60 * 1_000);

const SAFE_AGENT_ACTIONS = new Set([
	'components.activate',
	'components.focus',
	'components.highlight',
	'components.scroll',
	'components.setText',
	'components.waitForElement',
	'components.waitForScreenChange',
	'network.clearProfile',
	'network.setProfile',
	'performance.start',
	'performance.stop',
	'routes.navigate',
]);

export function isSafeAgentConnectedAction(
	tool: string,
	command: string
): boolean {
	return SAFE_AGENT_ACTIONS.has(`${tool}.${command}`);
}

const agentCliTargetSchema = z.union([
	z.strictObject({ udid: udidSchema }),
	z.strictObject({ deviceId: identifierSchema }),
]);
export type AgentCliTarget = z.infer<typeof agentCliTargetSchema>;

const connectedActionTemplateSchema = z
	.strictObject({
		tool: z.string().trim().min(1).max(64),
		command: z.string().trim().min(1).max(64),
		payload: z.record(z.string().max(128), z.unknown()),
	})
	.superRefine((value, context) => {
		if (!isSafeAgentConnectedAction(value.tool, value.command)) {
			context.addIssue({
				code: 'custom',
				message:
					'The connected-app action is not safe for unattended agent use.',
			});
			return;
		}
		const parsed = desktopActionSchema.safeParse({
			actionId: 'agent-cli-validation',
			deviceId: 'agent-cli-validation',
			...value,
		});
		if (!parsed.success) {
			context.addIssue({
				code: 'custom',
				message: 'The connected-app action is not on the explicit allowlist.',
			});
		}
	});
const waitConditionSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('element'),
		elementId: identifierSchema,
	}),
	z.strictObject({
		kind: z.literal('screen-change'),
		screenHash: identifierSchema,
	}),
	z.strictObject({
		kind: z.literal('job'),
		jobId: identifierSchema,
	}),
	z.strictObject({
		kind: z.literal('network-idle'),
		quietMs: z.number().int().min(100).max(60_000).default(1_000),
	}),
]);

const agentCliCommandSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('doctor') }),
	z.strictObject({
		kind: z.literal('simulators'),
		includeUnavailable: z.boolean().default(false),
	}),
	z.strictObject({
		kind: z.literal('apps'),
		udid: udidSchema,
	}),
	z.strictObject({
		kind: z.literal('screen'),
		target: agentCliTargetSchema,
	}),
	z.strictObject({
		kind: z.literal('elements'),
		target: agentCliTargetSchema,
		query: z.string().max(MAX_QUERY_LENGTH).optional(),
		limit: z.number().int().min(1).max(500).default(100),
	}),
	z.strictObject({
		kind: z.literal('act'),
		target: agentCliTargetSchema,
		action: connectedActionTemplateSchema,
	}),
	z.strictObject({
		kind: z.literal('wait'),
		target: agentCliTargetSchema.optional(),
		condition: waitConditionSchema,
		timeoutMs: timeoutSchema.default(30_000),
	}),
	z.strictObject({
		kind: z.literal('capture'),
		udid: udidSchema,
		format: z.enum(['png', 'jpeg']).default('png'),
		name: shortTextSchema.optional(),
	}),
	z.strictObject({
		kind: z.literal('record'),
		udid: udidSchema,
		operation: z.enum(['start', 'stop']),
		codec: z.enum(['h264', 'hevc']).default('h264'),
		name: shortTextSchema.optional(),
		jobId: identifierSchema.optional(),
	}),
	z
		.strictObject({
			kind: z.literal('network'),
			target: agentCliTargetSchema,
			operation: z.enum(['status', 'set', 'clear']),
			profileId: identifierSchema.optional(),
		})
		.refine(
			(value) =>
				(value.operation === 'set' && value.profileId !== undefined) ||
				(value.operation !== 'set' && value.profileId === undefined),
			{ message: 'Only network set requires a profileId.' }
		),
	z.strictObject({
		kind: z.literal('recipe'),
		operation: z.enum(['list', 'get', 'run', 'cancel', 'status']),
		recipeId: identifierSchema.optional(),
		runId: identifierSchema.optional(),
		udids: z.array(udidSchema).min(1).max(20).optional(),
	}),
	z.strictObject({
		kind: z.literal('jobs'),
		operation: z.enum(['list', 'get', 'cancel']),
		jobId: identifierSchema.optional(),
	}),
	z
		.strictObject({
			kind: z.literal('slimming'),
			operation: z.enum(['status', 'preview', 'doctor', 'verify']),
			udids: z.array(udidSchema).min(1).max(20).optional(),
			profileId: identifierSchema.optional(),
		})
		.superRefine((value, context) => {
			const valid =
				(value.operation === 'status' &&
					value.udids === undefined &&
					value.profileId === undefined) ||
				(value.operation === 'doctor' &&
					value.udids !== undefined &&
					value.profileId === undefined) ||
				((value.operation === 'preview' || value.operation === 'verify') &&
					value.udids !== undefined &&
					value.profileId !== undefined);
			if (!valid) {
				context.addIssue({
					code: 'custom',
					message:
						'Status takes no target; doctor requires only udids; preview and verify require udids plus profileId.',
				});
			}
		}),
]);
export type AgentCliCommand = z.infer<typeof agentCliCommandSchema>;

export const agentCliRequestSchema = z.strictObject({
	protocol: z.literal(PUMPD_AGENT_CLI_PROTOCOL),
	id: identifierSchema,
	command: agentCliCommandSchema,
});
export type AgentCliRequest = z.infer<typeof agentCliRequestSchema>;

const agentCliErrorSchema = z.strictObject({
	code: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z][a-z0-9_]*$/),
	message: shortTextSchema,
	retryable: z.boolean(),
	recovery: shortTextSchema.optional(),
});
export type AgentCliErrorBody = z.infer<typeof agentCliErrorSchema>;

const agentCliResponseSchema = z.union([
	z.strictObject({
		protocol: z.literal(PUMPD_AGENT_CLI_PROTOCOL),
		id: identifierSchema,
		ok: z.literal(true),
		result: z.unknown(),
	}),
	z.strictObject({
		protocol: z.literal(PUMPD_AGENT_CLI_PROTOCOL),
		id: z.string().max(MAX_IDENTIFIER_LENGTH),
		ok: z.literal(false),
		error: agentCliErrorSchema,
	}),
]);
export type AgentCliResponse = z.infer<typeof agentCliResponseSchema>;
