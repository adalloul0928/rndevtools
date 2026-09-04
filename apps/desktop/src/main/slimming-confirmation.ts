import type { SlimmingConfirmationTarget } from '../shared/slimming-protocol';

export type SlimmingConfirmationCopy = { detail: string; title: string };

function targetList(simulatorUdids: readonly string[]): string {
	return `Targets (${simulatorUdids.length}):\n${simulatorUdids.join('\n')}`;
}

export function slimmingConfirmationCopy(
	target: SlimmingConfirmationTarget,
	profileName?: string
): SlimmingConfirmationCopy | undefined {
	if ('kind' in target && target.kind === 'profile.apply') {
		const profile = profileName
			? `${profileName} (${target.profileId})`
			: target.profileId;
		return {
			title: 'Apply an experimental Simulator profile?',
			detail: `Operation: Apply experimental profile\nProfile: ${profile}\n${targetList(target.simulatorUdids)}\n\nPUMPD will change managed services, reboot when needed, and verify each exact target sequentially.`,
		};
	}
	if ('kind' in target && target.kind === 'profile.undo') {
		return {
			title: 'Undo using stored restore points?',
			detail: `Operation: Undo last PUMPD-managed mutation\n${targetList(target.simulatorUdids)}\n\nPUMPD will restore restart-safe checkpoints and verify each exact target sequentially.`,
		};
	}
	if ('kind' in target && target.kind === 'profile.restore') {
		return {
			title: 'Restore all managed Simulator services?',
			detail: `Operation: Restore all PUMPD-managed services\n${targetList(target.simulatorUdids)}\n\nPUMPD will remove its managed service overrides, reboot when needed, and verify each exact target sequentially.`,
		};
	}
	if (
		'enabled' in target &&
		!target.enabled &&
		target.disposition === 'restore-and-verify'
	) {
		return {
			title: 'Restore managed services and disable slimming?',
			detail: `Operation: Restore all PUMPD-managed services, verify, then disable experimental slimming\n${targetList(target.simulatorUdids)}\n\nPUMPD will process every exact target sequentially before disabling mutation controls.`,
		};
	}
	return undefined;
}
