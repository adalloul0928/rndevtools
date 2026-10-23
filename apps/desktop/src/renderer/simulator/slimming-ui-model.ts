import {
	SLIMMING_CONFIRMATIONS,
	SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT,
	type SlimmingSettingRequest,
	type SlimmingSimulatorStatus,
	type SlimmingState,
} from '../../shared/slimming-protocol';

export type UnknownTupleAcknowledgement = {
	binding: string;
	value: string;
};

type RestoreAndDisableInput = Omit<
	Extract<
		SlimmingSettingRequest,
		{ enabled: false; disposition: 'restore-and-verify' }
	>,
	'actionId' | 'confirmationToken'
>;

function hasManagedOverrides(status: SlimmingSimulatorStatus): boolean {
	return (
		status.managedDisabledCount > 0 ||
		(status.checkpointAvailable &&
			(status.condition === 'unknown' ||
				status.condition === 'needs-attention'))
	);
}

export function managedOverrideUdids(
	statusBySimulator: Readonly<
		Record<string, SlimmingSimulatorStatus | undefined>
	>
): string[] {
	return Object.values(statusBySimulator)
		.filter((status): status is SlimmingSimulatorStatus =>
			Boolean(status && hasManagedOverrides(status))
		)
		.map((status) => status.simulatorUdid)
		.sort((left, right) => left.localeCompare(right));
}

export function allSelectedCheckpointsAvailable(
	selectedUdids: readonly string[],
	statusBySimulator: Readonly<
		Record<string, SlimmingSimulatorStatus | undefined>
	>
): boolean {
	return (
		selectedUdids.length > 0 &&
		selectedUdids.every(
			(udid) => statusBySimulator[udid]?.checkpointAvailable === true
		)
	);
}

/**
 * Whether every selected target shows an interrupted mutation's emergency
 * restore point that needs attention, which is when forgetting it is offered.
 * Main still refuses a target with nothing pending.
 */
export function allSelectedNeedAttention(
	selectedUdids: readonly string[],
	statusBySimulator: Readonly<
		Record<string, SlimmingSimulatorStatus | undefined>
	>
): boolean {
	return (
		selectedUdids.length > 0 &&
		selectedUdids.every((udid) => {
			const status = statusBySimulator[udid];
			return (
				status?.condition === 'needs-attention' &&
				status.checkpointAvailable === true
			);
		})
	);
}

/**
 * The emergency restore points that the selection-based Forget cannot reach:
 * those of Simulators the signed inventory no longer lists and, while the
 * helper is away, every one, since nothing can reconcile or undo them until it
 * is back. Main projects each as needs-attention, so finding them takes no
 * request of their own. Forgetting is all that is offered for them, one at a
 * time, and main still asks before it runs.
 */
export function orphanedRestorePoints(
	state: Pick<SlimmingState, 'helper' | 'simulators' | 'statusBySimulator'>
): SlimmingSimulatorStatus[] {
	// Main matches UDIDs without regard to case, so this must as well, or a
	// listed Simulator could show up here beside the selection's own Forget.
	const listed = new Set(
		state.simulators.map((simulator) => simulator.udid.toUpperCase())
	);
	return Object.values(state.statusBySimulator)
		.filter(
			(status) =>
				status.condition === 'needs-attention' &&
				status.checkpointAvailable &&
				(state.helper.status !== 'available' ||
					!listed.has(status.simulatorUdid.toUpperCase()))
		)
		.sort((left, right) =>
			left.simulatorUdid.localeCompare(right.simulatorUdid)
		);
}

export function unknownCompatibilityBinding(
	statuses: readonly SlimmingSimulatorStatus[]
): string | null {
	const keys = [
		...new Set(
			statuses.flatMap((status) => {
				const compatibility = status.compatibility;
				return compatibility?.status === 'unknown' &&
					compatibility.acknowledgementRequired &&
					!compatibility.acknowledged
					? [compatibility.key]
					: [];
			})
		),
	].sort((left, right) => left.localeCompare(right));
	return keys.length > 0 ? JSON.stringify(keys) : null;
}

export function isExactExperimentalAcknowledgement(value: string): boolean {
	return value === SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT;
}

export function restoreAndDisableInput(
	simulatorUdids: readonly string[],
	unknownTupleBinding: string | null,
	typedAcknowledgement: string
): RestoreAndDisableInput | null {
	if (simulatorUdids.length === 0 || simulatorUdids.length > 20) return null;
	if (
		unknownTupleBinding &&
		!isExactExperimentalAcknowledgement(typedAcknowledgement)
	) {
		return null;
	}
	return {
		enabled: false,
		disposition: 'restore-and-verify',
		simulatorUdids: [...simulatorUdids],
		confirmation: SLIMMING_CONFIRMATIONS.restore,
	};
}
