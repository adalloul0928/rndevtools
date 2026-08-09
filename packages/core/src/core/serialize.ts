export type SerializedValue = {
	text: string;
	truncated: boolean;
	estimatedBytes: number;
};

const CIRCULAR_VALUE = '[Circular]';

export function utf8ByteLength(text: string): number {
	if (typeof TextEncoder !== 'undefined') {
		return new TextEncoder().encode(text).byteLength;
	}
	let bytes = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

function truncateUtf8(text: string, maxBytes: number): SerializedValue {
	const budget = Number.isFinite(maxBytes)
		? Math.max(0, Math.floor(maxBytes))
		: 0;
	const fullBytes = utf8ByteLength(text);
	if (fullBytes <= budget) {
		return { text, truncated: false, estimatedBytes: fullBytes };
	}
	const ellipsis = '…';
	const ellipsisBytes = utf8ByteLength(ellipsis);
	if (budget < ellipsisBytes) {
		return { text: '', truncated: true, estimatedBytes: 0 };
	}
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const prefix = text.slice(0, middle);
		if (utf8ByteLength(prefix) + ellipsisBytes <= budget) low = middle;
		else high = middle - 1;
	}
	if (
		low > 0 &&
		text.charCodeAt(low - 1) >= 0xd800 &&
		text.charCodeAt(low - 1) <= 0xdbff
	) {
		low -= 1;
	}
	const truncatedText = `${text.slice(0, low)}${ellipsis}`;
	return {
		text: truncatedText,
		truncated: true,
		estimatedBytes: utf8ByteLength(truncatedText),
	};
}

function stringify(value: unknown): string {
	const seen = new WeakSet<object>();
	const result = JSON.stringify(
		value,
		(_key, nestedValue: unknown) => {
			if (typeof nestedValue === 'bigint') return `${nestedValue.toString()}n`;
			if (nestedValue instanceof Error) {
				return {
					name: nestedValue.name,
					message: nestedValue.message,
					stack: nestedValue.stack,
				};
			}
			if (typeof nestedValue === 'object' && nestedValue !== null) {
				if (seen.has(nestedValue)) return CIRCULAR_VALUE;
				seen.add(nestedValue);
			}
			return nestedValue;
		},
		2,
	);

	return result ?? String(value);
}

export function serializeValue(
	value: unknown,
	maxBytes = 64 * 1024,
): SerializedValue {
	let text: string;
	try {
		text = stringify(value);
	} catch (error) {
		text = error instanceof Error ? error.message : String(error);
	}

	return truncateUtf8(text, maxBytes);
}

export function truncateText(
	text: string,
	maxBytes = 64 * 1024,
): SerializedValue {
	return truncateUtf8(text, maxBytes);
}
