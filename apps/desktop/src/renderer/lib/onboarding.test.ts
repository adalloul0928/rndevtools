import { describe, expect, it } from 'vitest';
import { adjacentSetupStep, shouldOpenSetup } from './onboarding';

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
