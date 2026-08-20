import {
	createNetworkPlugin,
	formatNetworkBytes,
	parseNetworkUrl,
} from './network';

function response(body: string, status = 200): Response {
	const headers = new Headers({
		'content-length': String(new TextEncoder().encode(body).byteLength),
		'content-type': 'application/json',
	});
	return {
		status,
		headers,
		clone: () => ({
			text: async () => body,
		}),
	} as unknown as Response;
}

async function flushCapture(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('createNetworkPlugin', () => {
	it('parses query parameters and formats payload sizes', () => {
		expect(parseNetworkUrl('https://example.test/items?a=1&a=2')).toEqual({
			host: 'example.test',
			origin: 'https://example.test',
			path: 'https://example.test/items',
			pathname: '/items',
			query: { a: ['1', '2'] },
		});
		expect(formatNetworkBytes(1536)).toBe('1.5 KB');
	});
	it('passes through without collecting while the plugin is not installed', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const expectedResponse = response('{"ok":true}');
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(expectedResponse) as unknown as typeof fetch;
		const instrumentedFetch = diagnostics.instrumentFetch(fetchImplementation);

		const actualResponse = await instrumentedFetch('https://example.test');

		expect(actualResponse).toBe(expectedResponse);
		expect(diagnostics.getEvents()).toEqual([]);
	});

	it('captures bodies asynchronously and redacts sensitive headers', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const expectedResponse = response('{"ok":true}', 201);
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(expectedResponse) as unknown as typeof fetch;
		const instrumentedFetch = diagnostics.instrumentFetch(fetchImplementation);

		const actualResponse = await instrumentedFetch(
			'https://example.test/items',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer secret',
					'Content-Type': 'application/json',
				},
				body: '{"name":"Bench press"}',
			},
		);
		await flushCapture();

		expect(actualResponse).toBe(expectedResponse);
		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({
				method: 'POST',
				status: 201,
				url: 'https://example.test/items',
				requestHeaders: expect.objectContaining({
					authorization: '[REDACTED]',
				}),
				requestBody: expect.stringContaining('Bench press'),
				responseBody: expect.stringContaining('ok'),
				source: 'Instrumented fetch',
				requestSizeBytes: expect.any(Number),
				responseSizeBytes: expect.any(Number),
			}),
		]);

		dispose?.();
	});

	it('records pending requests immediately and redacts URLs and JSON bodies', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		let resolveFetch: ((value: Response) => void) | undefined;
		const fetchImplementation = jest.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		) as unknown as typeof fetch;
		const instrumentedFetch = diagnostics.instrumentFetch(fetchImplementation);

		const request = instrumentedFetch(
			'https://example.test/items?token=secret&visible=yes',
			{
				method: 'POST',
				body: JSON.stringify({ password: 'secret', name: 'Squat' }),
			},
		);
		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({ state: 'pending', method: 'POST' }),
		]);
		expect(diagnostics.getEvents()[0]?.url).toContain('token=%5BREDACTED%5D');

		resolveFetch?.(response('{"session":"secret","ok":true}'));
		await request;
		await flushCapture();

		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				state: 'success',
				requestBody: expect.stringContaining('[REDACTED]'),
				responseBody: expect.stringContaining('[REDACTED]'),
			}),
		);
		expect(JSON.stringify(diagnostics.getEvents()[0])).not.toContain('secret');
		dispose?.();
	});

	it('never captures a Supabase password grant credential', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(
				response('{"access_token":"session-secret"}'),
			) as unknown as typeof fetch;
		const instrumentedFetch = diagnostics.instrumentFetch(fetchImplementation);

		await instrumentedFetch(
			'https://example.supabase.co/auth/v1/token?grant_type=password',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: 'maestro.power@example.com',
					password: 'shared-persona-password',
				}),
			},
		);
		await flushCapture();

		const capturedEvent = JSON.stringify(diagnostics.getEvents()[0]);
		expect(capturedEvent).toContain('[REDACTED]');
		expect(capturedEvent).not.toContain('shared-persona-password');
		expect(capturedEvent).not.toContain('session-secret');
		dispose?.();
	});

	it('patches and safely restores global fetch when requested', () => {
		const previousFetch = globalThis.fetch;
		const baseFetch = jest.fn() as unknown as typeof fetch;
		globalThis.fetch = baseFetch;
		const diagnostics = createNetworkPlugin({ patchGlobalFetch: true });
		const dispose = diagnostics.plugin.install?.();

		expect(globalThis.fetch).not.toBe(baseFetch);
		dispose?.();
		expect(globalThis.fetch).toBe(baseFetch);
		globalThis.fetch = previousFetch;
	});

	it('omits unknown-length bodies by default without reporting a zero size', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const unknownLengthResponse = {
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			clone: () => ({ text: async () => '{"large":true}' }),
		} as unknown as Response;
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(unknownLengthResponse) as unknown as typeof fetch;

		await diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test',
		);
		await flushCapture();

		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				responseBody: '[Body omitted: unknown content length]',
			}),
		);
		expect(diagnostics.getEvents()[0]?.responseSizeBytes).toBeUndefined();
		dispose?.();
	});

	it('reports the actual UTF-8 size when unknown-length capture is enabled', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			captureUnknownLengthBodies: true,
		});
		const dispose = diagnostics.plugin.install?.();
		const response = {
			status: 200,
			headers: new Headers({ 'content-type': 'text/plain' }),
			clone: () => ({ text: async () => '🏋️' }),
		} as unknown as Response;

		await diagnostics.instrumentFetch(jest.fn(async () => response))(
			'https://example.test',
		);
		await flushCapture();

		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				responseBody: '🏋️',
				responseSizeBytes: new TextEncoder().encode('🏋️').byteLength,
			}),
		);
		dispose?.();
	});

	it('rejects invalid body bounds', () => {
		expect(() => createNetworkPlugin({ maxBodyBytes: 0 })).toThrow(
			'maxBodyBytes',
		);
	});

	it('does not resurrect a pending request after it has been evicted', async () => {
		const diagnostics = createNetworkPlugin({ maxEvents: 1 });
		const dispose = diagnostics.plugin.install?.();
		let resolveFirst: ((response: Response) => void) | undefined;
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		const response = (status: number) =>
			({
				status,
				headers: new Headers(),
				clone: () => ({ text: async () => '' }),
			}) as unknown as Response;
		const fetchImplementation = jest
			.fn()
			.mockReturnValueOnce(firstResponse)
			.mockResolvedValueOnce(response(201)) as unknown as typeof fetch;
		const instrumented = diagnostics.instrumentFetch(fetchImplementation);

		const first = instrumented('https://example.test/first');
		await instrumented('https://example.test/second');
		await flushCapture();
		resolveFirst?.(response(200));
		await first;
		await flushCapture();

		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({ url: 'https://example.test/second' }),
		]);
		dispose?.();
	});
});
