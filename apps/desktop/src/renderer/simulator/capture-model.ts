import {
	type SimulatorCaptureRetentionPolicy,
	type SimulatorJob,
	simulatorCaptureRetentionPolicySchema,
} from '../../shared/simulator-protocol';

const BYTES_PER_GIBIBYTE = 1024 ** 3;

export type CaptureRetentionFields = {
	maxAgeDays: string;
	maxTotalGiB: string;
};

export function captureRetentionPolicyFromFields(
	fields: CaptureRetentionFields
): SimulatorCaptureRetentionPolicy | null {
	const maxAgeDays = Number(fields.maxAgeDays);
	const maxTotalGiB = Number(fields.maxTotalGiB);
	if (!Number.isInteger(maxAgeDays) || !Number.isFinite(maxTotalGiB))
		return null;
	const result = simulatorCaptureRetentionPolicySchema.safeParse({
		maxAgeDays,
		maxTotalBytes: Math.round(maxTotalGiB * BYTES_PER_GIBIBYTE),
	});
	return result.success ? result.data : null;
}

export function captureRetentionFieldsFromPolicy(
	policy: SimulatorCaptureRetentionPolicy
): CaptureRetentionFields {
	return {
		maxAgeDays: String(policy.maxAgeDays),
		maxTotalGiB: String(
			Number((policy.maxTotalBytes / BYTES_PER_GIBIBYTE).toFixed(2))
		),
	};
}

export function runningRecordingJobForDevice(
	jobs: readonly SimulatorJob[],
	deviceUdid: string | undefined
): SimulatorJob | undefined {
	if (!deviceUdid) return undefined;
	const normalizedUdid = deviceUdid.toUpperCase();
	return jobs.find(
		(job) =>
			job.kind === 'capture.video' &&
			job.status === 'running' &&
			job.deviceUdid?.toUpperCase() === normalizedUdid
	);
}
