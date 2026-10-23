import { describe, expect, it } from 'vitest';
import {
	adjacentSetupStep,
	parseCompletedTasks,
	setupActionError,
	shouldOpenSetup,
} from './onboarding';

describe('setupActionError', () => {
	const fallback = 'Could not do that.';
	it('says nothing when the action completed or was cancelled', () => {
		expect(setupActionError({ completed: true }, fallback)).toBeNull();
		expect(
			setupActionError({ completed: false, cancelled: true }, fallback)
		).toBeNull();
	});
	it('shows the error, or the fallback when there is none or no receipt', () => {
		expect(
			setupActionError(
				{ completed: false, error: 'Not a git repository.' },
				fallback
			)
		).toBe('Not a git repository.');
		expect(setupActionError({ completed: false }, fallback)).toBe(fallback);
		expect(setupActionError(undefined, fallback)).toBe(fallback);
	});
});

describe('parseCompletedTasks', () => {
	it('reads the stored task ids once each', () => {
		expect(
			parseCompletedTasks('["check-mac","boot-simulator","check-mac"]')
		).toEqual(['check-mac', 'boot-simulator']);
	});

	it('ignores anything that is not a list of task ids', () => {
		expect(parseCompletedTasks(null)).toEqual([]);
		expect(parseCompletedTasks('not json')).toEqual([]);
		expect(parseCompletedTasks('{"check-mac":true}')).toEqual([]);
		expect(
			parseCompletedTasks('["Check Mac", 3, null, "add-project"]')
		).toEqual(['add-project']);
		expect(parseCompletedTasks(`["${'a'.repeat(5_000)}"]`)).toEqual([]);
	});
});

describe('shouldOpenSetup', () => {
	it('opens for a workspace with no repository and no lane', () => {
		expect(
			shouldOpenSetup({ setupDone: false, repositories: 0, lanes: 0 })
		).toBe(true);
	});

	it('stays closed once setup was finished or dismissed', () => {
		expect(
			shouldOpenSetup({ setupDone: true, repositories: 0, lanes: 0 })
		).toBe(false);
	});

	it('stays closed for anyone who already tracks a repository or runs a lane', () => {
		expect(
			shouldOpenSetup({ setupDone: false, repositories: 1, lanes: 0 })
		).toBe(false);
		expect(
			shouldOpenSetup({ setupDone: false, repositories: 0, lanes: 2 })
		).toBe(false);
	});
});

describe('adjacentSetupStep', () => {
	it('moves one step either way and stops at the ends', () => {
		expect(adjacentSetupStep('welcome', 1)).toBe('mac');
		expect(adjacentSetupStep('mac', -1)).toBe('welcome');
		expect(adjacentSetupStep('welcome', -1)).toBe('welcome');
		expect(adjacentSetupStep('ready', 1)).toBe('ready');
	});
});
