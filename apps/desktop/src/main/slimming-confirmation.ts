import type { SlimmingConfirmationTarget } from '../shared/slimming-protocol';

export type SlimmingConfirmationCopy = { detail: string; title: string };

function targetList(simulatorUdids: readonly string[]): string {
	return `Targets (${simulatorUdids.length}):\n${simulatorUdids.join('\n')}`;
}

/**
 * Which slimming operations still ask the operator before running.
 *
 * Applying, undoing, and restoring a profile no longer do: they are reversible
 * (`undo_last` and `restore_managed` exist, and SimSlim keeps checkpoints), the
 * slimming service now refuses to touch a Simulator another session holds, and
 * the first use of an untested runtime/profile combination is gated by its own
 * one-time acknowledgement. A person who clicks Apply has said what they want,
 * and an agent that asks over the socket is checked for ownership instead.
 * What remains here is the one slimming change that is a mode switch, not a
 * mutation: turning slimming off while restoring every managed service.
 */
export function slimmingConfirmationCopy(
	target: SlimmingConfirmationTarget
): SlimmingConfirmationCopy | undefined {
	if (
		'enabled' in target &&
		!target.enabled &&
		target.disposition === 'restore-and-verify'
	) {
		return {
			title: 'Restore managed services and disable slimming?',
			detail: `Operation: Restore all rndevtools-managed services, verify, then disable experimental slimming\n${targetList(target.simulatorUdids)}\n\nRN Devtools will process every exact target sequentially before disabling mutation controls.`,
		};
	}
	return undefined;
}
