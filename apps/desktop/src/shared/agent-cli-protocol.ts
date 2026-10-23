import { z } from 'zod';
import { laneAgentSchema, laneIdSchema } from './lane-protocol';
import { desktopActionSchema } from './protocol';
import { simulatorInputSchema } from './simulator-input-protocol';
import { UDID_PATTERN } from './simulator-protocol';
import {
	logServiceSchema,
	logSinceSchema,
	SUPABASE_AGENT_MAX_WAIT_MS,
	SUPABASE_AGENT_OPERATIONS,
} from './supabase-protocol';

export const RNDEVTOOLS_AGENT_CLI_PROTOCOL = 'rndevtools/1' as const;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_SHORT_TEXT_LENGTH = 4 * 1024;
const MAX_QUERY_LENGTH = 8 * 1024;
const MAX_SUPABASE_NOTE_LENGTH = 240;
const MAX_SUPABASE_LOG_SERVICES = 16;
const MAX_SUPABASE_LOG_TAIL = 1_000;

const identifierSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_IDENTIFIER_LENGTH)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const shortTextSchema = z.string().max(MAX_SHORT_TEXT_LENGTH);
const udidSchema = z.string().regex(UDID_PATTERN);
const timeoutSchema = z
	.number()
	.int()
	.min(100)
	.max(10 * 60 * 1_000);
const absolutePathSchema = z
	.string()
	.min(1)
	.max(1_024)
	.refine((value) => value.startsWith('/') && !value.includes('\0'), {
		message: 'The path must be absolute.',
	});

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

/** The worktree a `supabase` command names: absolute, and no control characters. */
const supabaseWorktreePathSchema = z
	.string()
	.min(2)
	.max(1_024)
	.refine((value) => value.startsWith('/') && !hasControlCharacters(value), {
		message: 'worktreePath must be absolute.',
	});
/**
 * The fields each `supabase` operation takes besides its target. `ls` takes
 * no target; every other operation exactly one of worktreePath or stackId.
 */
const SUPABASE_OPERATION_FIELDS: Readonly<
	Record<(typeof SUPABASE_AGENT_OPERATIONS)[number], readonly string[]>
> = {
	up: ['waitMs'],
	down: [],
	ls: [],
	status: [],
	env: [],
	reset: ['seed', 'note'],
	log: ['services', 'tail', 'since'],
	destroy: ['note'],
};

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
			/**
			 * Read-only: `status`, `preview`, `doctor`, `verify`. Mutating: `apply`
			 * (a profile), `undo` (the last managed mutation), `restore` (all
			 * managed services). Mutations run only on devices the calling session
			 * holds or that are free, only while SimSlim is enabled in the desktop,
			 * and only on runtime/profile combinations the operator has approved or
			 * SimSlim has verified.
			 */
			operation: z.enum([
				'status',
				'preview',
				'doctor',
				'verify',
				'apply',
				'undo',
				'restore',
			]),
			udids: z.array(udidSchema).min(1).max(20).optional(),
			profileId: identifierSchema.optional(),
		})
		.superRefine((value, context) => {
			const needsProfile =
				value.operation === 'preview' ||
				value.operation === 'verify' ||
				value.operation === 'apply';
			const udidsOnly =
				value.operation === 'doctor' ||
				value.operation === 'undo' ||
				value.operation === 'restore';
			const valid =
				(value.operation === 'status' &&
					value.udids === undefined &&
					value.profileId === undefined) ||
				(udidsOnly &&
					value.udids !== undefined &&
					value.profileId === undefined) ||
				(needsProfile &&
					value.udids !== undefined &&
					value.profileId !== undefined);
			if (!valid) {
				context.addIssue({
					code: 'custom',
					message:
						'Status takes no target; doctor, undo, and restore require only udids; preview, verify, and apply require udids plus profileId.',
				});
			}
		}),
	/**
	 * Native build planning. `plan` fingerprints a worktree with its own Expo
	 * tooling and reports whether the configured build cache holds a binary and
	 * whether that binary is installed on a Simulator; it never builds.
	 * `install` puts a cached binary onto the Simulator when there is a hit.
	 */
	z
		.strictObject({
			kind: z.literal('native'),
			operation: z.enum(['plan', 'install']),
			worktreePath: z
				.string()
				.min(2)
				.max(1_024)
				.refine((value) => value.startsWith('/'), {
					message: 'worktreePath must be absolute.',
				}),
			udid: udidSchema.optional(),
			configuration: z.enum(['Debug', 'Release']).default('Debug'),
		})
		.superRefine((value, context) => {
			if (value.operation === 'install' && value.udid === undefined) {
				context.addIssue({
					code: 'custom',
					message: 'native install requires udid.',
				});
			}
		}),
	/**
	 * Native Simulator input through the signed host (SimulatorKit HID): tap,
	 * swipe, text, key, button. Works on any screen, connected app or not.
	 * Coordinates are 0…1 ratios of the device screen.
	 */
	z.strictObject({
		kind: z.literal('input'),
		input: simulatorInputSchema,
	}),
	/** Live coding-agent sessions and which Simulators they are attached to. */
	z.strictObject({ kind: z.literal('agents') }),
	/**
	 * Claims make ownership explicit. The agent identity comes from the
	 * connection, never from a flag or a field: the desktop proves that the
	 * process sending the request owns the socket (`peer` on the envelope)
	 * and maps it to the Claude Code session that spawned it; the envelope's
	 * `agent` is only a claim, and one that names another live session is
	 * refused. A request that claims nothing is unprivileged, not the operator:
	 * it may use free Simulators only and can neither claim nor release. A claim
	 * that no running Claude Code session backs is refused outright.
	 */
	z.strictObject({
		kind: z.literal('claim'),
		udid: udidSchema,
		note: z.string().max(4_096).optional(),
	}),
	z
		.strictObject({
			kind: z.literal('release'),
			udid: udidSchema.optional(),
			/**
			 * Release everything this session holds: stop its lanes and drop its
			 * claims. What a session-end hook calls so devices return to the pool
			 * the moment an agent exits, rather than after the grace period.
			 */
			all: z.boolean().optional(),
			/**
			 * Where the ending session worked, sent with `all` by the session-end
			 * hook. Kept for older CLIs and for the holds an older desktop recorded
			 * under a shared MCP identity (`mcp-*`), which are released only when
			 * this directory lies inside them, never by the id alone. A verified
			 * session is a Claude Code session, which never holds under one.
			 */
			sessionCwd: absolutePathSchema.optional(),
		})
		.refine((value) => Boolean(value.udid) !== Boolean(value.all), {
			message: 'release takes exactly one of udid or all.',
		})
		.refine((value) => value.sessionCwd === undefined || value.all === true, {
			message: 'release takes sessionCwd only with all.',
		}),
	z
		.strictObject({
			kind: z.literal('lane'),
			operation: z.enum(['up', 'down', 'ls', 'launch', 'log']),
			worktreePath: z
				.string()
				.min(2)
				.max(1_024)
				.refine((value) => value.startsWith('/'), {
					message: 'worktreePath must be absolute.',
				})
				.optional(),
			/**
			 * The Simulator for `up`. Omit it to let the desktop pick a free iPhone
			 * (booted first); when none is free, the result carries a
			 * `deviceRequest` the user settles in RN Devtools.
			 */
			udid: udidSchema.optional(),
			environment: z
				.string()
				.regex(/^[a-z][a-z0-9-]{0,31}$/)
				.optional(),
			preferredPort: z.number().int().min(1_024).max(65_535).optional(),
			launch: z.boolean().optional(),
			/**
			 * SimSlim profile to apply to the lane's Simulator before Metro starts.
			 * The desktop applies it when SimSlim is enabled, the device's
			 * compatibility tuple allows it, and the device is free or held by this
			 * session; otherwise `lane.slim` records `skipped` with the reason.
			 */
			slimProfileId: identifierSchema.optional(),
			/**
			 * This worktree's local Supabase for `up`: `auto` starts it alongside
			 * the lane when RN Devtools manages the worktree, `required` fails the
			 * lane without it, `off` skips it. The environment's default applies
			 * when omitted.
			 */
			backend: z.enum(['auto', 'off', 'required']).optional(),
			laneId: laneIdSchema.optional(),
			url: z.string().min(1).max(2_048).optional(),
			maxCharacters: z.number().int().min(256).max(64_000).optional(),
		})
		.superRefine((value, context) => {
			const only = (allowed: readonly string[]) =>
				Object.entries(value)
					.filter(([key, field]) => field !== undefined && key !== 'kind')
					.every(([key]) => allowed.includes(key));
			const valid =
				(value.operation === 'up' &&
					value.worktreePath !== undefined &&
					only([
						'operation',
						'worktreePath',
						'udid',
						'environment',
						'preferredPort',
						'launch',
						'slimProfileId',
						'backend',
					])) ||
				(value.operation === 'down' &&
					(value.laneId !== undefined) !== (value.worktreePath !== undefined) &&
					only(['operation', 'laneId', 'worktreePath'])) ||
				(value.operation === 'ls' && only(['operation'])) ||
				(value.operation === 'launch' &&
					(value.laneId !== undefined) !== (value.worktreePath !== undefined) &&
					only(['operation', 'laneId', 'worktreePath', 'url'])) ||
				(value.operation === 'log' &&
					(value.laneId !== undefined) !== (value.worktreePath !== undefined) &&
					only(['operation', 'laneId', 'worktreePath', 'maxCharacters']));
			if (!valid) {
				context.addIssue({
					code: 'custom',
					message:
						'up requires worktreePath (without udid the desktop picks a free Simulator); down, launch, and log take exactly one of laneId or worktreePath; ls takes nothing else.',
				});
			}
		}),
	/**
	 * The worktree's own local Supabase stack, run natively and on loopback by
	 * RN Devtools. `up` creates or resumes it (and answers with a job when it
	 * is not ready within waitMs), `down` drops this session's hold, `env`
	 * returns the public URL and keys only, and `destroy` files a request the
	 * user settles in RN Devtools. A stackId may be a unique prefix.
	 */
	z
		.strictObject({
			kind: z.literal('supabase'),
			operation: z.enum(SUPABASE_AGENT_OPERATIONS),
			worktreePath: supabaseWorktreePathSchema.optional(),
			stackId: z
				.string()
				.regex(/^[0-9a-f]{8,64}$/)
				.optional(),
			waitMs: z
				.number()
				.int()
				.min(0)
				.max(SUPABASE_AGENT_MAX_WAIT_MS)
				.optional(),
			seed: z.boolean().optional(),
			// The contract's own filters: service kinds, gateway or instance ids,
			// and start, a duration, or an ISO-8601 time.
			services: z
				.array(logServiceSchema)
				.min(1)
				.max(MAX_SUPABASE_LOG_SERVICES)
				.refine((values) => new Set(values).size === values.length, {
					message: 'Name each service once.',
				})
				.optional(),
			tail: z.number().int().min(1).max(MAX_SUPABASE_LOG_TAIL).optional(),
			since: logSinceSchema.optional(),
			/** Shown to the user on the request card; the desktop sanitizes it. */
			note: z.string().max(MAX_SUPABASE_NOTE_LENGTH).optional(),
		})
		.superRefine((value, context) => {
			const targets =
				Number(value.worktreePath !== undefined) +
				Number(value.stackId !== undefined);
			if (value.operation === 'ls' ? targets !== 0 : targets !== 1) {
				context.addIssue({
					code: 'custom',
					message:
						'supabase ls takes no target; every other operation takes exactly one of worktreePath or stackId.',
				});
			}
			const allowed = SUPABASE_OPERATION_FIELDS[value.operation];
			const extra = Object.entries(value).filter(
				([key, field]) =>
					field !== undefined &&
					!['kind', 'operation', 'worktreePath', 'stackId'].includes(key) &&
					!allowed.includes(key)
			);
			if (extra.length > 0) {
				context.addIssue({
					code: 'custom',
					message:
						'waitMs is for supabase up, seed for reset, services, tail, and since for log, and note for destroy and reset.',
				});
			}
		}),
]);
export type AgentCliCommand = z.infer<typeof agentCliCommandSchema>;

export const agentCliRequestSchema = z.strictObject({
	protocol: z.literal(RNDEVTOOLS_AGENT_CLI_PROTOCOL),
	id: identifierSchema,
	command: agentCliCommandSchema,
	/**
	 * The coding-agent session the CLI says it is running inside, read from
	 * its session variables. A claim, not an identity: the desktop maps `peer`
	 * to the session the sending process runs under and records touches and
	 * holds only for that one. A claim that names no live session is ignored
	 * when the sender runs under one (an MCP server keeps the id it started
	 * with after a /clear), and a claim that names another live session is
	 * refused.
	 */
	agent: laneAgentSchema.pick({ kind: true, sessionId: true }).optional(),
	/**
	 * The process that sent the request, by its own pid. The desktop verifies
	 * with lsof that this pid holds the other end of the connection the
	 * request arrived on, and only then walks its process tree to the Claude
	 * Code session that spawned it; a pid it cannot prove leaves a claim
	 * unverified. The bound is one no pid on a Mac reaches.
	 */
	peer: z
		.strictObject({ pid: z.number().int().positive().max(4_194_304) })
		.optional(),
});
export type AgentCliRequest = z.infer<typeof agentCliRequestSchema>;

/** The session a request claims, as the CLI's session variables name it. */
export type AgentCliClaim = NonNullable<AgentCliRequest['agent']>;

/**
 * Why a claim could not be verified, which decides what an agent can do about
 * it. `no-proof`: the sender did not prove that it owns the connection (an
 * older CLI names no pid, or the check failed or timed out). `no-process-table`:
 * the process list could not be read, so the sender could not be traced.
 * Both can pass on a retry. `no-session`: the sender runs under no Claude Code
 * session the desktop knows, which a retry does not change: Codex threads
 * share one process, and other agents and ended sessions have no process to
 * match.
 */
export type AgentUnverifiedCause =
	| 'no-proof'
	| 'no-process-table'
	| 'no-session';

/**
 * Connection-bound identity, decided from the process that sent a request
 * rather than from what it says. A sender that runs under a discovered Claude
 * Code session is that session (`verified`), whatever stale or foreign id it
 * claims, unless it claims a different live session (`mismatch`). A sender
 * under no session is `unverified`, unless it claims a live session with a
 * process, which it does not run under (`mismatch`). A request that claims no
 * session is `anonymous` and unprivileged.
 */
export type AgentIdentityResolution =
	| { status: 'anonymous' }
	| { status: 'unverified'; cause: AgentUnverifiedCause; reason: string }
	| { status: 'verified'; agent: AgentCliClaim; basis: 'process' }
	| { status: 'mismatch'; reason: string };

/**
 * What `release --all` answers. Work that outlasts the session-end budget
 * carries on by itself: `pendingLanes` are lanes still stopping, and
 * `pendingStops` the Supabase stacks nobody holds any more, which stop after
 * the linger.
 */
export type AgentReleaseAllResult = {
	you: NonNullable<AgentCliRequest['agent']>;
	stoppedLanes: string[];
	pendingLanes: string[];
	releasedClaims: string[];
	/** Stacks whose hold this release dropped, when local Supabase is available. */
	releasedStacks?: string[];
	pendingStops?: string[];
	errors: string[];
	next?: string;
};

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
		protocol: z.literal(RNDEVTOOLS_AGENT_CLI_PROTOCOL),
		id: identifierSchema,
		ok: z.literal(true),
		result: z.unknown(),
	}),
	z.strictObject({
		protocol: z.literal(RNDEVTOOLS_AGENT_CLI_PROTOCOL),
		id: z.string().max(MAX_IDENTIFIER_LENGTH),
		ok: z.literal(false),
		error: agentCliErrorSchema,
	}),
]);
export type AgentCliResponse = z.infer<typeof agentCliResponseSchema>;
