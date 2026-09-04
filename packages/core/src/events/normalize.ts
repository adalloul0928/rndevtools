import { isSensitiveDiagnosticKey, redactDiagnosticText } from '../core/redact';
import { truncateText } from '../core/serialize';
import type {
	DevtoolsEventAttribute,
	DevtoolsEventInput,
	DevtoolsEventLevel,
	DevtoolsEventResourceRef,
} from './types';

const LEVELS = new Set<DevtoolsEventLevel>(['debug', 'info', 'warn', 'error']);
const MAX_IDENTIFIER_BYTES = 512;
const MAX_TITLE_BYTES = 4 * 1024;
const MAX_SUMMARY_BYTES = 16 * 1024;
const MAX_ATTRIBUTE_COUNT = 64;
const MAX_ATTRIBUTE_KEY_BYTES = 512;
const MAX_ATTRIBUTE_VALUE_BYTES = 4 * 1024;
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;
const INPUT_FIELDS = new Set([
	'at',
	'attributes',
	'correlationId',
	'kind',
	'level',
	'parentEventId',
	'resourceRef',
	'source',
	'summary',
	'title',
]);

type NormalizationState = {
	redacted: boolean;
	truncated: boolean;
};

export type NormalizedDevtoolsEventInput = Readonly<{
	at: number;
	source: string;
	kind: string;
	level: DevtoolsEventLevel;
	title: string;
	summary?: string;
	correlationId?: string;
	parentEventId?: string;
	resourceRef?: DevtoolsEventResourceRef;
	attributes?: Readonly<Record<string, DevtoolsEventAttribute>>;
	redacted: boolean;
	truncated: boolean;
}>;

function dataProperties(
	value: unknown,
): Record<string, PropertyDescriptor> | null {
	if (value === null || typeof value !== 'object') return null;
	try {
		return Object.getOwnPropertyDescriptors(value);
	} catch {
		return null;
	}
}

function dataValue(
	descriptors: Record<string, PropertyDescriptor>,
	key: string,
): unknown {
	const descriptor = descriptors[key];
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function safeText(
	value: unknown,
	maxBytes: number,
	state: NormalizationState,
	trim = false,
): string | undefined {
	if (typeof value !== 'string') return undefined;
	const redacted = redactDiagnosticText(value);
	if (redacted !== value) state.redacted = true;
	const normalized = trim ? redacted.trim() : redacted;
	const bounded = truncateText(normalized, maxBytes);
	if (bounded.truncated) state.truncated = true;
	return bounded.text;
}

function isValidTimestamp(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= MAX_DATE_TIMESTAMP
	);
}

function normalizeResourceRef(
	value: unknown,
	state: NormalizationState,
): DevtoolsEventResourceRef | undefined {
	if (value === undefined) return undefined;
	const descriptors = dataProperties(value);
	if (!descriptors) {
		state.truncated = true;
		return undefined;
	}
	if (
		Object.entries(descriptors).some(
			([key, descriptor]) =>
				descriptor.enumerable && key !== 'toolId' && key !== 'resourceId',
		)
	) {
		state.truncated = true;
	}
	const toolId = safeText(
		dataValue(descriptors, 'toolId'),
		MAX_IDENTIFIER_BYTES,
		state,
		true,
	);
	const resourceId = safeText(
		dataValue(descriptors, 'resourceId'),
		MAX_IDENTIFIER_BYTES,
		state,
		true,
	);
	if (!toolId || !resourceId) {
		state.truncated = true;
		return undefined;
	}
	return Object.freeze({ toolId, resourceId });
}

function normalizeAttributes(
	value: unknown,
	state: NormalizationState,
): Readonly<Record<string, DevtoolsEventAttribute>> | undefined {
	if (value === undefined) return undefined;
	const descriptors = dataProperties(value);
	if (!descriptors || Array.isArray(value)) {
		state.truncated = true;
		return undefined;
	}
	const entries = Object.entries(descriptors)
		.filter(([, descriptor]) => descriptor.enumerable)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	if (entries.length > MAX_ATTRIBUTE_COUNT) state.truncated = true;
	const output = Object.create(null) as Record<string, DevtoolsEventAttribute>;
	for (const [rawKey, descriptor] of entries.slice(0, MAX_ATTRIBUTE_COUNT)) {
		const key = safeText(rawKey, MAX_ATTRIBUTE_KEY_BYTES, state, true);
		if (!key || Object.hasOwn(output, key)) {
			state.truncated = true;
			continue;
		}
		if (isSensitiveDiagnosticKey(key)) {
			state.redacted = true;
			output[key] = '[REDACTED]';
			continue;
		}
		if (!('value' in descriptor)) {
			state.truncated = true;
			continue;
		}
		const rawValue = descriptor.value;
		if (typeof rawValue === 'string') {
			output[key] = safeText(rawValue, MAX_ATTRIBUTE_VALUE_BYTES, state) ?? '';
		} else if (typeof rawValue === 'boolean') {
			output[key] = rawValue;
		} else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
			output[key] = rawValue;
		} else {
			// Nested data belongs to the owning collector and is represented by a
			// resource reference, never copied into the unified event envelope.
			state.truncated = true;
		}
	}
	return Object.keys(output).length > 0 ? Object.freeze(output) : undefined;
}

export function normalizeDevtoolsEventInput(
	input: DevtoolsEventInput,
	now: () => number,
): NormalizedDevtoolsEventInput | null {
	const descriptors = dataProperties(input);
	if (!descriptors) return null;
	const state: NormalizationState = { redacted: false, truncated: false };
	if (
		Object.entries(descriptors).some(
			([key, descriptor]) => descriptor.enumerable && !INPUT_FIELDS.has(key),
		)
	) {
		state.truncated = true;
	}
	const source = safeText(
		dataValue(descriptors, 'source'),
		MAX_IDENTIFIER_BYTES,
		state,
		true,
	);
	const kind = safeText(
		dataValue(descriptors, 'kind'),
		MAX_IDENTIFIER_BYTES,
		state,
		true,
	);
	const title = safeText(
		dataValue(descriptors, 'title'),
		MAX_TITLE_BYTES,
		state,
		true,
	);
	if (!source || !kind || !title) return null;

	const rawLevel = dataValue(descriptors, 'level');
	const level = rawLevel === undefined ? 'info' : rawLevel;
	if (typeof level !== 'string' || !LEVELS.has(level as DevtoolsEventLevel)) {
		return null;
	}
	const rawTimestamp = dataValue(descriptors, 'at');
	const candidateTimestamp = rawTimestamp === undefined ? now() : rawTimestamp;
	let at: number;
	if (isValidTimestamp(candidateTimestamp)) {
		at = candidateTimestamp;
	} else {
		const fallbackTimestamp = now();
		if (!isValidTimestamp(fallbackTimestamp)) return null;
		at = fallbackTimestamp;
		state.truncated = true;
	}

	const summaryValue = dataValue(descriptors, 'summary');
	const summary = safeText(summaryValue, MAX_SUMMARY_BYTES, state);
	if (summaryValue !== undefined && summary === undefined)
		state.truncated = true;
	const correlationValue = dataValue(descriptors, 'correlationId');
	const correlationId = safeText(
		correlationValue,
		MAX_IDENTIFIER_BYTES,
		state,
		true,
	);
	if (correlationValue !== undefined && !correlationId) state.truncated = true;
	const parentValue = dataValue(descriptors, 'parentEventId');
	const parentEventId = safeText(
		parentValue,
		MAX_IDENTIFIER_BYTES,
		state,
		true,
	);
	if (parentValue !== undefined && !parentEventId) state.truncated = true;
	const resourceRef = normalizeResourceRef(
		dataValue(descriptors, 'resourceRef'),
		state,
	);
	const attributes = normalizeAttributes(
		dataValue(descriptors, 'attributes'),
		state,
	);

	return {
		at,
		source,
		kind,
		level: level as DevtoolsEventLevel,
		title,
		...(summary ? { summary } : {}),
		...(correlationId ? { correlationId } : {}),
		...(parentEventId ? { parentEventId } : {}),
		...(resourceRef ? { resourceRef } : {}),
		...(attributes ? { attributes } : {}),
		redacted: state.redacted,
		truncated: state.truncated,
	};
}
