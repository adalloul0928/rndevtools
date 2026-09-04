import {
	type ConsoleLogInput,
	createConsolePlugin,
	redactConsoleText,
} from './console';

describe('console attribute redaction', () => {
	it('redacts credential keys in either casing but keeps ordinary keys', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {
						listener = undefined;
					};
				},
			},
		});
		const dispose = diagnostics.plugin.install?.();
		listener?.({
			level: 'info',
			message: 'render',
			attributes: {
				width: 390,
				isValid: true,
				provider: 'google',
				gridSize: 12,
				accessToken: 'super-secret',
				user_id: 'abc',
			},
		});
		const captured = JSON.stringify(diagnostics.getEvents());
		// Ordinary diagnostic keys must survive: an unanchored match would redact
		// every one of these, because each contains the substring `id`.
		expect(captured).toContain('390');
		expect(captured).toContain('google');
		expect(captured).toContain('12');
		expect(captured).toContain('isValid');
		// Credential keys stay redacted in both separator and camelCase spellings.
		expect(captured).not.toContain('super-secret');
		expect(captured).not.toContain('abc');
		dispose?.();
	});
});

describe('createConsolePlugin', () => {
	it('captures logger events only while installed and redacts before storage', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {
						listener = undefined;
					};
				},
			},
		});

		expect(listener).toBeUndefined();
		const dispose = diagnostics.plugin.install?.();
		listener?.({
			level: 'error',
			message: 'Request for person@example.com used Bearer super-secret',
			attributes: {
				email: 'person@example.com',
				status: 500,
				request_id: '6b03a565-1d70-40a5-9340-6ff8d752fb50',
			},
		});

		const captured = JSON.stringify(diagnostics.getEvents());
		expect(captured).toContain('[REDACTED_EMAIL]');
		expect(captured).toContain('[REDACTED]');
		expect(captured).toContain('500');
		expect(captured).not.toContain('person@example.com');
		expect(captured).not.toContain('super-secret');
		expect(captured).not.toContain('6b03a565');

		dispose?.();
		expect(listener).toBeUndefined();
	});

	it('bounds captured logger events', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			maxEvents: 1,
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		listener?.({ level: 'info', message: 'first' });
		listener?.({ level: 'warn', message: 'second' });

		expect(diagnostics.getEvents()).toHaveLength(1);
		expect(diagnostics.getEvents()[0]?.message).toBe('second');
	});

	it('groups identical structured logs inside the grouping window', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			groupingWindowMs: 500,
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const repeated: ConsoleLogInput = {
			at: 1_000,
			level: 'warn',
			message: 'Retrying request',
			scope: 'network.retry',
			correlationId: 'request-42',
			attributes: { attempt: 1 },
		};
		listener?.(repeated);
		listener?.({ ...repeated, at: 1_250 });
		listener?.({ ...repeated, at: 2_000 });

		expect(diagnostics.getEvents()).toHaveLength(2);
		expect(diagnostics.getEvents()[0]).toMatchObject({
			firstAt: 1_000,
			lastAt: 1_250,
			at: 1_250,
			repeatCount: 2,
			scope: 'network.retry',
			correlationId: 'request-42',
		});
		expect(diagnostics.getEvents()[1]).toMatchObject({
			firstAt: 2_000,
			lastAt: 2_000,
			repeatCount: 1,
		});
	});

	it('captures supplied error and source metadata after bounding and redaction', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			maxStackBytes: 256,
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		listener?.({
			level: 'error',
			message: 'Request failed',
			error: {
				name: 'NetworkError',
				stack:
					'NetworkError: Bearer top-secret\n at fetch (person@example.com:1:2)',
			},
			sourceLocation: {
				file: '/src/network/client.ts?token=source-secret',
				line: 42,
				column: 7,
			},
		});

		const captured = diagnostics.getEvents()[0];
		expect(captured).toMatchObject({
			errorName: 'NetworkError',
			sourceLocation: { line: 42, column: 7 },
			repeatCount: 1,
		});
		expect(JSON.stringify(captured)).not.toContain('top-secret');
		expect(JSON.stringify(captured)).not.toContain('person@example.com');
		expect(JSON.stringify(captured)).not.toContain('source-secret');
	});

	it('bookmarks retained events and removes stale bookmarks on eviction or clear', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			maxEvents: 1,
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		listener?.({ level: 'info', message: 'first' });
		expect(diagnostics.toggleBookmark(1)).toBe(true);
		expect(diagnostics.getBookmarkedEventIds()).toEqual([1]);
		expect(diagnostics.toggleBookmark(1)).toBe(false);
		expect(diagnostics.getBookmarkedEventIds()).toEqual([]);
		diagnostics.toggleBookmark(1);

		listener?.({ level: 'warn', message: 'second' });
		expect(diagnostics.getBookmarkedEventIds()).toEqual([]);
		expect(diagnostics.toggleBookmark(1)).toBe(false);
		expect(diagnostics.toggleBookmark(2)).toBe(true);
		diagnostics.clear();
		expect(diagnostics.getBookmarkedEventIds()).toEqual([]);
	});

	it('ignores source callbacks retained after disposal', () => {
		const listeners: Array<(event: ConsoleLogInput) => void> = [];
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (listener) => {
					listeners.push(listener);
					return () => {};
				},
			},
		});
		const dispose = diagnostics.plugin.install?.();
		const staleListener = listeners[0];
		dispose?.();

		staleListener?.({ level: 'error', message: 'late event' });

		expect(diagnostics.getEvents()).toEqual([]);
	});

	it('redacts camelCase sensitive attribute keys without invoking accessors', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const attributes = {
			accessToken: 'opaque-access-value',
			refreshToken: 'opaque-refresh-value',
			userId: 'opaque-user-value',
			phoneNumber: '555-0100',
			get dangerous() {
				throw new Error('getter must not run');
			},
		};

		expect(() =>
			listener?.({ level: 'info', message: 'safe', attributes }),
		).not.toThrow();
		const captured = JSON.stringify(diagnostics.getEvents());
		expect(captured).not.toContain('opaque-access-value');
		expect(captured).not.toContain('opaque-refresh-value');
		expect(captured).not.toContain('opaque-user-value');
		expect(captured).not.toContain('555-0100');
		expect(captured).toContain('[Accessor omitted]');
	});

	it('contains faulty sources, sanitizers, and disposers', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			sanitize: () => {
				throw new Error('sanitize failed');
			},
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {
						throw new Error('dispose failed');
					};
				},
			},
		});

		const dispose = diagnostics.plugin.install?.();
		expect(() =>
			listener?.({ level: 'info', message: 'ignored' }),
		).not.toThrow();
		expect(diagnostics.getEvents()).toEqual([]);
		expect(() => dispose?.()).not.toThrow();
	});

	it('does not invoke array accessors and replaces invalid timestamps', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const values: unknown[] = [];
		Object.defineProperty(values, '0', {
			enumerable: true,
			get() {
				throw new Error('getter must not run');
			},
		});
		values.length = 1;

		expect(() =>
			listener?.({
				at: Number.MAX_VALUE,
				level: 'info',
				message: 'safe',
				attributes: { values },
			}),
		).not.toThrow();
		expect(diagnostics.getEvents()[0]?.attributesText).toContain(
			'[Accessor omitted]',
		);
		expect(diagnostics.getEvents()[0]?.at).toBeLessThanOrEqual(Date.now());
	});

	it('does not invoke accessors on sanitizer output', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const getter = jest.fn(() => 'unsafe');
		const output = { level: 'info' } as Record<string, unknown>;
		Object.defineProperty(output, 'message', {
			enumerable: true,
			get: getter,
		});
		const diagnostics = createConsolePlugin({
			sanitize: () => output as unknown as ConsoleLogInput,
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();

		expect(() =>
			listener?.({ level: 'info', message: 'original' }),
		).not.toThrow();
		expect(getter).not.toHaveBeenCalled();
		expect(diagnostics.getEvents()).toEqual([]);
	});

	it('rejects unsafe retention limits', () => {
		const source = { subscribe: () => () => {} };
		expect(() => createConsolePlugin({ source, maxEvents: 10_001 })).toThrow(
			'maxEvents cannot exceed',
		);
		expect(() =>
			createConsolePlugin({ source, maxMessageBytes: 64 * 1024 + 1 }),
		).toThrow('maxMessageBytes cannot exceed');
	});
});

describe('redactConsoleText', () => {
	it('redacts common credentials and identifiers', () => {
		const value = redactConsoleText(
			'https://example.test?a=1&token=abc person@example.com Bearer xyz {"secret":"hidden"}',
		);
		expect(value).toContain('token=[REDACTED]');
		expect(value).not.toContain('person@example.com');
		expect(value).not.toContain('Bearer xyz');
		expect(value).not.toContain('hidden');
	});
});
