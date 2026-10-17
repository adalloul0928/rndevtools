import {
	diagnosticErrorText,
	isSensitiveDiagnosticKey,
	redactDiagnosticText,
	sanitizeDiagnosticValue,
	sanitizeDiagnosticValueWithMetadata,
} from './redact';

function base64Url(value: unknown): string {
	return btoa(JSON.stringify(value))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/** Builds token-shaped fixtures at runtime so no key literal sits in source. */
function jwt(payload: Record<string, unknown>, signature = 'c2lnbmF0dXJl') {
	return `${base64Url({ alg: 'HS256', typ: 'JWT' })}.${base64Url(payload)}.${signature}`;
}

const STACK_ID =
	'64616c83912c48442ec266f86ee2d7f004d2be5c8b7f31a6d6b4c2634f82145f';

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

describe('redactDiagnosticText backend credentials', () => {
	it('redacts compound secret names in env, JSON, and YAML assignments', () => {
		expect(redactDiagnosticText('SECRET_KEY=sb_secret_x')).toBe(
			'SECRET_KEY=[REDACTED]',
		);
		expect(redactDiagnosticText('{"SECRET_KEY":"sb_secret_x"}')).toBe(
			'{"SECRET_KEY":"[REDACTED]"}',
		);
		expect(redactDiagnosticText('SECRET_KEY: sb_secret_x')).toBe(
			'SECRET_KEY: [REDACTED]',
		);
		expect(
			redactDiagnosticText(`SERVICE_ROLE_KEY=${jwt({ role: 'service_role' })}`),
		).toBe('SERVICE_ROLE_KEY=[REDACTED]');
		expect(
			redactDiagnosticText(
				`{"serviceRoleKey":"${jwt({ role: 'service_role' })}"}`,
			),
		).toBe('{"serviceRoleKey":"[REDACTED]"}');
		expect(redactDiagnosticText(`ROOT_KEY=${'0a'.repeat(32)}`)).toBe(
			'ROOT_KEY=[REDACTED]',
		);
		expect(
			redactDiagnosticText(
				'DB_URL=postgresql://postgres:pw@127.0.0.1:54322/postgres',
			),
		).toBe('DB_URL=[REDACTED]');
	});

	it('redacts secrets whose sensitive word is followed by more of the name', () => {
		const text = [
			'SUPABASE_AUTH_SECRET_KEY=one',
			'JWT_SECRET=two',
			'S3_PROTOCOL_ACCESS_KEY_SECRET=three',
			'AWS_SECRET_ACCESS_KEY=four',
			'secret_access_key = "five"',
			'SUPABASE_DB_ROOT_KEY=six',
		].join('\n');
		expect(redactDiagnosticText(text)).toBe(
			[
				'SUPABASE_AUTH_SECRET_KEY=[REDACTED]',
				'JWT_SECRET=[REDACTED]',
				'S3_PROTOCOL_ACCESS_KEY_SECRET=[REDACTED]',
				'AWS_SECRET_ACCESS_KEY=[REDACTED]',
				'secret_access_key = "[REDACTED]"',
				'SUPABASE_DB_ROOT_KEY=[REDACTED]',
			].join('\n'),
		);
	});

	it('redacts bare secret API keys under any name or encoding', () => {
		expect(redactDiagnosticText('using sb_secret_x for admin')).toBe(
			'using [REDACTED SECRET KEY] for admin',
		);
		expect(redactDiagnosticText('{"key":"sb_secret_abc-DEF_123"}')).toBe(
			'{"key":"[REDACTED SECRET KEY]"}',
		);
		expect(redactDiagnosticText('apikey%3Dsb_secret_x%26next')).toBe(
			'apikey%3D[REDACTED SECRET KEY]%26next',
		);
	});

	it('redacts URL passwords but keeps the user and the address', () => {
		expect(
			redactDiagnosticText('postgresql://postgres:pw@127.0.0.1:1/postgres'),
		).toBe('postgresql://postgres:[REDACTED]@127.0.0.1:1/postgres');
		expect(
			redactDiagnosticText('postgres://admin:p@ss:w0rd@10.0.0.5:5432/app'),
		).toBe('postgres://admin:[REDACTED]@10.0.0.5:5432/app');
		expect(redactDiagnosticText('redis://:pw@127.0.0.1:6379')).toBe(
			'redis://:[REDACTED]@127.0.0.1:6379',
		);
		expect(redactDiagnosticText('connect //svc:pw@[::1]:5432/db')).toBe(
			'connect //svc:[REDACTED]@[::1]:5432/db',
		);
	});

	it('stops a URL password at the end of its quoted value', () => {
		expect(
			redactDiagnosticText(
				'{"url":"postgres://u:pw@127.0.0.1/db","note":"ping person@example.com"}',
			),
		).toBe(
			'{"url":"postgres://u:[REDACTED]@127.0.0.1/db","note":"ping [REDACTED EMAIL]"}',
		);
	});

	it('leaves URL passwords that another layer already redacted', () => {
		for (const text of [
			'https://%5BREDACTED%5D:%5BREDACTED%5D@127.0.0.1/a',
			'https://user:%5bredacted%5d@127.0.0.1/a',
			'postgres://u:[REDACTED]@127.0.0.1/db',
		]) {
			expect(redactDiagnosticText(text)).toBe(text);
		}
	});

	it('redacts the upstream credential query parameters', () => {
		expect(
			redactDiagnosticText(
				'https://example.com/callback?code=pkce-code&state=kept#access_token=a&refresh_token=b&provider_token=c&provider_refresh_token=d&expires_in=3600',
			),
		).toBe(
			'https://example.com/callback?code=[REDACTED]&state=kept#access_token=[REDACTED]&refresh_token=[REDACTED]&provider_token=[REDACTED]&provider_refresh_token=[REDACTED]&expires_in=3600',
		);
		expect(
			redactDiagnosticText(
				'/auth/v1/verify?token_hash=hash&type=email&apikey=k&jwt=j&id_token=i&token=t',
			),
		).toBe(
			'/auth/v1/verify?token_hash=[REDACTED]&type=email&apikey=[REDACTED]&jwt=[REDACTED]&id_token=[REDACTED]&token=[REDACTED]',
		);
		expect(
			redactDiagnosticText(
				'/storage/v1/s3/b/o?X-Amz-Credential=id%2Fscope&X-Amz-Signature=sig&X-Amz-Security-Token=st&X-Amz-Expires=60',
			),
		).toBe(
			'/storage/v1/s3/b/o?X-Amz-Credential=[REDACTED]&X-Amz-Signature=[REDACTED]&X-Amz-Security-Token=[REDACTED]&X-Amz-Expires=60',
		);
	});

	it('redacts JWTs that carry no signature', () => {
		expect(redactDiagnosticText(`token ${jwt({ sub: '1' }, '')} end`)).toBe(
			'token [REDACTED JWT] end',
		);
	});

	it('is stable when callers redact text that was already redacted', () => {
		const once = redactDiagnosticText(
			`SECRET_KEY=sb_secret_x key sb_secret_y ${jwt({ role: 'anon' })} postgresql://postgres:pw@127.0.0.1:1/postgres?code=abc`,
		);
		expect(once).toBe(
			'SECRET_KEY=[REDACTED] key [REDACTED SECRET KEY] [REDACTED JWT] postgresql://postgres:[REDACTED]@127.0.0.1:1/postgres?code=[REDACTED]',
		);
		expect(redactDiagnosticText(once)).toBe(once);
	});

	it('keeps stack ids, publishable keys, and non-credential codes', () => {
		const kept = [
			`stack ${STACK_ID} started`,
			`--stack-id ${STACK_ID}`,
			`{"id":"${STACK_ID}"}`,
			'PUBLISHABLE_KEY=sb_publishable_x',
			'{"publishable_key":"sb_publishable_x"}',
			'keys starting with sb_secret_ are refused',
			'exit code=1',
			'{"code":"PGRST116","message":"no rows"}',
			'error_code=42',
			'postgres://postgres@127.0.0.1:54322/postgres',
			'http://127.0.0.1:54321/rest/v1',
		];
		for (const text of kept) expect(redactDiagnosticText(text)).toBe(text);
	});
});

describe('isSensitiveDiagnosticKey backend names', () => {
	it('flags secret-bearing names whose values have no recognizable shape', () => {
		for (const key of [
			'SERVICE_ROLE_KEY',
			'serviceRoleKey',
			'ROOT_KEY',
			'rootKey',
			'DB_URL',
			'dbUrl',
			'X-Amz-Signature',
			'X-Amz-Credential',
		]) {
			expect(isSensitiveDiagnosticKey(key)).toBe(true);
		}
	});

	it('keeps public names readable', () => {
		for (const key of ['PUBLISHABLE_KEY', 'ANON_KEY', 'API_URL', 'stackId']) {
			expect(isSensitiveDiagnosticKey(key)).toBe(false);
		}
	});

	it('projects a stack env map without its secrets', () => {
		const serialized = JSON.stringify(
			sanitizeDiagnosticValue({
				env: {
					API_URL: 'http://127.0.0.1:54321',
					DB_URL: 'postgresql://postgres:pw@127.0.0.1:54322/postgres',
					PUBLISHABLE_KEY: 'sb_publishable_x',
					ROOT_KEY: '0a'.repeat(32),
					SECRET_KEY: 'sb_secret_x',
					SERVICE_ROLE_KEY: jwt({ role: 'service_role' }),
				},
				endpoint: 'postgresql://postgres:pw@127.0.0.1:54322/postgres',
				id: STACK_ID,
			}),
		);
		expect(serialized).not.toContain('sb_secret_');
		expect(serialized).not.toContain('eyJ');
		expect(serialized).not.toContain(':pw@');
		expect(serialized).not.toContain('0a'.repeat(32));
		expect(serialized).toContain('sb_publishable_x');
		expect(serialized).toContain('http://127.0.0.1:54321');
		expect(serialized).toContain(
			'postgresql://postgres:[REDACTED]@127.0.0.1:54322',
		);
		expect(serialized).toContain(STACK_ID);
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
