import { describe, expect, it } from 'vitest';
import {
	headersText,
	matchesNetworkTarget,
	methodBadgeTone,
	statusTone,
} from './network-panel';

describe('methodBadgeTone', () => {
	it('maps HTTP verbs to semantic badge tones', () => {
		expect(methodBadgeTone('GET')).toBe('info');
		expect(methodBadgeTone('head')).toBe('info');
		expect(methodBadgeTone('POST')).toBe('success');
		expect(methodBadgeTone('DELETE')).toBe('danger');
		expect(methodBadgeTone('PUT')).toBe('warning');
		expect(methodBadgeTone('PATCH')).toBe('warning');
	});
});

describe('statusTone', () => {
	it('treats pending as info', () => {
		expect(statusTone({ state: 'pending' })).toBe('info');
	});
	it('treats error, aborted, and 4xx+ as danger', () => {
		expect(statusTone({ state: 'error' })).toBe('danger');
		expect(statusTone({ state: 'aborted' })).toBe('danger');
		expect(statusTone({ state: 'success', status: 404 })).toBe('danger');
		expect(statusTone({ state: 'success', status: 500 })).toBe('danger');
	});
	it('treats 3xx as warning and 2xx as success', () => {
		expect(statusTone({ state: 'success', status: 301 })).toBe('warning');
		expect(statusTone({ state: 'success', status: 200 })).toBe('success');
	});
});

describe('headersText', () => {
	it('reports an explicit empty message', () => {
		expect(headersText(undefined)).toBe('No captured headers.');
		expect(headersText({})).toBe('No captured headers.');
	});
	it('sorts headers alphabetically and joins as key: value lines', () => {
		expect(
			headersText({ 'X-Trace': '1', 'Content-Type': 'application/json' })
		).toBe('Content-Type: application/json\nX-Trace: 1');
	});
});

describe('matchesNetworkTarget', () => {
	const stack = 'a'.repeat(64);
	const filter = { key: `stack:${stack}`, label: 'origin 127.0.0.1:24410' };

	it('keeps every request without a backend filter', () => {
		expect(matchesNetworkTarget(undefined, null)).toBe(true);
	});

	it('keeps only requests to the filtered backend', () => {
		expect(
			matchesNetworkTarget(
				{ kind: 'other-stack', stackId: stack, port: 24_410 },
				filter
			)
		).toBe(true);
		expect(
			matchesNetworkTarget(
				{
					kind: 'hosted',
					host: 'abcd1234.supabase.co',
					projectRef: 'abcd1234',
				},
				filter
			)
		).toBe(false);
		expect(matchesNetworkTarget(undefined, filter)).toBe(false);
	});
});
