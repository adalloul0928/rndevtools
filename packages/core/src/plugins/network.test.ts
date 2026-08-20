import {
	buildCurlCommand,
	collapseNetworkEvents,
	createNetworkPlugin,
	detailStatusText,
	formatNetworkBytes,
	formatNetworkClock,
	formatNetworkDuration,
	isSupabaseNetworkEvent,
	isSystemNetworkEvent,
	matchesNetworkSegment,
	type NetworkEvent,
	networkEventLabel,
	networkRequestPath,
	networkRowSubtitle,
	networkStatusPresentation,
	parseNetworkUrl,
	prettyNetworkBody,
	responseBodySummaryText,
	summarizeNetworkEvents,
} from './network';

function networkEvent(overrides: Partial<NetworkEvent> = {}): NetworkEvent {
	return {
		id: 1,
		startedAt: 0,
		method: 'GET',
		url: 'https://example.test/items',
		state: 'success',
		status: 200,
		durationMs: 120,
		requestHeaders: {},
		source: 'Instrumented fetch',
		...overrides,
	};
}

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

describe('network presentation model', () => {
	it('labels Supabase rest, edge function, storage, and auth requests', () => {
		expect(
			networkEventLabel(
				networkEvent({
					url: 'https://abc.supabase.co/rest/v1/workouts?select=id',
				}),
			),
		).toEqual({ label: 'workouts', sourceKind: 'rest' });
		expect(
			networkEventLabel(
				networkEvent({
					url: 'https://abc.supabase.co/functions/v1/ai-coach-chat',
				}),
			),
		).toEqual({ label: 'ai-coach-chat', sourceKind: 'edge function' });
		expect(
			networkEventLabel(
				networkEvent({
					url: 'https://abc.supabase.co/storage/v1/object/sign/exercise_media/clip.mp4',
				}),
			),
		).toEqual({ label: 'exercise_media', sourceKind: 'storage' });
		expect(
			networkEventLabel(
				networkEvent({
					url: 'https://abc.supabase.co/auth/v1/token?grant_type=refresh_token',
				}),
			),
		).toEqual({ label: 'token', sourceKind: 'auth' });
		expect(
			networkEventLabel(
				networkEvent({ url: 'https://app.posthog.com/batch/' }),
			),
		).toEqual({ label: 'batch' });
	});

	it('matches segment filters for supabase, errors, and slow requests', () => {
		expect(
			isSupabaseNetworkEvent(
				networkEvent({ url: 'http://127.0.0.1:54321/rest/v1/sets' }),
			),
		).toBe(true);
		expect(
			isSupabaseNetworkEvent(
				networkEvent({ url: 'https://abc.supabase.co/anything' }),
			),
		).toBe(true);
		expect(
			matchesNetworkSegment(
				networkEvent({ url: 'https://app.posthog.com/batch/' }),
				'supabase',
			),
		).toBe(false);
		expect(matchesNetworkSegment(networkEvent({ status: 500 }), 'errors')).toBe(
			true,
		);
		expect(
			matchesNetworkSegment(
				networkEvent({ state: 'aborted', status: undefined }),
				'errors',
			),
		).toBe(true);
		expect(matchesNetworkSegment(networkEvent(), 'errors')).toBe(false);
		expect(
			matchesNetworkSegment(networkEvent({ durationMs: 1200 }), 'slow'),
		).toBe(true);
		expect(
			matchesNetworkSegment(networkEvent({ durationMs: 800 }), 'slow'),
		).toBe(false);
	});

	it('hides only connectivity checks, sentry ingest, and the Metro dev server', () => {
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'https://clients3.google.com/generate_204' }),
			),
		).toBe(true);
		expect(
			isSystemNetworkEvent(
				networkEvent({
					url: 'https://connectivitycheck.gstatic.com/generate_204',
				}),
			),
		).toBe(true);
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'https://captive.apple.com/hotspot-detect.html' }),
			),
		).toBe(true);
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'https://o123.ingest.sentry.io/api/1/envelope/' }),
			),
		).toBe(true);
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'http://localhost:8081/symbolicate' }),
			),
		).toBe(true);
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'http://127.0.0.1:8090/status' }),
			),
		).toBe(true);
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'http://127.0.0.1:54321/rest/v1/sets' }),
			),
		).toBe(false);
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'https://app.posthog.com/batch/' }),
			),
		).toBe(false);
	});

	it('collapses only consecutive duplicates of method, url, and status', () => {
		const batch = (id: number) =>
			networkEvent({
				id,
				method: 'POST',
				status: 204,
				url: 'https://app.posthog.com/batch/',
			});
		const collapsed = collapseNetworkEvents([
			batch(5),
			batch(4),
			batch(3),
			networkEvent({
				id: 2,
				method: 'POST',
				status: 500,
				url: 'https://app.posthog.com/batch/',
			}),
			batch(1),
		]);
		expect(collapsed.map((row) => [row.event.id, row.count])).toEqual([
			[5, 3],
			[2, 1],
			[1, 1],
		]);
	});

	it('summarizes visible traffic with window, counts, failures, and size', () => {
		const now = 10 * 60_000;
		const events = [
			networkEvent({
				requestSizeBytes: 1024,
				responseSizeBytes: 1024,
				startedAt: now - 4 * 60_000,
			}),
			networkEvent({
				error: 'Network request failed',
				id: 2,
				startedAt: now - 60_000,
				state: 'error',
				status: undefined,
			}),
		];
		expect(summarizeNetworkEvents(events, now)).toBe(
			'Last 4 min · 2 requests · 1 failed · 2.0 KB',
		);
		expect(summarizeNetworkEvents([], now)).toBe('No requests');
	});

	it('presents status text and tone by request outcome', () => {
		expect(
			networkStatusPresentation(
				networkEvent({ state: 'pending', status: undefined }),
			),
		).toEqual({ text: '…', tone: 'info' });
		expect(networkStatusPresentation(networkEvent())).toEqual({
			text: '200',
			tone: 'success',
		});
		expect(networkStatusPresentation(networkEvent({ status: 404 }))).toEqual({
			text: '404',
			tone: 'warning',
		});
		expect(networkStatusPresentation(networkEvent({ status: 500 }))).toEqual({
			text: '500',
			tone: 'danger',
		});
		expect(
			networkStatusPresentation(
				networkEvent({ state: 'error', status: undefined }),
			),
		).toEqual({ text: 'ERROR', tone: 'danger' });
	});

	it('builds row subtitles from source, timing, and payload', () => {
		expect(
			networkRowSubtitle(
				networkEvent({
					durationMs: 182,
					responseSizeBytes: 2150,
					url: 'https://abc.supabase.co/rest/v1/workouts',
				}),
			),
		).toBe('rest · 182 ms · 2.1 KB');
		expect(
			networkRowSubtitle(
				networkEvent({
					state: 'pending',
					status: undefined,
					url: 'https://abc.supabase.co/functions/v1/ai-coach-chat',
				}),
			),
		).toBe('edge function · pending');
		expect(
			networkRowSubtitle(
				networkEvent({
					durationMs: 3400,
					error: 'STREAM_FAILED',
					state: 'error',
					status: undefined,
					url: 'https://abc.supabase.co/functions/v1/ai-coach-chat',
				}),
			),
		).toBe('edge function · 3.4 s · STREAM_FAILED');
		expect(
			networkRowSubtitle(
				networkEvent({
					durationMs: 88,
					method: 'POST',
					responseSizeBytes: 6144,
					status: 204,
					url: 'https://app.posthog.com/batch/',
				}),
			),
		).toBe('posthog · 88 ms · 6.0 KB');
	});

	it('formats detail rows and bodies', () => {
		expect(formatNetworkDuration(182)).toBe('182 ms');
		expect(formatNetworkDuration(3400)).toBe('3.4 s');
		expect(
			formatNetworkClock(new Date(2026, 7, 19, 12, 41, 7, 412).getTime()),
		).toBe('12:41:07.412');
		expect(prettyNetworkBody('{"a":1}')).toBe('{\n  "a": 1\n}');
		expect(prettyNetworkBody('plain')).toBe('plain');
		expect(
			networkRequestPath('https://abc.supabase.co/rest/v1/workouts?select=id'),
		).toBe('/rest/v1/workouts?select=id');
		expect(detailStatusText(networkEvent())).toBe('200 OK');
		expect(
			detailStatusText(networkEvent({ state: 'aborted', status: undefined })),
		).toBe('Aborted');
		expect(
			responseBodySummaryText(
				networkEvent({
					contentType: 'application/json',
					responseBody: '[]',
					responseSizeBytes: 2150,
				}),
			),
		).toBe('JSON · 2.1 KB');
		expect(responseBodySummaryText(networkEvent())).toBe('Empty');
	});

	it('builds a runnable cURL command with escaped quotes', () => {
		const command = buildCurlCommand(
			networkEvent({
				method: 'POST',
				requestBody: '{"name":"Bench"}',
				requestHeaders: { 'content-type': 'application/json' },
				url: "https://example.test/items?q=o'clock",
			}),
		);
		expect(command).toContain(
			"curl -X POST 'https://example.test/items?q=o'\\''clock'",
		);
		expect(command).toContain("-H 'content-type: application/json'");
		expect(command).toContain(`--data '{"name":"Bench"}'`);
	});
});
