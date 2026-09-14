import { diagnosticErrorText } from '@pumpd/devtools/redact';
import { truncateText } from '@pumpd/devtools/serialize';
import type { RawData } from 'ws';
import { type DeviceMessage, deviceMessageSchema } from '../shared/protocol';

const MAX_BOUNDARY_ERROR_BYTES = 8 * 1024;

/** Convert every ws raw-frame representation into the same validated message. */
export function parseBrokerDeviceMessage(raw: RawData): DeviceMessage {
	const text = Array.isArray(raw)
		? Buffer.concat(raw).toString('utf8')
		: raw instanceof ArrayBuffer
			? Buffer.from(raw).toString('utf8')
			: raw.toString('utf8');
	return deviceMessageSchema.parse(JSON.parse(text));
}

/** Charge fragmented frames by their complete wire size before parsing. */
export function brokerRawDataByteLength(raw: RawData): number {
	return Array.isArray(raw)
		? raw.reduce((total, chunk) => total + chunk.byteLength, 0)
		: raw.byteLength;
}

/** Bound and redact errors before they cross the broker observability boundary. */
export function safeBrokerErrorText(error: unknown): string {
	return truncateText(diagnosticErrorText(error), MAX_BOUNDARY_ERROR_BYTES)
		.text;
}
