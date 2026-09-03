const SENSITIVE_KEY =
	/(?:authorization|cookie|csrf|jwt|token|secret|password|passcode|session|api[-_]?key|email|phone|user[-_]?id)/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER = /\bBearer\s+[A-Za-z\d._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z\d_-]+\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+\b/g;
const SENSITIVE_NAME =
	'(?:authorization|cookie|csrf|jwt|(?:access|refresh|id)[-_]?token|token|client[-_]?secret|secret|password|passcode|session(?:[-_]?id)?|api[-_]?key|email|phone|user[-_]?id)';
const DOUBLE_QUOTED_SECRET_ASSIGNMENT = new RegExp(
	`(["']?${SENSITIVE_NAME}["']?\\s*[=:]\\s*)"(?:\\\\.|[^"\\\\])*(?:"|$)`,
	'gi',
);
const SINGLE_QUOTED_SECRET_ASSIGNMENT = new RegExp(
	`(["']?${SENSITIVE_NAME}["']?\\s*[=:]\\s*)'(?:\\\\.|[^'\\\\])*(?:'|$)`,
	'gi',
);
const UNQUOTED_SECRET_ASSIGNMENT = new RegExp(
	`(["']?${SENSITIVE_NAME}["']?\\s*[=:]\\s*)(?!["'])(?:Bearer\\s+[A-Za-z\\d._~+/=-]+|[^&,}\\s]+)`,
	'gi',
);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 100;

function normalizedKey(value: string): string {
	return value.replace(/[^a-z\d]/gi, '').toLowerCase();
}

export function isSensitiveDiagnosticKey(value: string): boolean {
	return SENSITIVE_KEY.test(value) || SENSITIVE_KEY.test(normalizedKey(value));
}

export function redactDiagnosticText(value: string): string {
	return value
		.replace(DOUBLE_QUOTED_SECRET_ASSIGNMENT, '$1"[REDACTED]"')
		.replace(SINGLE_QUOTED_SECRET_ASSIGNMENT, "$1'[REDACTED]'")
		.replace(UNQUOTED_SECRET_ASSIGNMENT, '$1[REDACTED]')
		.replace(BEARER, 'Bearer [REDACTED]')
		.replace(JWT, '[REDACTED JWT]')
		.replace(EMAIL, '[REDACTED EMAIL]');
}

/** Converts arbitrary thrown values into redacted text without trusting coercion. */
export function diagnosticErrorText(error: unknown): string {
	let message = 'Unknown error';
	try {
		if (typeof error === 'string') {
			message = error;
		} else if (
			typeof error === 'number' ||
			typeof error === 'boolean' ||
			typeof error === 'bigint' ||
			typeof error === 'symbol'
		) {
			message = String(error);
		} else if (
			error !== null &&
			(typeof error === 'object' || typeof error === 'function')
		) {
			const isError = error instanceof Error;
			const descriptors = Object.getOwnPropertyDescriptors(error);
			const messageDescriptor = descriptors.message;
			const nameDescriptor = descriptors.name;
			if (
				messageDescriptor &&
				'value' in messageDescriptor &&
				typeof messageDescriptor.value === 'string' &&
				messageDescriptor.value
			) {
				message = messageDescriptor.value;
			} else if (
				nameDescriptor &&
				'value' in nameDescriptor &&
				typeof nameDescriptor.value === 'string' &&
				nameDescriptor.value
			) {
				message = nameDescriptor.value;
			} else if (isError) {
				message = 'Error';
			}
		}
	} catch {
		// Proxies can reject descriptor inspection; never fall back to coercion.
	}
	return redactDiagnosticText(message);
}

export type DiagnosticSanitization = {
	value: unknown;
	truncated: boolean;
	redacted: boolean;
};

/**
 * Produces a detached JSON-compatible diagnostic projection. Accessors are
 * never invoked, cycles are labeled, and credential/PII-shaped fields are
 * removed before a caller serializes or stores the result.
 */
export function sanitizeDiagnosticValueWithMetadata(
	value: unknown,
): DiagnosticSanitization {
	const seen = new WeakSet<object>();
	let truncated = false;
	let redacted = false;

	const redactText = (text: string): string => {
		const output = redactDiagnosticText(text);
		if (output !== text) redacted = true;
		return output;
	};

	const visit = (current: unknown, depth: number): unknown => {
		if (typeof current === 'string') return redactText(current);
		if (
			current === null ||
			typeof current === 'boolean' ||
			typeof current === 'number'
		) {
			return current;
		}
		if (typeof current === 'bigint') return `${current}n`;
		if (typeof current === 'undefined') return '[Undefined]';
		if (typeof current === 'function') return '[Function]';
		if (typeof current === 'symbol') return String(current);
		if (depth >= MAX_DEPTH) {
			truncated = true;
			return '[Depth limit]';
		}
		if (typeof current !== 'object') return String(current);
		try {
			if (current instanceof Date) {
				const timestamp = Date.prototype.getTime.call(current);
				return Number.isFinite(timestamp)
					? Date.prototype.toISOString.call(current)
					: '[Invalid Date]';
			}
			if (current instanceof Map || current instanceof Set) {
				// Neither exposes entries as own properties, so the descriptor walk
				// below would render every Map/Set as an empty object.
				const entries =
					current instanceof Map
						? [...Map.prototype.entries.call(current)]
						: [...Set.prototype.values.call(current)];
				if (entries.length > MAX_ENTRIES) truncated = true;
				return {
					type: current instanceof Map ? 'Map' : 'Set',
					size: entries.length,
					entries: entries
						.slice(0, MAX_ENTRIES)
						.map((entry) => visit(entry, depth + 1)),
				};
			}
			if (current instanceof Error) {
				const descriptors = Object.getOwnPropertyDescriptors(current);
				const dataText = (key: 'name' | 'message' | 'stack') => {
					const descriptor = descriptors[key];
					return descriptor &&
						'value' in descriptor &&
						typeof descriptor.value === 'string'
						? redactText(descriptor.value)
						: undefined;
				};
				return {
					name: dataText('name') ?? 'Error',
					message: dataText('message') ?? '[Error message unavailable]',
					stack: dataText('stack'),
				};
			}
		} catch {
			truncated = true;
			return '[Unreadable object]';
		}
		if (seen.has(current)) {
			truncated = true;
			return '[Circular]';
		}
		seen.add(current);
		try {
			return visitObject(current, depth);
		} finally {
			// `seen` tracks the ancestor path, not every object ever visited.
			// Leaving entries behind would report a value referenced twice in the
			// same tree — a diamond, not a cycle — as '[Circular]' and would raise
			// a spurious truncation flag on an otherwise complete snapshot.
			seen.delete(current);
		}
	};

	const visitObject = (current: object, depth: number): unknown => {
		let descriptors: Record<string, PropertyDescriptor>;
		try {
			descriptors = Object.getOwnPropertyDescriptors(current);
		} catch {
			truncated = true;
			return '[Unreadable object]';
		}
		if (Array.isArray(current)) {
			const lengthDescriptor = descriptors.length;
			const length =
				lengthDescriptor &&
				'value' in lengthDescriptor &&
				typeof lengthDescriptor.value === 'number'
					? lengthDescriptor.value
					: 0;
			if (length > MAX_ENTRIES) truncated = true;
			return Array.from(
				{ length: Math.min(length, MAX_ENTRIES) },
				(_unused, index) => {
					const descriptor = descriptors[String(index)];
					if (!descriptor) return '[Empty]';
					if (!('value' in descriptor)) {
						truncated = true;
						return '[Accessor omitted]';
					}
					return visit(descriptor.value, depth + 1);
				},
			);
		}
		const output = Object.create(null) as Record<string, unknown>;
		const entries = Object.entries(descriptors).filter(
			([, descriptor]) => descriptor.enumerable,
		);
		if (entries.length > MAX_ENTRIES) truncated = true;
		for (const [key, descriptor] of entries.slice(0, MAX_ENTRIES)) {
			if (isSensitiveDiagnosticKey(key)) {
				redacted = true;
				output[key] = '[REDACTED]';
			} else if ('value' in descriptor) {
				output[key] = visit(descriptor.value, depth + 1);
			} else {
				truncated = true;
				output[key] = '[Accessor omitted]';
			}
		}
		return output;
	};

	return { value: visit(value, 0), truncated, redacted };
}

export function sanitizeDiagnosticValue(value: unknown): unknown {
	return sanitizeDiagnosticValueWithMetadata(value).value;
}
