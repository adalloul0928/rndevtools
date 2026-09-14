import { describe, expect, it } from 'vitest';
import {
	capabilityGuidance,
	capabilityOnboardingAction,
	persistentCaptureProviderStatus,
} from './settings-panel';

describe('Simulator Settings capability guidance', () => {
	it('shows concrete permission guidance without claiming an unavailable action', () => {
		expect(
			capabilityGuidance(
				{
					status: 'unavailable',
					unavailableGuidance:
						'Grant access in macOS System Settings > Privacy & Security, then restart it.',
				},
				true
			)
		).toBe(
			'Grant access in macOS System Settings > Privacy & Security, then restart it.'
		);
	});

	it('gives visible desktop and discovery recovery steps', () => {
		const capability = {
			status: 'checking' as const,
			unavailableGuidance: 'Install the required capability.',
		};
		expect(capabilityGuidance(capability, false)).toContain(
			'installed desktop app'
		);
		expect(capabilityGuidance(capability, true)).toContain('still running');
	});

	it('directs available integrations to their feature-owned workspace', () => {
		expect(
			capabilityGuidance(
				{
					status: 'available',
					unavailableGuidance: 'Not used while available.',
				},
				true
			)
		).toContain('feature-owned workspace');
	});

	it('maps only supported main-owned onboarding operations', () => {
		expect(capabilityOnboardingAction('xcode')).toMatchObject({
			operation: { kind: 'toolchain.selectXcode' },
		});
		expect(capabilityOnboardingAction('screen-recording')).toMatchObject({
			operation: {
				kind: 'privacy.openSettings',
				permission: 'screen_recording',
			},
		});
		expect(capabilityOnboardingAction('audio-capture')).toMatchObject({
			operation: { kind: 'privacy.openSettings', permission: 'microphone' },
		});
		expect(capabilityOnboardingAction('agent-cli')).toMatchObject({
			label: 'Reveal CLI',
			operation: { kind: 'agentCli.reveal' },
		});
		expect(capabilityOnboardingAction('physical-devices')).toBeNull();
	});

	it('does not call API or hardware probes ready before a persistent provider exists', () => {
		expect(persistentCaptureProviderStatus(false, true)).toBe('unavailable');
		expect(persistentCaptureProviderStatus(undefined, true)).toBe(
			'unavailable'
		);
		expect(persistentCaptureProviderStatus(true, false)).toBe('unavailable');
		expect(persistentCaptureProviderStatus(true, true)).toBe('available');
	});
});
