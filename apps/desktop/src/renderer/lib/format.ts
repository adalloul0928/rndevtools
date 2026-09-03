import {
	formatBytes,
	formatDuration,
	formatRelativeTime as formatElapsed,
} from '@pumpd/devtools/format';

// Byte and duration rendering is shared with the on-device panels so the same
// value never reads differently on the two surfaces. The local copies also
// lacked the non-finite guards, so a NaN estimate rendered as 'NaN MB' here
// while the device showed an em dash.
export { formatBytes, formatDuration };

// Constructing a DateTimeFormat is expensive and this runs once per visible
// grid cell on every broker broadcast, so the formatter is built once.
const clockFormat = new Intl.DateTimeFormat(undefined, {
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hour12: false,
});

export function formatClock(timestamp: number): string {
	return clockFormat.format(timestamp);
}

/**
 * The elapsed-time arithmetic is shared; only the desktop's ' ago' suffix is
 * local, because the on-device panels render the bare token in tighter rows.
 */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
	const elapsed = formatElapsed(timestamp, now);
	if (elapsed === undefined) return '—';
	return elapsed === 'now' ? elapsed : `${elapsed} ago`;
}

export function formatPercent(value: number | undefined): string {
	return value === undefined ? '—' : `${Math.round(value)}%`;
}

export function truncateMiddle(value: string, max = 56): string {
	if (value.length <= max) return value;
	const side = Math.floor((max - 1) / 2);
	return `${value.slice(0, side)}…${value.slice(-side)}`;
}

export async function copyText(value: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(value);
		return true;
	} catch {
		return false;
	}
}

export function boundedTextExport<T>(
	values: readonly T[],
	format: (value: T) => string,
	maxChars = 2 * 1024 * 1024
): { text: string; truncated: boolean } {
	const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 2 * 1024 * 1024;
	const marker = '\n\n[Export truncated at desktop safety limit.]';
	let text = '';
	for (const value of values) {
		const segment = `${text ? '\n\n' : ''}${format(value)}`;
		if (text.length + segment.length <= limit) {
			text += segment;
			continue;
		}
		const bodyBudget = Math.max(0, limit - text.length - marker.length);
		text += segment.slice(0, bodyBudget);
		text += marker.slice(0, Math.max(0, limit - text.length));
		return { text, truncated: true };
	}
	return { text, truncated: false };
}
