import {
	diagnosticErrorText,
	redactDiagnosticText,
	sanitizeDiagnosticValue,
	sanitizeDiagnosticValueWithMetadata,
} from './redact';

describe('redactDiagnosticText', () => {
	it('redacts quoted JSON credentials and URL-style assignments', () => {
		expect(
			redactDiagnosticText(
				'{"token":"secret-value","user_id":"person-42"} ?api_key=abc&access_token=def&email=person@example.com authorization: Bearer opaque-token',
			),
		).toBe(
			'{"token":"[REDACTED]","user_id":"[REDACTED]"} ?api_key=[REDACTED]&access_token=[REDACTED]&email=[REDACTED] authorization: [REDACTED]',
		);
	});

	it('redacts escaped and unterminated quoted credential values', () => {
		expect(
			redactDiagnosticText(
				'{"password":"first\\"second","token":"unterminated secret',
			),
		).toBe('{"password":"[REDACTED]","token":"[REDACTED]"');
	});

	it('formats hostile thrown values without trusting coercion', () => {
		const coerce = jest.fn(() => 'token=private-coercion');
		const hostile = { toString: coerce };
		expect(diagnosticErrorText(hostile)).toBe('Unknown error');
		expect(coerce).not.toHaveBeenCalled();
		const error = new Error('safe');
		const getter = jest.fn(() => 'unsafe');
		Object.defineProperty(error, 'message', {
			configurable: true,
			get: getter,
		});
		expect(diagnosticErrorText(error)).toBe('Error');
		expect(getter).not.toHaveBeenCalled();
	});

	it('uses intrinsic Date methods instead of instance-owned accessors', () => {
		const value = new Date('2026-08-23T00:00:00.000Z');
		const getTime = jest.fn(() => 0);
		Object.defineProperty(value, 'getTime', { get: getTime });

		expect(sanitizeDiagnosticValue(value)).toBe('2026-08-23T00:00:00.000Z');
		expect(getTime).not.toHaveBeenCalled();
	});
});

describe('sanitizeDiagnosticValue', () => {
	it('redacts sensitive fields without invoking accessors', () => {
		const value = {
			accessToken: 'private-token',
			get dangerous() {
				throw new Error('getter must not run');
			},
			nested: { email: 'person@example.com', public: 'visible' },
		};

		const sanitized = sanitizeDiagnosticValue(value);
		const serialized = JSON.stringify(sanitized);

		expect(serialized).toContain('[REDACTED]');
		expect(serialized).toContain('[Accessor omitted]');
		expect(serialized).toContain('visible');
		expect(serialized).not.toContain('private-token');
		expect(serialized).not.toContain('person@example.com');
	});

	it('treats prototype-shaped keys as ordinary detached data', () => {
		const value = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(value, '__proto__', {
			configurable: true,
			enumerable: true,
			value: { polluted: true },
			writable: true,
		});

		const sanitized = sanitizeDiagnosticValue(value) as Record<string, unknown>;

		expect(Object.getPrototypeOf(sanitized)).toBeNull();
		expect(Object.hasOwn(sanitized, '__proto__')).toBe(true);
		expect(JSON.stringify(sanitized)).toContain('polluted');
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
	});

	it('reports structural omissions', () => {
		const sanitized = sanitizeDiagnosticValueWithMetadata(
			Array.from({ length: 101 }, (_, index) => index),
		);

		expect(sanitized.truncated).toBe(true);
		expect(sanitized.value).toHaveLength(100);
	});

	it('reports whether a projection was redacted', () => {
		expect(
			sanitizeDiagnosticValueWithMetadata({ count: 1, ready: true }).redacted,
		).toBe(false);
		expect(
			sanitizeDiagnosticValueWithMetadata({ token: 'private-token' }).redacted,
		).toBe(true);
		expect(
			sanitizeDiagnosticValueWithMetadata('email=user@example.com').redacted,
		).toBe(true);
	});

	it('does not invoke array accessors or include non-enumerable fields', () => {
		const array: unknown[] = [];
		Object.defineProperty(array, '0', {
			enumerable: true,
			get() {
				throw new Error('array getter must not run');
			},
		});
		array.length = 1;
		const object = { visible: true } as Record<string, unknown>;
		Object.defineProperty(object, 'hidden', {
			enumerable: false,
			value: 'private implementation detail',
		});

		expect(sanitizeDiagnosticValue(array)).toEqual(['[Accessor omitted]']);
		expect(JSON.stringify(sanitizeDiagnosticValue(object))).toBe(
			'{"visible":true}',
		);
	});

	it('projects Map and Set contents instead of empty objects', () => {
		// Neither exposes entries as own properties, and the app rehydrates real
		// state (pinned notes) into a Map, so a descriptor walk shows nothing.
		expect(
			sanitizeDiagnosticValue(
				new Map([
					['first', 1],
					['second', 2],
				]),
			),
		).toEqual({
			type: 'Map',
			size: 2,
			entries: [
				['first', 1],
				['second', 2],
			],
		});
		expect(sanitizeDiagnosticValue(new Set(['a', 'b']))).toEqual({
			type: 'Set',
			size: 2,
			entries: ['a', 'b'],
		});
	});

	it('redacts credential-shaped values inside a Map', () => {
		expect(
			JSON.stringify(
				sanitizeDiagnosticValue(new Map([['session', 'user@example.com']])),
			),
		).toContain('[REDACTED EMAIL]');
	});

	it('reports a value referenced twice in one tree without calling it a cycle', () => {
		const shared = { id: 'exercise-1', reps: 8 };
		const projection = sanitizeDiagnosticValueWithMetadata({
			current: shared,
			exercises: [shared],
		});
		const serialized = JSON.stringify(projection.value);
		expect(serialized).not.toContain('[Circular]');
		expect(projection.truncated).toBe(false);
	});

	it('marks cycles and depth limits without throwing', () => {
		const cyclic: Record<string, unknown> = { name: 'root' };
		cyclic.self = cyclic;
		expect(JSON.stringify(sanitizeDiagnosticValue(cyclic))).toContain(
			'[Circular]',
		);

		let deep: Record<string, unknown> = { leaf: true };
		for (let level = 0; level < 12; level += 1) deep = { deep };
		const projection = sanitizeDiagnosticValueWithMetadata(deep);
		expect(JSON.stringify(projection.value)).toContain('[Depth limit]');
		expect(projection.truncated).toBe(true);
	});

	it('maps non-JSON primitives to stable placeholders', () => {
		expect(
			sanitizeDiagnosticValue({
				big: 10n,
				missing: undefined,
				run: () => true,
				when: new Date(0),
				broken: new Date(Number.NaN),
			}),
		).toEqual({
			big: '10n',
			missing: '[Undefined]',
			run: '[Function]',
			when: '1970-01-01T00:00:00.000Z',
			broken: '[Invalid Date]',
		});
	});

	it('redacts bare bearer tokens and JWTs outside assignments', () => {
		expect(redactDiagnosticText('Bearer abc.def-ghi')).toBe(
			'Bearer [REDACTED]',
		);
		expect(
			redactDiagnosticText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln'),
		).toBe('[REDACTED JWT]');
	});

	it('treats mixed-case and separator-laden key names as sensitive', () => {
		for (const key of ['AccessToken', 'X-API-KEY', 'user_id', 'Set-Cookie']) {
			expect(sanitizeDiagnosticValue({ [key]: 'value' })).toEqual({
				[key]: '[REDACTED]',
			});
		}
	});

	it('redacts an error stack that carries personal data', () => {
		const error = new Error('failed for user@example.com');
		const projected = sanitizeDiagnosticValue(error) as { message: string };
		expect(projected.message).toBe('failed for [REDACTED EMAIL]');
	});
});
