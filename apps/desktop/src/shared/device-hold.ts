import { z } from 'zod';
import type { Lane } from './lane-protocol';

/**
 * Who may touch a Simulator.
 *
 * A device is **free** or **held**. It is held while a lane runs on it or an
 * agent has claimed it, and only the holder may boot, slim, drive, or release
 * it. Metro status and agent attribution are details shown on a held device,
 * not states of their own. A hold whose holder has gone away (the agent
 * session exited, the lane's Metro died) is **abandoned**; after
 * {@link DEVICE_HOLD_GRACE_MS} the desktop releases it so the device returns to
 * the pool without anyone's cooperation.
 *
 * Both the lane service and the slimming service ask this one resolver, so a
 * device cannot be rebooted by a slim while another agent's lane is on it.
 */

/** How long an abandoned hold survives before the desktop releases it. */
export const DEVICE_HOLD_GRACE_MS = 10 * 60 * 1_000;

const deviceHolderSchema = z.strictObject({
	kind: z.enum(['claude', 'codex', 'other']),
	sessionId: z.string().min(1).max(128),
});
export type DeviceHolder = z.infer<typeof deviceHolderSchema>;

export const deviceHoldSchema = z.strictObject({
	simulatorUdid: z.string(),
	/** What establishes the hold. A lane wins over a bare claim. */
	via: z.enum(['lane', 'claim']),
	laneId: z.string().optional(),
	/**
	 * The agent session that owns the hold. Absent for a lane a person started
	 * from the desktop, which belongs to the operator.
	 */
	holder: deviceHolderSchema.optional(),
	/** Whether the holder is still alive: its session is running, or it is the operator. */
	holderLive: z.boolean(),
	/** When the holder was last known alive, once it is not. */
	abandonedSince: z.number().int().nonnegative().optional(),
	/** When the desktop will release an abandoned hold, once it is abandoned. */
	releaseAt: z.number().int().nonnegative().optional(),
});
export type DeviceHold = z.infer<typeof deviceHoldSchema>;

/** `kind:sessionId`, the identity of one agent session (the same key the agent service uses). */
function holderKey(holder: DeviceHolder): string {
	return `${holder.kind}:${holder.sessionId}`;
}

export type DeviceHoldInputs = {
	lanes: readonly Pick<
		Lane,
		'id' | 'simulatorUdid' | 'agent' | 'metro' | 'startedAt'
	>[];
	/** Agent claims: a device, and the session that claimed it. */
	claims: readonly {
		simulatorUdid: string;
		kind: DeviceHolder['kind'];
		sessionId: string;
	}[];
	/** `holderKey` of every agent session currently alive on this Mac. */
	liveSessionKeys: ReadonlySet<string>;
	/** Earliest time each absent holder was first noticed missing, by session key. */
	missingSince: ReadonlyMap<string, number>;
	now: number;
};

/**
 * Derives the hold on every Simulator from lanes and claims. Pure, so the lane
 * service, the slimming service, the agent command router, and the renderer
 * all compute the same answer from the same inputs.
 */
export function resolveDeviceHolds(
	inputs: DeviceHoldInputs
): Map<string, DeviceHold> {
	const holds = new Map<string, DeviceHold>();
	for (const lane of inputs.lanes) {
		const udid = lane.simulatorUdid.toUpperCase();
		const holder = lane.agent
			? { kind: lane.agent.kind, sessionId: lane.agent.sessionId }
			: undefined;
		holds.set(
			udid,
			finish(inputs, {
				simulatorUdid: udid,
				via: 'lane',
				laneId: lane.id,
				holder,
			})
		);
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
	return holds;
}

function finish(
	inputs: DeviceHoldInputs,
	partial: Pick<DeviceHold, 'simulatorUdid' | 'via' | 'laneId' | 'holder'>
): DeviceHold {
	// An operator-started lane has no agent and is never abandoned by this rule;
	// the operator stops it from the panel.
	if (!partial.holder) {
		return { ...stripUndefined(partial), holderLive: true };
	}
	const key = holderKey(partial.holder);
	if (inputs.liveSessionKeys.has(key)) {
		return { ...stripUndefined(partial), holderLive: true };
	}
	const since = inputs.missingSince.get(key) ?? inputs.now;
	return {
		...stripUndefined(partial),
		holderLive: false,
		abandonedSince: since,
		releaseAt: since + DEVICE_HOLD_GRACE_MS,
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

/**
 * Whether `requester` may mutate or drive the device. The operator (no
 * requester) may touch anything; an agent may touch a free device, a device it
 * holds, or a device whose hold is abandoned and past its grace period.
 */
export function decideDeviceAccess(
	hold: DeviceHold | undefined,
	requester: DeviceHolder | undefined,
	now: number
): DeviceAccessDecision {
	if (!hold || !requester) return { allowed: true };
	if (hold.holder && holderKey(hold.holder) === holderKey(requester)) {
		return { allowed: true };
	}
	if (
		!hold.holderLive &&
		hold.releaseAt !== undefined &&
		now >= hold.releaseAt
	) {
		return { allowed: true };
	}
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
	return {
		allowed: false,
		hold,
		reason: `Simulator ${hold.simulatorUdid} is held by ${owner} through ${what}${liveness}. Pick a free device, or ask the user to release it.`,
	};
}

/** The UDIDs with no hold at all, in the order given. */
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
