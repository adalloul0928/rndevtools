import { z } from 'zod';

/**
 * Lanes: one git worktree, running on one Simulator, served by one Metro on a
 * port the desktop leased for it. Lanes exist so several branches (and the
 * coding agents working on them) can run side by side without fighting over
 * port 8081 or a shared Simulator.
 *
 * The protocol is deliberately small. A lane never carries product identity:
 * the bundle identifier and URL scheme are read from the worktree's own Expo
 * config at start time and only echoed back for display.
 */

const MAX_PATH_LENGTH = 1024;
const MAX_SHORT_TEXT_LENGTH = 4 * 1024;
const MAX_LANES = 64;
const MAX_WORKTREES = 128;
const MAX_ENVIRONMENTS = 16;
const MAX_LOG_CHARACTERS = 64 * 1024;

export const LANE_METRO_HEALTH_TIMEOUT_MS = 15_000;
export const LANE_AGENT_TOUCH_TTL_MS = 30 * 60 * 1_000;

const identifierSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const shortTextSchema = z.string().max(MAX_SHORT_TEXT_LENGTH);
const timestampSchema = z.number().finite().nonnegative();
const absolutePathSchema = z
	.string()
	.min(2)
	.max(MAX_PATH_LENGTH)
	.refine((value) => value.startsWith('/') && !value.includes('\0'), {
		message: 'Worktree paths must be absolute.',
	});
const portSchema = z.number().int().min(1_024).max(65_535);
const branchSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(
		/^[^\s~^:?*[\\]+$/,
		'Branch names must not contain git-reserved characters.'
	);

export const laneIdSchema = z
	.string()
	.regex(/^lane-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);

const laneUdidSchema = z
	.string()
	.regex(/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i);

const laneEnvironmentIdSchema = z
	.string()
	.regex(/^[a-z][a-z0-9-]{0,31}$/, 'Environment ids are lowercase slugs.');

const laneEnvironmentSchema = z
	.strictObject({
		id: laneEnvironmentIdSchema,
		/** Inclusive Metro port range this environment may lease from. */
		portRange: z.tuple([portSchema, portSchema]),
		/** Extra environment variables for Metro, selected in JavaScript only. */
		metroEnv: z
			.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(1_024))
			.optional(),
	})
	.refine((value) => value.portRange[0] <= value.portRange[1], {
		message: 'Port range start must not exceed its end.',
		path: ['portRange'],
	});
export type LaneEnvironment = z.infer<typeof laneEnvironmentSchema>;

/**
 * Non-overlapping ranges per environment, so two lanes can never race for one
 * port and an agent can tell from the port alone which environment it hit.
 */
export const DEFAULT_LANE_ENVIRONMENTS: readonly LaneEnvironment[] = [
	{ id: 'development', portRange: [8_100, 8_199] },
	{ id: 'staging', portRange: [8_200, 8_299] },
	{ id: 'production', portRange: [8_300, 8_399] },
];

const laneAgentKindSchema = z.enum(['claude', 'codex', 'other']);

export const laneAgentSchema = z.strictObject({
	kind: laneAgentKindSchema,
	sessionId: identifierSchema,
	/** Last time this agent touched the lane through the CLI. */
	lastSeenAt: timestampSchema,
});
export type LaneAgent = z.infer<typeof laneAgentSchema>;

const laneMetroStatusSchema = z.enum(['starting', 'ready', 'stopped']);

/**
 * Slimming folded into a lane start. The lane only records the request and
 * its outcome; the mutation itself still goes through the SimSlim service,
 * which keeps every gate it has today: the experimental setting, the device
 * compatibility tuple, and the signed-parent authorization the native helper
 * demands before it disables a single service.
 *
 * `needs-approval` is where an unattended `rndevtools lane up --slim` lands.
 * Only the desktop app can approve, because approval means a person clicked
 * a native dialog; a CLI flag is not a person.
 */
const laneSlimStatusSchema = z.enum([
	'needs-approval',
	'applying',
	'applied',
	'skipped',
	'failed',
]);

const laneSlimSchema = z.strictObject({
	profileId: identifierSchema,
	status: laneSlimStatusSchema,
	/** Why slimming was skipped or failed, for the operator and the agent. */
	message: shortTextSchema.optional(),
	/** The SimSlim job that applied the profile, when one ran. */
	jobId: identifierSchema.optional(),
	updatedAt: timestampSchema,
});
export type LaneSlim = z.infer<typeof laneSlimSchema>;

export const laneSchema = z.strictObject({
	id: laneIdSchema,
	/** The git checkout root this lane runs from. */
	worktreePath: absolutePathSchema,
	/**
	 * The Expo app directory inside the worktree, when it is not the root
	 * (monorepos). Metro runs here and the Expo config is read here. Absent
	 * when the app is the checkout itself.
	 */
	appPath: absolutePathSchema.optional(),
	branch: branchSchema,
	simulatorUdid: laneUdidSchema,
	environment: laneEnvironmentIdSchema,
	port: portSchema,
	metroPid: z.number().int().positive().optional(),
	metro: laneMetroStatusSchema,
	logPath: absolutePathSchema,
	bundleIdentifier: z
		.string()
		.regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/)
		.optional(),
	scheme: z
		.string()
		.regex(/^[A-Za-z][A-Za-z0-9+.-]{0,63}$/)
		.optional(),
	startedAt: timestampSchema,
	lastLaunchedAt: timestampSchema.optional(),
	agent: laneAgentSchema.optional(),
	slim: laneSlimSchema.optional(),
});
export type Lane = z.infer<typeof laneSchema>;

const laneWorktreeSchema = z.strictObject({
	path: absolutePathSchema,
	branch: branchSchema,
	repositoryRoot: absolutePathSchema,
	dirty: z.boolean(),
	laneId: laneIdSchema.optional(),
});
export type LaneWorktree = z.infer<typeof laneWorktreeSchema>;

export const laneStateSchema = z.strictObject({
	revision: z.number().int().nonnegative(),
	updatedAt: timestampSchema,
	environments: z.array(laneEnvironmentSchema).min(1).max(MAX_ENVIRONMENTS),
	lanes: z.array(laneSchema).max(MAX_LANES),
	worktrees: z.array(laneWorktreeSchema).max(MAX_WORKTREES),
	/** Repository roots whose worktrees are listed above. */
	repositories: z.array(absolutePathSchema).max(32),
	error: shortTextSchema.optional(),
});
export type LaneState = z.infer<typeof laneStateSchema>;

const operationBase = { actionId: identifierSchema };

export const laneOperationSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.start'),
		/**
		 * A checkout root, or any directory inside one: the containing worktree
		 * becomes the lane's worktree and this directory its Expo app.
		 */
		worktreePath: absolutePathSchema,
		simulatorUdid: laneUdidSchema,
		environment: laneEnvironmentIdSchema.default('development'),
		preferredPort: portSchema.optional(),
		/** Open the dev client against the leased Metro once it is healthy. */
		launch: z.boolean().default(true),
		/**
		 * Apply this SimSlim profile to the Simulator before Metro starts.
		 * Requires operator approval in the desktop app; see `laneSlimSchema`.
		 */
		slimProfileId: identifierSchema.optional(),
		agent: laneAgentSchema.pick({ kind: true, sessionId: true }).optional(),
	}),
	/** Resolves a lane whose slimming is waiting on the operator. */
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.slim'),
		laneId: laneIdSchema,
		decision: z.enum(['approve', 'dismiss']),
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.launch'),
		laneId: laneIdSchema,
		/** A bare path uses the lane's scheme; a full URL passes through. */
		url: z.string().min(1).max(2_048).optional(),
		agent: laneAgentSchema.pick({ kind: true, sessionId: true }).optional(),
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.stop'),
		laneId: laneIdSchema,
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.log'),
		laneId: laneIdSchema,
		maxCharacters: z
			.number()
			.int()
			.min(256)
			.max(MAX_LOG_CHARACTERS)
			.default(16 * 1024),
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.refresh'),
	}),
	/** Picks a repository through a native folder dialog owned by main. */
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.add-repository'),
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.remove-repository'),
		repositoryRoot: absolutePathSchema,
	}),
]);
export type LaneOperation = z.infer<typeof laneOperationSchema>;

export const laneOperationReceiptSchema = z.strictObject({
	actionId: identifierSchema,
	kind: z.enum([
		'lane.start',
		'lane.slim',
		'lane.launch',
		'lane.stop',
		'lane.log',
		'lane.refresh',
		'lane.add-repository',
		'lane.remove-repository',
	]),
	completed: z.boolean(),
	cancelled: z.boolean().optional(),
	error: shortTextSchema.optional(),
	lane: laneSchema.optional(),
	log: z.string().max(MAX_LOG_CHARACTERS).optional(),
	state: laneStateSchema.optional(),
});
export type LaneOperationReceipt = z.infer<typeof laneOperationReceiptSchema>;

export type LaneBridge = {
	getLaneState: () => Promise<LaneState>;
	subscribeLaneState: (listener: (state: LaneState) => void) => () => void;
	runLaneOperation: (operation: LaneOperation) => Promise<LaneOperationReceipt>;
};

/**
 * Builds the Expo development-client launch URL for a lane. SDK 57 and earlier
 * only understand the `expo-development-client/?url=` form; SDK 58 keeps
 * accepting it, so it is the safe choice for an arbitrary worktree. The
 * automation parameters skip the onboarding sheet and the dev-menu auto-open
 * so an agent sees the app, not the launcher.
 */
export function laneDevClientLaunchUrl(
	scheme: string,
	port: number,
	host = '127.0.0.1'
): string {
	const metroUrl = `http://${host}:${port}`;
	const params = new URLSearchParams({
		url: metroUrl,
		disableOnboarding: '1',
		disableAutoLaunch: '1',
	});
	return `${scheme}://expo-development-client/?${params.toString()}`;
}

/**
 * Resolves what an agent or operator typed into a URL the Simulator can open.
 * Anything with a scheme passes through untouched; a bare path is prefixed with
 * the lane's own scheme so `lane launch --url checkout` opens `app://checkout`.
 */
export function laneDeepLink(
	lane: Pick<Lane, 'scheme'>,
	input: string
): string {
	const requested = input.trim();
	if (/^[a-z][a-z0-9+.-]*:/i.test(requested)) return requested;
	if (!lane.scheme) {
		throw new Error(
			'This lane has no URL scheme; pass a fully qualified URL instead.'
		);
	}
	return `${lane.scheme}://${requested.replace(/^\/+/, '')}`;
}

export type LaneHealth = {
	label: 'ready' | 'starting' | 'stopped';
	tone: 'success' | 'warning' | 'danger';
};

/** How a lane's slimming request reads in a row or a CLI summary. */
export function laneSlimSummary(
	slim: LaneSlim | undefined
):
	| { label: string; tone: 'success' | 'warning' | 'danger' | 'muted' }
	| undefined {
	if (!slim) return undefined;
	switch (slim.status) {
		case 'applied':
			return { label: `slim: ${slim.profileId}`, tone: 'success' };
		case 'applying':
			return { label: `slimming: ${slim.profileId}`, tone: 'warning' };
		case 'needs-approval':
			return { label: 'slim: approve in app', tone: 'warning' };
		case 'failed':
			return { label: 'slim failed', tone: 'danger' };
		default:
			return { label: 'slim skipped', tone: 'muted' };
	}
}

export function laneHealth(lane: Pick<Lane, 'metro'>): LaneHealth {
	switch (lane.metro) {
		case 'ready':
			return { label: 'ready', tone: 'success' };
		case 'starting':
			return { label: 'starting', tone: 'warning' };
		default:
			return { label: 'stopped', tone: 'danger' };
	}
}

/**
 * Picks the next free port in an environment's range, skipping ports already
 * leased by a lane whose Metro is still alive. `isPortFree` is injected so the
 * bind probe stays in the main process and this stays unit-testable.
 */
export async function allocateLanePort({
	environment,
	lanes,
	isPortFree,
	preferredPort,
}: {
	environment: LaneEnvironment;
	lanes: readonly Pick<Lane, 'port' | 'metro'>[];
	isPortFree: (port: number) => Promise<boolean>;
	preferredPort?: number;
}): Promise<number> {
	const [start, end] = environment.portRange;
	const leased = new Set(
		lanes.filter((lane) => lane.metro !== 'stopped').map((lane) => lane.port)
	);
	if (preferredPort !== undefined) {
		if (preferredPort < start || preferredPort > end) {
			throw new Error(
				`Preferred port ${preferredPort} is outside ${environment.id}'s range ${start}-${end}.`
			);
		}
		if (leased.has(preferredPort) || !(await isPortFree(preferredPort))) {
			throw new Error(`Metro port ${preferredPort} is already in use.`);
		}
		return preferredPort;
	}
	for (let port = start; port <= end; port += 1) {
		if (leased.has(port)) continue;
		if (await isPortFree(port)) return port;
	}
	throw new Error(
		`No free Metro port remains in ${environment.id}'s range ${start}-${end}.`
	);
}

/** The directory a lane's Metro and Expo config live in. */
export function laneAppDirectory(
	lane: Pick<Lane, 'worktreePath' | 'appPath'>
): string {
	return lane.appPath ?? lane.worktreePath;
}

/**
 * Lane creation fails instead of stealing. An app directory, a Simulator, or
 * a port that another live lane owns is an error, never a takeover. Two apps
 * in one monorepo worktree may each have a lane; one app may not have two.
 */
export function findLaneConflict(
	lanes: readonly Lane[],
	candidate: Pick<Lane, 'worktreePath' | 'appPath' | 'simulatorUdid'>
): string | undefined {
	const udid = candidate.simulatorUdid.toUpperCase();
	const app = laneAppDirectory(candidate);
	for (const lane of lanes) {
		if (laneAppDirectory(lane) === app) {
			return `${app} already has lane ${lane.id}.`;
		}
		if (lane.simulatorUdid.toUpperCase() === udid) {
			return `Simulator ${candidate.simulatorUdid} is already assigned to lane ${lane.id}.`;
		}
	}
	return undefined;
}

export function laneAgentFromEnvironment(
	env: Readonly<Record<string, string | undefined>>
): Pick<LaneAgent, 'kind' | 'sessionId'> | undefined {
	const claude = env.CLAUDE_CODE_SESSION_ID?.trim();
	if (claude && identifierSchema.safeParse(claude).success) {
		return { kind: 'claude', sessionId: claude };
	}
	const codex = env.CODEX_THREAD_ID?.trim();
	if (codex && identifierSchema.safeParse(codex).success) {
		return { kind: 'codex', sessionId: codex };
	}
	const other = env.RNDEVTOOLS_AGENT_SESSION_ID?.trim();
	if (other && identifierSchema.safeParse(other).success) {
		return { kind: 'other', sessionId: other };
	}
	return undefined;
}
