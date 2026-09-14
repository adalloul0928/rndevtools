import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { VerifiedNativeHelper } from './native-helper-trust';
import {
	NativeHostClient,
	NativeHostResponseError,
} from './native-host-client';

const verified: VerifiedNativeHelper = {
	executablePath: '/signed/pumpd-native-host',
	verifiedAt: 1,
	manifest: {
		schemaVersion: 1,
		platform: 'darwin',
		architecture: 'arm64',
		appVersion: '0.1.0',
		buildCommit: 'a'.repeat(40),
		protocolVersion: 2,
		compatibilityMatrixVersion: '2026-09-03-v2',
		catalog: {
			version: 'simslim-v0.8.0-09fc9cbb-pumpd.1-presets.2',
			upstreamRepository: 'https://github.com/MobAI-App/simslim',
			upstreamCommit: '09fc9cbbca35db5230e6d571a0a366fe6876266e',
			patchSet: 'pumpd.1',
			upstreamSourceManifestSha256:
				'8a7681f26eb84be6b5a84a1326973c35c1ba4320e27c706655d3eed8bd31af08',
			patchSha256:
				'69bef9b9d08e900652acb77fd13463f6bc5f8735df1aa994ba6be6d353146083',
			vendoredSourceManifestSha256:
				'b2045d5332b79e52875d592189f37de2c817c12a341cddbb75499f3085b0e4c7',
		},
		helpers: {
			simulator: {
				name: 'pumpd-sim-helper',
				file: 'pumpd-sim-helper',
				sha256: 'b'.repeat(64),
				size: 1,
			},
			nativeHost: {
				name: 'pumpd-native-host',
				file: 'pumpd-native-host',
				sha256: 'c'.repeat(64),
				size: 1,
			},
			cli: {
				name: 'pumpd-devtools',
				file: 'pumpd-devtools',
				sha256: 'c'.repeat(64),
				size: 1,
			},
		},
	},
};

describe('native host client', () => {
	it('brokers an exact helper mutation through protocol v4 with bounded cleanup timing', async () => {
		const helperRequest = `${JSON.stringify({
			protocolVersion: 2,
			requestId: 'mutation-1',
			operation: 'disk_cleanup',
			payload: { simulatorId: '11111111-2222-3333-4444-555555555555' },
		})}\n`;
		const runner = vi.fn(async (_executable, args, options) => {
			expect(args).toEqual([]);
			expect(options).toMatchObject({
				timeoutMs: 660_000,
				forceKillDelayMs: 120_000,
				maxOutputBytes: 8 * 1024 * 1024,
			});
			const request = JSON.parse(options.stdin ?? '') as {
				protocolVersion: number;
				requestId: string;
				operation: string;
				payload: { helperRequest: string };
			};
			expect(request).toMatchObject({
				protocolVersion: 4,
				operation: 'run_simulator_mutation',
				payload: { helperRequest },
			});
			return {
				stdout: JSON.stringify({
					protocolVersion: 4,
					requestId: request.requestId,
					ok: true,
					result: {
						helperResponse:
							'{"protocolVersion":2,"requestId":"mutation-1","ok":true,"result":{}}',
					},
				}),
				stderr: '',
				exitCode: 0,
			};
		});
		const client = new NativeHostClient({
			resourceDirectory: '/signed',
			appVersion: '0.1.0',
			runner,
			verifier: vi.fn(async () => verified),
		});
		await expect(
			client.runSimulatorMutation(helperRequest, {
				timeoutMs: 660_000,
				forceKillDelayMs: 120_000,
			})
		).resolves.toContain('mutation-1');
	});

	it('keeps the native host error code when the host refuses a request', async () => {
		const runner = vi.fn(async (_executable, _args, options) => {
			const request = JSON.parse(options.stdin ?? '') as { requestId: string };
			return {
				stdout: JSON.stringify({
					protocolVersion: 4,
					requestId: request.requestId,
					ok: false,
					error: {
						code: 'mutation_authorization_required',
						message:
							'The desktop parent failed its live designated requirement.',
						retryable: false,
					},
				}),
				stderr: '',
				exitCode: 1,
			};
		});
		const client = new NativeHostClient({
			resourceDirectory: '/signed',
			appVersion: '0.1.0',
			runner,
			verifier: vi.fn(async () => verified),
		});
		const failure = await client
			.runSimulatorMutation(
				'{"protocolVersion":2,"requestId":"mutation-2","operation":"disk_cleanup","payload":{"simulatorId":"11111111-2222-3333-4444-555555555555"}}\n',
				{ timeoutMs: 660_000 }
			)
			.then(
				() => undefined,
				(error: unknown) => error
			);
		// A refused attestation must stay distinguishable from a helper that died
		// mid-operation; a bare Error threw that distinction away.
		expect(failure).toBeInstanceOf(NativeHostResponseError);
		expect(failure).toMatchObject({
			code: 'mutation_authorization_required',
			retryable: false,
			message: 'The desktop parent failed its live designated requirement.',
		});
	});

	it('uses bounded one-request processes and returns read-only native capabilities', async () => {
		const operations: string[] = [];
		const runner = vi.fn(async (_executable, args, options) => {
			expect(args).toEqual([]);
			const request = JSON.parse(options.stdin ?? '') as {
				requestId: string;
				operation: string;
				protocolVersion: number;
			};
			operations.push(`${request.protocolVersion}:${request.operation}`);
			const result =
				request.operation === 'handshake'
					? {
							helperVersion: '0.1.0',
							protocolVersion: request.protocolVersion,
							capabilities: {
								operations:
									request.protocolVersion === 3
										? [
												'handshake',
												'permission_status',
												'capability_status',
												'compose_image',
											]
										: ['handshake', 'permission_status', 'capability_status'],
								permissionInspection: true,
								permissionPrompting: false,
								simulatorMutation: false,
								runtimeDownloads: false,
								capabilityInspection: true,
								liveCaptureSessions: false,
								...(request.protocolVersion === 3
									? { imageComposition: true }
									: {}),
							},
						}
					: request.operation === 'permission_status'
						? {
								statuses: [
									{ id: 'accessibility', value: 'granted', canPrompt: false },
									{
										id: 'screen_recording',
										value: 'not_granted',
										canPrompt: false,
									},
								],
							}
						: capabilityStatusFixture;
			return {
				stdout: JSON.stringify({
					protocolVersion: request.protocolVersion,
					requestId: request.requestId,
					ok: true,
					result,
				}),
				stderr: '',
				exitCode: 0,
			};
		});
		const client = new NativeHostClient({
			resourceDirectory: '/signed',
			appVersion: '0.1.0',
			runner,
			verifier: vi.fn(async () => verified),
		});
		await expect(client.inspectPermissions()).resolves.toMatchObject({
			status: 'available',
			permissionInspection: true,
			permissionPrompting: false,
			capabilityInspection: true,
			liveCaptureSessions: false,
			imageComposition: true,
			permissions: [
				{ id: 'accessibility', value: 'granted', canPrompt: false },
				{ id: 'screen_recording', value: 'not_granted', canPrompt: false },
			],
			advanced: expect.objectContaining({
				screenCaptureKit: expect.objectContaining({
					liveWindowCapture: 'gated',
				}),
				networkExtension: expect.objectContaining({
					entitlementPresent: false,
				}),
			}),
		});
		expect(new Set(operations)).toEqual(
			new Set([
				'2:handshake',
				'3:handshake',
				'2:permission_status',
				'2:capability_status',
			])
		);
	});

	it('stages bounded inputs and commits a protocol-v3 composition without path disclosure', async () => {
		const temporaryDirectory = await mkdtemp(
			path.join(tmpdir(), 'native-composer-')
		);
		const workspaceDirectory = path.join(temporaryDirectory, 'workspaces');
		const sourcePath = path.join(temporaryDirectory, 'source.png');
		const outputPath = path.join(temporaryDirectory, 'result.png');
		await writeFile(sourcePath, Buffer.from('source'));
		try {
			const runner = vi.fn(async (_executable, args, options) => {
				expect(args).toEqual([]);
				const request = JSON.parse(options.stdin ?? '') as {
					protocolVersion: number;
					requestId: string;
					operation: string;
					payload: {
						workspaceToken: string;
						primaryInput: string;
						output: string;
					};
				};
				expect(request).toMatchObject({
					protocolVersion: 3,
					operation: 'compose_image',
					payload: { primaryInput: 'primary.png', output: 'output.png' },
				});
				expect(options.stdin).not.toContain(temporaryDirectory);
				const bytes = Buffer.from('rendered');
				await writeFile(
					path.join(
						workspaceDirectory,
						request.payload.workspaceToken,
						'outputs',
						request.payload.output
					),
					bytes
				);
				return {
					stdout: JSON.stringify({
						protocolVersion: 3,
						requestId: request.requestId,
						ok: true,
						result: {
							operation: 'compose_image',
							outputName: 'output.png',
							outputFormat: 'png',
							width: 1_290,
							height: 2_796,
							byteCount: bytes.byteLength,
							inputCount: 1,
							composition: 'single',
							metadataRendered: false,
							bezelStyle: 'none',
							atomicCommit: true,
						},
					}),
					stderr: '',
					exitCode: 0,
				};
			});
			const client = new NativeHostClient({
				resourceDirectory: '/signed',
				appVersion: '0.1.0',
				compositionWorkspaceDirectory: workspaceDirectory,
				runner,
				verifier: vi.fn(async () => verified),
			});
			await client.compose(
				{
					primaryPath: sourcePath,
					outputPath,
					recipe: {
						outputFormat: 'png',
						canvas: {
							size: { mode: 'pixels', width: 1_290, height: 2_796 },
							background: { kind: 'solid', color: '#000000' },
						},
						layout: {
							padding: { top: 80, right: 80, bottom: 80, left: 80 },
							contentMode: 'fit',
							rotation: 0,
							cornerRadius: 48,
							bezel: 'none',
						},
					},
				},
				new AbortController().signal
			);
			expect(await readFile(outputPath, 'utf8')).toBe('rendered');
			expect(runner).toHaveBeenCalledOnce();
		} finally {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}
	});
});

const capabilityStatusFixture = {
	checkedAtMilliseconds: 1_787_987_200_000,
	architecture: 'arm64',
	operatingSystemVersion: '26.0.0',
	screenCaptureKit: {
		frameworkAvailable: true,
		screenRecordingPermission: 'not_granted',
		liveWindowCapture: 'gated',
		systemAudioCapture: 'gated',
		microphoneCapture: 'gated',
		requestableFrameRates: [30, 60, 120],
		windowEnumerationPerformed: false,
		contentPickerPresented: false,
		persistentSessionOperationsExposed: false,
	},
	avFoundation: {
		frameworkAvailable: true,
		cameraPermission: 'not_determined',
		microphonePermission: 'denied',
		cameraDeviceAvailable: true,
		microphoneDeviceAvailable: true,
		cameraCapture: 'gated',
		microphoneCapture: 'gated',
		permissionRequestsPerformed: false,
	},
	videoToolbox: {
		frameworkAvailable: true,
		referenceWidth: 1920,
		referenceHeight: 1080,
		probeKind: 'hardware_realtime_configuration_acceptance',
		codecs: [
			{
				id: 'h264',
				hardwareEncodeSupported: true,
				hardwareDecodeSupported: true,
				sessionCreationStatus: 0,
				acceptedRealtimeConfigurationFrameRates: [30, 60],
			},
		],
		framesEncoded: 0,
	},
	accessibility: {
		frameworkAvailable: true,
		permission: 'granted',
		elementInspection: 'available',
		permissionPromptPerformed: false,
	},
	buildInsights: {
		fseventsFrameworkAvailable: true,
		currentEventID: '123',
		pathScopedObservation: 'available',
		protectedPathObservation: 'gated',
		requiresExplicitSourceRoots: true,
		fullDiskAccessPreflightAvailable: false,
		sourceRootsInspected: false,
		xcodeProcessesLaunched: false,
	},
	networkExtension: {
		frameworkAvailable: true,
		vpnManagerAPIAvailable: true,
		packetTunnelProviderAPIAvailable: true,
		appProxyProviderAPIAvailable: true,
		contentFilterAPIAvailable: true,
		entitlementPresent: false,
		configurationInspection: 'gated',
		trafficInterception: 'gated',
		preferenceReadsPerformed: false,
	},
	safety: {
		permissionPrompts: false,
		externalStateMutations: false,
		contentEnumerated: false,
		persistentSessions: false,
		networkPreferencesRead: false,
	},
} as const;
