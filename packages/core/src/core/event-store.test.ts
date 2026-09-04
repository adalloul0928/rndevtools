import { exportDevtoolsEvents } from '../events/exporters';
import {
	DEVTOOLS_EVENT_VERSION,
	type DevtoolsEvent,
	type DevtoolsEventInput,
} from '../events/types';
import { DevtoolsEventStore } from './event-store';
import { utf8ByteLength } from './serialize';

function createStore(
	overrides: Partial<ConstructorParameters<typeof DevtoolsEventStore>[0]> = {},
): DevtoolsEventStore {
	return new DevtoolsEventStore({
		maxEvents: 10,
		maxBytes: 128 * 1024,
		now: () => 1_234,
		idFactory: (kind, sequence) => `${kind}-${sequence}`,
		...overrides,
	});
}

function eventInput(title: string): DevtoolsEventInput {
	return {
		source: 'custom',
		kind: 'test.recorded',
		level: 'info',
		title,
	};
}

function acceptedEvent(
	store: DevtoolsEventStore,
	input: DevtoolsEventInput,
): DevtoolsEvent {
	const result = store.append(input);
	if (result.status !== 'accepted') {
		throw new Error(`Expected accepted event, received ${result.status}`);
	}
	return result.event;
}

describe('DevtoolsEventStore', () => {
	it('creates immutable versioned envelopes and publishes stable snapshots', () => {
		const store = createStore();
		const listener = jest.fn();
		const failingListener = jest.fn(() => {
			throw new Error('observer failure');
		});
		store.subscribe(failingListener);
		const unsubscribe = store.subscribe(listener);
		const before = store.getSnapshot();

		const event = acceptedEvent(store, eventInput('Recorded'));

		expect(event).toMatchObject({
			version: DEVTOOLS_EVENT_VERSION,
			id: expect.stringMatching(/^event-1:event:\d+:initial:1$/),
			at: 1_234,
			sequence: 1,
			level: 'info',
			redacted: false,
			truncated: false,
		});
		expect(Object.isFrozen(event)).toBe(true);
		expect(Object.isFrozen(store.getSnapshot().events)).toBe(true);
		expect(store.getSnapshot()).not.toBe(before);
		expect(store.getServerSnapshot()).toBe(store.getSnapshot());
		expect(listener).toHaveBeenCalledTimes(1);
		expect(failingListener).toHaveBeenCalledTimes(1);

		unsubscribe();
		acceptedEvent(store, eventInput('Second'));
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('redacts and detaches input before subscribers can observe it', () => {
		const store = createStore();
		const observed: string[] = [];
		store.subscribe(() => observed.push(JSON.stringify(store.getSnapshot())));
		const rawAttributes: Record<string, unknown> = {
			authorization: 'Bearer raw-secret',
			details: { duplicatedPayload: 'must-not-enter-the-envelope' },
			note: 'contact person@example.com',
		};

		const event = acceptedEvent(store, {
			source: 'console',
			kind: 'log',
			title: 'Bearer title-secret',
			summary: `person@example.com ${'x'.repeat(20 * 1024)}`,
			attributes: rawAttributes as DevtoolsEventInput['attributes'],
		});
		rawAttributes.note = 'mutated-secret@example.com';

		const retained = JSON.stringify(store.getSnapshot());
		expect(retained).not.toContain('raw-secret');
		expect(retained).not.toContain('title-secret');
		expect(retained).not.toContain('person@example.com');
		expect(retained).not.toContain('duplicatedPayload');
		expect(retained).not.toContain('mutated-secret@example.com');
		expect(event.attributes).toEqual({
			authorization: '[REDACTED]',
			note: 'contact [REDACTED EMAIL]',
		});
		expect(Object.isFrozen(event.attributes)).toBe(true);
		expect(event.redacted).toBe(true);
		expect(event.truncated).toBe(true);
		expect(store.getSnapshot().counters).toMatchObject({
			accepted: 1,
			redacted: 1,
			truncated: 1,
		});
		expect(observed).toHaveLength(1);
		expect(observed[0]).toBe(retained);
	});

	it('evicts oldest events deterministically by count and reports drops', () => {
		const store = createStore({ maxEvents: 2 });
		acceptedEvent(store, eventInput('one'));
		acceptedEvent(store, eventInput('two'));
		acceptedEvent(store, eventInput('three'));

		expect(store.getEvents().map((event) => event.title)).toEqual([
			'two',
			'three',
		]);
		expect(store.getEvents().map((event) => event.sequence)).toEqual([2, 3]);
		expect(store.getSnapshot().counters).toEqual({
			accepted: 3,
			dropped: 1,
			evicted: 1,
			redacted: 0,
			truncated: 0,
		});
	});

	it('evicts by exact estimated UTF-8 bytes and drops an oversized event', () => {
		const probe = createStore();
		acceptedEvent(probe, eventInput('same-size'));
		const oneEventBytes = probe.getEstimatedBytes();
		const store = createStore({ maxBytes: oneEventBytes + 1 });

		acceptedEvent(store, eventInput('same-size'));
		acceptedEvent(store, eventInput('same-size'));

		expect(store.getEvents()).toHaveLength(1);
		expect(store.getEvents()[0]?.sequence).toBe(2);
		expect(store.getEstimatedBytes()).toBe(
			utf8ByteLength(JSON.stringify(store.getEvents()[0])),
		);
		expect(store.getSnapshot().counters.evicted).toBe(1);

		const tooSmall = createStore({ maxBytes: 32 });
		expect(tooSmall.append(eventInput('cannot fit'))).toEqual({
			status: 'dropped',
			reason: 'oversized',
		});
		expect(tooSmall.getEvents()).toEqual([]);
		expect(tooSmall.getSnapshot().counters.dropped).toBe(1);
	});

	it('contains hostile inputs and sanitizer failures', () => {
		const sanitizer = jest.fn(() => {
			throw new Error('host sanitizer failed');
		});
		const store = createStore({ sanitize: sanitizer });
		expect(store.append(eventInput('ignored'))).toEqual({
			status: 'dropped',
			reason: 'sanitizer',
		});

		const getter = jest.fn(() => {
			throw new Error('must not run');
		});
		const hostile = Object.defineProperty({}, 'title', {
			enumerable: true,
			get: getter,
		});
		const safeStore = createStore();
		expect(safeStore.append(hostile as DevtoolsEventInput)).toEqual({
			status: 'dropped',
			reason: 'invalid',
		});
		expect(getter).not.toHaveBeenCalled();
	});

	it.each(['sanitizer', 'idFactory'] as const)(
		'revokes a reentrant old-session append from the %s boundary',
		(boundary) => {
			let store: DevtoolsEventStore;
			let transitioned = false;
			const transitionOwner = (): void => {
				if (transitioned) return;
				transitioned = true;
				store.setEnabled(false);
				store.resetSession();
				store.setEnabled(true);
			};
			store = createStore({
				...(boundary === 'sanitizer'
					? {
							sanitize: (input) => {
								transitionOwner();
								return input;
							},
						}
					: {
							idFactory: (kind, sequence) => {
								transitionOwner();
								return `${kind}-${sequence}`;
							},
						}),
			});

			expect(store.append(eventInput('previous owner'))).toEqual({
				status: 'disabled',
			});
			expect(store.getEvents()).toEqual([]);
			expect(store.getSnapshot().counters).toEqual({
				accepted: 0,
				dropped: 0,
				evicted: 0,
				redacted: 0,
				truncated: 0,
			});
			expect(
				acceptedEvent(store, eventInput('replacement owner')).sequence,
			).toBe(1);
		},
	);

	it('preserves explicit correlation, parent, and collector resource references', () => {
		const store = createStore();
		const correlationId = store.createCorrelationId();
		const parent = acceptedEvent(store, {
			...eventInput('request'),
			correlationId,
			resourceRef: { toolId: 'network', resourceId: 'request-42' },
		});
		const child = acceptedEvent(store, {
			...eventInput('query update'),
			correlationId,
			parentEventId: parent.id,
			resourceRef: { toolId: 'query', resourceId: 'todos' },
			payload: { shouldNotBeCopied: true },
		} as DevtoolsEventInput);

		expect(correlationId).toMatch(/^correlation-1:correlation:\d+:initial:1$/);
		expect(child).toMatchObject({
			correlationId,
			parentEventId: parent.id,
			resourceRef: { toolId: 'query', resourceId: 'todos' },
		});
		expect(Object.isFrozen(child.resourceRef)).toBe(true);
		expect(JSON.stringify(child)).not.toContain('shouldNotBeCopied');
	});

	it('clears retained data without reusing sequences or losing lifetime counters', () => {
		const sanitize = jest.fn((input: DevtoolsEventInput) => input);
		const store = createStore({ sanitize });
		const listener = jest.fn();
		store.subscribe(listener);
		acceptedEvent(store, eventInput('before clear'));

		store.clear();

		expect(store.getEvents()).toEqual([]);
		expect(store.getEstimatedBytes()).toBe(0);
		expect(store.getSnapshot().counters.accepted).toBe(1);
		expect(listener).toHaveBeenCalledTimes(2);
		const afterClear = acceptedEvent(store, eventInput('after clear'));
		expect(afterClear.sequence).toBe(2);
		expect(afterClear.id).toMatch(/^event-2:event:\d+:initial:2$/);
		expect(sanitize).toHaveBeenCalledTimes(2);
	});

	it('removes only exact event IDs without resetting lifetime metadata', () => {
		const store = createStore();
		const first = acceptedEvent(store, eventInput('first'));
		const second = acceptedEvent(store, eventInput('second'));
		const beforeBytes = store.getEstimatedBytes();

		store.removeEvents([first.id, 'unknown-event']);

		expect(store.getEvents()).toEqual([second]);
		expect(store.getEstimatedBytes()).toBeLessThan(beforeBytes);
		expect(store.getSnapshot().counters).toEqual({
			accepted: 2,
			dropped: 0,
			evicted: 0,
			redacted: 0,
			truncated: 0,
		});
		expect(acceptedEvent(store, eventInput('third')).sequence).toBe(3);
	});

	it('starts a fresh owner session without weakening configured policy', () => {
		const sanitize = jest.fn((event: DevtoolsEventInput) => event);
		const store = createStore({ sanitize });
		const listener = jest.fn();
		store.subscribe(listener);
		const firstCorrelation = store.createCorrelationId();
		const firstEvent = acceptedEvent(store, eventInput('previous owner'));

		store.resetSession();

		expect(store.getSnapshot()).toMatchObject({
			events: [],
			estimatedBytes: 0,
			counters: {
				accepted: 0,
				dropped: 0,
				evicted: 0,
				redacted: 0,
				truncated: 0,
			},
		});
		const replacementCorrelation = store.createCorrelationId();
		const replacementEvent = acceptedEvent(
			store,
			eventInput('replacement owner'),
		);
		expect(replacementCorrelation).not.toBe(firstCorrelation);
		expect(replacementEvent.id).not.toBe(firstEvent.id);
		expect(replacementEvent).toMatchObject({
			sequence: 1,
			at: 1_234,
		});
		expect(sanitize).toHaveBeenCalledTimes(2);
		expect(listener).toHaveBeenCalledTimes(3);
	});

	it('keeps fallback IDs unique after reset when a factory returns empty text', () => {
		const store = createStore({ idFactory: () => '   ' });
		store.resetSession();

		const firstCorrelation = store.createCorrelationId();
		const secondCorrelation = store.createCorrelationId();
		const firstEvent = acceptedEvent(store, eventInput('first'));
		const secondEvent = acceptedEvent(store, eventInput('second'));

		expect(new Set([firstCorrelation, secondCorrelation]).size).toBe(2);
		expect(new Set([firstEvent.id, secondEvent.id]).size).toBe(2);
		expect(firstCorrelation).not.toBe(firstEvent.id);
	});

	it('namespaces constant factory output so targeted removal cannot alias', () => {
		const store = createStore({ idFactory: () => 'constant' });
		const firstCorrelation = store.createCorrelationId();
		const secondCorrelation = store.createCorrelationId();
		const firstEvent = acceptedEvent(store, eventInput('first'));
		const secondEvent = acceptedEvent(store, eventInput('second'));

		expect(new Set([firstCorrelation, secondCorrelation]).size).toBe(2);
		expect(new Set([firstEvent.id, secondEvent.id]).size).toBe(2);
		expect(firstCorrelation).not.toBe(firstEvent.id);

		store.removeEvents([firstEvent.id]);
		expect(store.getEvents()).toEqual([secondEvent]);
	});

	it('binds a reentrant correlation allocation to its entry namespace', () => {
		let store: DevtoolsEventStore;
		let reset = false;
		store = createStore({
			idFactory: (kind, sequence) => {
				if (kind === 'correlation' && !reset) {
					reset = true;
					store.setEnabled(false);
					store.resetSession();
					store.setEnabled(true);
				}
				return `${kind}-${sequence}`;
			},
		});

		const revokedSessionId = store.createCorrelationId();
		const replacementSessionId = store.createCorrelationId();

		expect(revokedSessionId).toMatch(
			/^correlation-1:correlation:\d+:initial:1$/,
		);
		expect(replacementSessionId).toMatch(
			/^correlation-1:correlation:\d+:[A-Za-z0-9-]+:1$/,
		);
		expect(replacementSessionId).not.toBe(revokedSessionId);
	});

	it('rejects oversized factory IDs before trimming or redacting them', () => {
		const oversized = 'x'.repeat(1_000_000);
		const store = createStore({ idFactory: () => oversized });
		const trim = jest.spyOn(String.prototype, 'trim');
		let correlationId = '';
		try {
			correlationId = store.createCorrelationId();
			expect(trim).not.toHaveBeenCalled();
		} finally {
			trim.mockRestore();
		}

		expect(correlationId.length).toBeLessThanOrEqual(512);
		expect(correlationId).toMatch(/^devtools:correlation:\d+:initial:1$/);
	});

	it('exports bounded, re-redacted complete JSON and NDJSON events', () => {
		const store = createStore({ maxExportBytes: 128 * 1024 });
		acceptedEvent(store, eventInput('one'));
		acceptedEvent(store, eventInput('two'));
		acceptedEvent(store, eventInput('three'));

		const json = store.exportEvents({ format: 'json' });
		const parsed = JSON.parse(json.text) as DevtoolsEvent[];
		expect(parsed.map((event) => event.title)).toEqual(['one', 'two', 'three']);
		expect(json.estimatedBytes).toBe(utf8ByteLength(json.text));
		expect(json.truncated).toBe(false);

		const newest = store.exportEvents({ format: 'ndjson', maxEvents: 1 });
		const bounded = store.exportEvents({
			format: 'ndjson',
			maxBytes: newest.estimatedBytes,
		});
		expect(bounded.estimatedBytes).toBeLessThanOrEqual(newest.estimatedBytes);
		expect(bounded.eventCount).toBe(1);
		expect(bounded.omittedEvents).toBe(2);
		expect(JSON.parse(bounded.text)).toMatchObject({ title: 'three' });

		const unsafe = {
			...store.getEvents()[0],
			title: 'Bearer export-secret',
			attributes: { password: 'raw-password' },
		} as DevtoolsEvent;
		const defensive = exportDevtoolsEvents([unsafe], {
			format: 'json',
			maxBytes: 10_000,
		});
		expect(defensive.text).not.toContain('export-secret');
		expect(defensive.text).not.toContain('raw-password');
		expect(JSON.parse(defensive.text)).toHaveLength(1);
	});

	it('does no capture work while disabled and releases state on disposal', () => {
		const sanitize = jest.fn((event: DevtoolsEventInput) => event);
		const store = createStore({ enabled: false, sanitize });
		const listener = jest.fn();
		store.subscribe(listener);

		expect(store.append(eventInput('disabled'))).toEqual({
			status: 'disabled',
		});
		expect(sanitize).not.toHaveBeenCalled();
		expect(listener).not.toHaveBeenCalled();
		expect(store.getSnapshot().counters.dropped).toBe(0);

		store.setEnabled(true);
		acceptedEvent(store, eventInput('active'));
		expect(sanitize).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledTimes(2);

		store.dispose();
		expect(listener).toHaveBeenCalledTimes(3);
		expect(store.getSnapshot()).toMatchObject({
			enabled: false,
			disposed: true,
			events: [],
			estimatedBytes: 0,
		});
		expect(store.append(eventInput('disposed'))).toEqual({
			status: 'disposed',
		});
		expect(sanitize).toHaveBeenCalledTimes(1);
		store.dispose();
		expect(listener).toHaveBeenCalledTimes(3);
	});

	it('validates store and export limits without weakening legacy stores', () => {
		expect(() => createStore({ maxEvents: 0 })).toThrow('maxEvents');
		expect(() => createStore({ maxBytes: Number.NaN })).toThrow('maxBytes');
		expect(() => createStore({ maxBytes: 100, maxEventBytes: 101 })).toThrow(
			'maxEventBytes',
		);
		const store = createStore();
		expect(() => store.exportEvents({ format: 'json', maxBytes: 1 })).toThrow(
			'JSON exports',
		);
		expect(() =>
			store.exportEvents({ format: 'ndjson', maxEvents: 0 }),
		).toThrow('maxEvents');
	});
});
