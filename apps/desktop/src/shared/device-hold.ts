import { z } from 'zod';
import type { Lane } from './lane-protocol';

/**
 * Lanes and claims share one device-ownership policy. Abandoned holds remain
 * enforced through the grace period; pending lane starts yield to existing claims.
 */

export const DEVICE_HOLD_GRACE_MS = 10 * 60 * 1_000;

/** Legacy mcp-* holders represent shared sessions. Match them by worktree, not ID. */
const SYNTHETIC_SESSION_PREFIX = 'mcp-';

const deviceHolderSchema = z.strictObject({
	kind: z.enum(['claude', 'codex', 'other']),
	sessionId: z.string().min(1).max(128),
});
export type DeviceHolder = z.infer<typeof deviceHolderSchema>;

export const deviceHoldSchema = z.strictObject({
	simulatorUdid: z.string(),
	/** An established lane takes precedence over claims. */
	via: z.enum(['lane', 'claim']),
	laneId: z.string().optional(),
	/** Absent for an operator-owned lane. */
	holder: deviceHolderSchema.optional(),
	holderLive: z.boolean(),
	abandonedSince: z.number().int().nonnegative().optional(),
	releaseAt: z.number().int().nonnegative().optional(),
});
export type DeviceHold = z.infer<typeof deviceHoldSchema>;

function holderKey(holder: DeviceHolder): string {
	return `${holder.kind}:${holder.sessionId}`;
}

export function isSyntheticHolder(
	holder: Pick<DeviceHolder, 'sessionId'>
): boolean {
	return holder.sessionId.startsWith(SYNTHETIC_SESSION_PREFIX);
}

export function isPathInside(child: string, parent: string): boolean {
	const inner = child.replace(/\/+$/, '');
	const outer = parent.replace(/\/+$/, '');
	return inner === outer || inner.startsWith(`${outer}/`);
}

/** Legacy shared identities need one abandonment clock per resource directory. */
export function holderClockKey(
	holder: DeviceHolder,
	directory?: string
): string {
	const key = holderKey(holder);
	return directory !== undefined && isSyntheticHolder(holder)
		? `${key}@${directory.replace(/\/+$/, '')}`
		: key;
}

export type HolderLivenessInputs = {
	liveSessionKeys: ReadonlySet<string>;
	liveSessions?: readonly {
		kind: DeviceHolder['kind'];
		cwd?: string | undefined;
	}[];
	/** First absence by holderClockKey; without a clock, grace starts at now. */
	missingSince: ReadonlyMap<string, number>;
	now: number;
};

export type HolderLiveness =
	| { live: true }
	| { live: false; abandonedSince: number; releaseAt: number };

/** The operator is always live; shared identities require a session in the resource directory. */
export function resolveHolderLiveness(
	holder: DeviceHolder | undefined,
	inputs: HolderLivenessInputs,
	directory?: string
): HolderLiveness {
	if (!holder || inputs.liveSessionKeys.has(holderKey(holder))) {
		return { live: true };
	}
	if (
		directory !== undefined &&
		isSyntheticHolder(holder) &&
		inputs.liveSessions?.some(
			(session) =>
				session.kind === holder.kind &&
				session.cwd !== undefined &&
				isPathInside(session.cwd, directory)
		)
	) {
		return { live: true };
	}
	const since =
		inputs.missingSince.get(holderClockKey(holder, directory)) ?? inputs.now;
	return {
		live: false,
		abandonedSince: since,
		releaseAt: since + DEVICE_HOLD_GRACE_MS,
	};
}

export type DeviceHoldInputs = HolderLivenessInputs & {
	lanes: readonly (Pick<
		Lane,
		'id' | 'simulatorUdid' | 'metro' | 'startedAt'
	> & {
		agent?: DeviceHolder | undefined;
		/** Checkout root, since an agent may work above the app directory in a monorepo. */
		worktreePath?: string | undefined;
		/** Reserve during start without displacing an existing claim. */
		starting?: boolean | undefined;
	})[];
	claims: readonly {
		simulatorUdid: string;
		kind: DeviceHolder['kind'];
		sessionId: string;
	}[];
};

export function resolveDeviceHolds(
	inputs: DeviceHoldInputs
): Map<string, DeviceHold> {
	const holds = new Map<string, DeviceHold>();
	const laneHold = (lane: DeviceHoldInputs['lanes'][number]): DeviceHold => {
		const holder = lane.agent
			? { kind: lane.agent.kind, sessionId: lane.agent.sessionId }
			: undefined;
		return finish(
			inputs,
			{
				simulatorUdid: lane.simulatorUdid.toUpperCase(),
				via: 'lane',
				laneId: lane.id,
				holder,
			},
			lane.worktreePath
		);
	};
	for (const lane of inputs.lanes) {
		if (!lane.starting) {
			holds.set(lane.simulatorUdid.toUpperCase(), laneHold(lane));
		}
	}
	for (const claim of inputs.claims) {
		const udid = claim.simulatorUdid.toUpperCase();
		if (holds.has(udid)) continue;
		holds.set(
			udid,
			finish(inputs, {
				simulatorUdid: udid,
				via: 'claim',
				holder: { kind: claim.kind, sessionId: claim.sessionId },
			})
		);
	}
	for (const lane of inputs.lanes) {
		const udid = lane.simulatorUdid.toUpperCase();
		if (lane.starting && !holds.has(udid)) holds.set(udid, laneHold(lane));
	}
	return holds;
}

function finish(
	inputs: HolderLivenessInputs,
	partial: Pick<DeviceHold, 'simulatorUdid' | 'via' | 'laneId' | 'holder'>,
	directory?: string
): DeviceHold {
	// An operator-started lane has no agent and is never abandoned by this rule;
	// the operator stops it from the panel.
	const liveness = resolveHolderLiveness(partial.holder, inputs, directory);
	if (liveness.live) {
		return { ...stripUndefined(partial), holderLive: true };
	}
	return {
		...stripUndefined(partial),
		holderLive: false,
		abandonedSince: liveness.abandonedSince,
		releaseAt: liveness.releaseAt,
	};
}

function stripUndefined<T extends object>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined)
	) as T;
}

export type DeviceAccessDecision =
	| { allowed: true }
	| { allowed: false; reason: string; hold: DeviceHold };

export type DeviceRequester = DeviceHolder | 'operator' | 'anonymous';

/**
 * The operator may override holds. Agents need ownership or an expired/free hold;
 * anonymous callers cannot own holds. Legacy shared owners also require a matching worktree.
 */
export function decideDeviceAccess(
	hold: DeviceHold | undefined,
	requester: DeviceRequester,
	now: number,
	scope?: {
		directory?: string | undefined;
		requesterCwd?: string | undefined;
	}
): DeviceAccessDecision {
	if (!hold || requester === 'operator') return { allowed: true };
	const released =
		!hold.holderLive && hold.releaseAt !== undefined && now >= hold.releaseAt;
	if (requester === 'anonymous') {
		if (released) return { allowed: true };
		return {
			allowed: false,
			hold,
			reason: `${describeHold(hold, now)} A request that names no session may use free Simulators only.`,
		};
	}
	if (hold.holder && holderKey(hold.holder) === holderKey(requester)) {
		return { allowed: true };
	}
	if (
		hold.holder &&
		isSyntheticHolder(hold.holder) &&
		!isSyntheticHolder(requester) &&
		hold.holder.kind === requester.kind &&
		scope?.directory !== undefined &&
		scope.requesterCwd !== undefined &&
		isPathInside(scope.requesterCwd, scope.directory)
	) {
		return { allowed: true };
	}
	if (released) return { allowed: true };
	return {
		allowed: false,
		hold,
		reason: `${describeHold(hold, now)} Pick a free device, or ask the user to release it.`,
	};
}

function describeHold(hold: DeviceHold, now: number): string {
	const owner = hold.holder
		? `${hold.holder.kind} session ${hold.holder.sessionId}`
		: 'the operator';
	const what =
		hold.via === 'lane' ? `lane ${hold.laneId ?? ''}`.trim() : 'a claim';
	const liveness = hold.holderLive
		? ''
		: ` (its session is gone; the hold releases ${
				hold.releaseAt
					? `in ${Math.max(0, Math.ceil((hold.releaseAt - now) / 60_000))} min`
					: 'soon'
			})`;
	return `Simulator ${hold.simulatorUdid} is held by ${owner} through ${what}${liveness}.`;
}

/** Round up so an active hold never appears expired. */
export function formatHoldDuration(ms: number): string {
	const remaining = Number.isFinite(ms) ? Math.max(0, ms) : 0;
	const seconds = Math.ceil(remaining / 1_000);
	if (seconds < 60) return `${Math.max(1, seconds)} s`;
	const minutes = Math.ceil(remaining / 60_000);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.ceil(remaining / 3_600_000);
	if (hours < 48) return `${hours} h`;
	const days = Math.ceil(remaining / 86_400_000);
	return `${days} ${days === 1 ? 'day' : 'days'}`;
}

export function formatStopDelay(ms: number): string {
	return ms < 120_000 ? `${Math.round(ms / 1_000)} s` : formatHoldDuration(ms);
}

export type HoldCountdownInput = {
	live: boolean;
	releaseAt?: number | undefined;
	/** worktree identifies a legacy shared MCP owner. */
	holder?: 'operator' | 'lane' | 'claim' | 'session' | 'worktree' | undefined;
	synthetic?: boolean | undefined;
};

export type HoldCountdownOptions = {
	verb?: 'releases' | 'stops';
	/** Unreadable session sources pause abandonment clocks. */
	clocksPaused?: boolean;
};

export type HoldCountdownLabel = {
	text: string;
	tone: 'success' | 'warning' | 'info' | 'default';
	remainingMs?: number;
};

export function holdCountdownLabel(
	hold: HoldCountdownInput,
	now: number,
	options: HoldCountdownOptions = {}
): HoldCountdownLabel {
	if (hold.holder === 'operator') return { text: 'operator', tone: 'default' };
	if (hold.live) {
		return hold.holder === 'worktree' || hold.synthetic === true
			? { text: 'by worktree', tone: 'success' }
			: { text: 'live', tone: 'success' };
	}
	if (options.clocksPaused === true) {
		return { text: 'clocks paused', tone: 'info' };
	}
	if (hold.releaseAt === undefined) return { text: 'gone', tone: 'warning' };
	const verb = options.verb ?? 'releases';
	const remainingMs = Math.max(0, hold.releaseAt - now);
	if (remainingMs === 0) {
		return {
			text: `gone · ${verb === 'stops' ? 'stopping' : 'releasing'} now`,
			tone: 'warning',
			remainingMs,
		};
	}
	return {
		text: `gone · ${verb} in ${formatHoldDuration(remainingMs)}`,
		tone: 'warning',
		remainingMs,
	};
}

export function freeDevices(
	udids: readonly string[],
	holds: ReadonlyMap<string, DeviceHold>,
	now: number
): string[] {
	return udids.filter((udid) => {
		const hold = holds.get(udid.toUpperCase());
		if (!hold) return true;
		return (
			!hold.holderLive && hold.releaseAt !== undefined && now >= hold.releaseAt
		);
	});
}
