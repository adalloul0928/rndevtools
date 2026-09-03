import { diagnosticErrorText, sanitizeDiagnosticValue } from './redact';

export type SerializedValue = {
	text: string;
	truncated: boolean;
	estimatedBytes: number;
};

const CIRCULAR_VALUE = '[Circular]';

function utf8CodePointBytes(text: string, index: number): [number, number] {
	const code = text.charCodeAt(index);
	if (code < 0x80) return [1, 1];
	if (code < 0x800) return [2, 1];
	if (code >= 0xd800 && code <= 0xdbff) {
		const next = text.charCodeAt(index + 1);
		if (next >= 0xdc00 && next <= 0xdfff) return [4, 2];
	}
	return [3, 1];
}

export function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (let index = 0; index < text.length; ) {
		const [codePointBytes, codeUnits] = utf8CodePointBytes(text, index);
		bytes += codePointBytes;
		index += codeUnits;
	}
	return bytes;
}

function truncateUtf8(text: string, maxBytes: number): SerializedValue {
	const budget = Number.isFinite(maxBytes)
		? Math.max(0, Math.floor(maxBytes))
		: maxBytes === Number.POSITIVE_INFINITY
			? Number.MAX_SAFE_INTEGER
			: 0;
	const ellipsis = '…';
	const ellipsisBytes = utf8ByteLength(ellipsis);
	let bytes = 0;
	let prefixEnd = 0;
	let prefixBytes = 0;
	for (let index = 0; index < text.length; ) {
		const [codePointBytes, codeUnits] = utf8CodePointBytes(text, index);
		bytes += codePointBytes;
		index += codeUnits;
		if (bytes + ellipsisBytes <= budget) {
			prefixEnd = index;
			prefixBytes = bytes;
		}
		if (bytes > budget) {
			if (budget < ellipsisBytes) {
				return { text: '', truncated: true, estimatedBytes: 0 };
			}
			return {
				text: `${text.slice(0, prefixEnd)}${ellipsis}`,
				truncated: true,
				estimatedBytes: prefixBytes + ellipsisBytes,
			};
		}
	}
	return { text, truncated: false, estimatedBytes: bytes };
}

function stringify(value: unknown): string {
	const result = JSON.stringify(sanitizeDiagnosticValue(value), null, 2);

	return result ?? CIRCULAR_VALUE;
}

export function serializeValue(
	value: unknown,
	maxBytes = 64 * 1024,
): SerializedValue {
	let text: string;
	try {
		text = stringify(value);
	} catch (error) {
		text = diagnosticErrorText(error);
	}

	return truncateUtf8(text, maxBytes);
}

export function truncateText(
	text: string,
	maxBytes = 64 * 1024,
): SerializedValue {
	return truncateUtf8(text, maxBytes);
}
