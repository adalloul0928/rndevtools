import { describe, expect, it, vi } from 'vitest';
import {
	NativeHelperTrustError,
	type VerifiedSimulatorHelper,
} from './native-helper-trust';
import { NativeHostResponseError } from './native-host-client';
import { SimHelperClient } from './sim-helper-client';
import type { runSimulatorCommand } from './simulator-command-runner';

const UDID = '11111111-2222-3333-4444-555555555555';

function verified(): VerifiedSimulatorHelper {
	return {
		executablePath: '/signed/pumpd-sim-helper',
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
				patchSha256: '69bef9b9d08e900652acb77fd13463f6bc5f8735df1aa994ba6be6d353146083',
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
}

function handshakeResult() {
	return {
		helperVersion: '0.1.0',
		buildCommit: 'a'.repeat(40),
		protocolVersion: 2,
		platform: 'darwin',
		architecture: 'arm64',
		catalogVersion: 'simslim-v0.8.0-09fc9cbb-pumpd.1-presets.2',
		catalogSource: {
			repository: 'https://github.com/MobAI-App/simslim',
			commit: '09fc9cbbca35db5230e6d571a0a366fe6876266e',
			profilesSha256: 'd'.repeat(64),
			patchSet: 'pumpd.1',
			upstreamSourceManifestSha256:
				'8a7681f26eb84be6b5a84a1326973c35c1ba4320e27c706655d3eed8bd31af08',
			patchSha256: '69bef9b9d08e900652acb77fd13463f6bc5f8735df1aa994ba6be6d353146083',
			vendoredSourceManifestSha256:
				'b2045d5332b79e52875d592189f37de2c817c12a341cddbb75499f3085b0e4c7',
		},
		capabilities: {
			operations: [
				'handshake',
				'list_simulators',
				'clone_simulator',
				'disk_cleanup_plan',
				'disk_cleanup',
				'list_profiles',
				'simulator_status',
				'preview_profile',
				'verify_profile',
				'doctor',
				'prepare_mutation',
				'apply_profile',
				'restore_managed',
				'undo_last',
			],
			readOnlyAvailable: true,
			mutationMode: 'signed_broker_compatibility_gated_experimental',
			mutationSafety: 'Strict compatibility and rollback.',
			compatibilityMatrixVersion: '2026-09-03-v2',
			compatibilityStates: ['verified', 'limited', 'unknown', 'blocked'],
			verifiedMutationTuples: 0,
			checkpointTokenMaxBytes: 32_768,
			runtimeDownloads: false,
		},
	};
}

describe('sim helper client', () => {
	it('reserves operation-specific primary and independent cleanup budgets', async () => {
		const expected = [
			{
				operation: 'clone_simulator',
				brokered: true,
				run: (client: SimHelperClient) => client.cloneSimulator(UDID, 'Clone'),
				timeoutMs: 32 * 60_000,
				forceKillDelayMs: 21 * 60_000,
			},
			{
				operation: 'disk_cleanup',
				brokered: true,
				run: (client: SimHelperClient) => client.cleanDisk(UDID, ['caches']),
				timeoutMs: 11 * 60_000,
				forceKillDelayMs: 11 * 60_000,
			},
			{
				operation: 'verify_profile',
				brokered: false,
				run: (client: SimHelperClient) => client.verifyProfile(UDID, 'profile'),
				timeoutMs: 12 * 60_000,
				forceKillDelayMs: 11 * 60_000,
			},
			{
				operation: 'apply_profile',
				brokered: true,
				run: (client: SimHelperClient) =>
					client.applyProfile(UDID, 'profile', 'checkpoint', 'EXPERIMENTAL'),
				timeoutMs: 31 * 60_000,
				forceKillDelayMs: 31 * 60_000,
			},
		] as const;

		for (const candidate of expected) {
			const runner = vi.fn(async (..._args: Parameters<typeof runSimulatorCommand>) => {
				throw new Error('stop after option capture');
			});
			const mutationBroker = {
				runSimulatorMutation: vi.fn(
					async (
						_input: string,
						_options: {
							timeoutMs: number;
							forceKillDelayMs?: number;
							signal?: AbortSignal;
						}
					) => {
						throw new Error('stop after broker option capture');
					}
				),
			};
			const client = new SimHelperClient({
				resourceDirectory: '/signed',
				appVersion: '0.1.0',
				runner,
				trustVerifier: vi.fn(async () => verified()),
				mutationBroker,
			});
			await expect(candidate.run(client)).rejects.toBeDefined();
			const input = candidate.brokered
				? mutationBroker.runSimulatorMutation.mock.calls[0]?.[0]
				: runner.mock.calls[0]?.[2]?.stdin;
			const options = candidate.brokered
				? mutationBroker.runSimulatorMutation.mock.calls[0]?.[1]
				: runner.mock.calls[0]?.[2];
			expect(JSON.parse(input ?? '{}')).toMatchObject({
				operation: candidate.operation,
			});
			expect(options).toMatchObject({
				timeoutMs: candidate.timeoutMs,
				forceKillDelayMs: candidate.forceKillDelayMs,
			});
		}
	});

	it('uses only the pinned disk-plan categories and exact cleanup selection', async () => {
		const runner = vi.fn(async (_executable, _args, options) => {
			const request = JSON.parse(options.stdin ?? '') as {
				requestId: string;
				operation: string;
				payload: Record<string, unknown>;
			};
			const result =
				request.operation === 'disk_cleanup_plan'
					? {
							simulatorId: UDID,
							totalBytes: 8_192,
							cleanableBytes: 4_096,
							categories: [
								{
									id: 'caches',
									name: 'System & App Caches',
									description: 'Generated caches.',
									downside: 'Next launches may be slower.',
									recovery: 'Caches are rebuilt.',
									risk: 'Lower risk',
									defaultSelected: true,
									canClean: true,
									bytes: 4_096,
									targets: 2,
								},
							],
							storage: [
								{
									id: 'documents',
									name: 'Documents',
									description: 'Durable documents.',
									bytes: 2_048,
								},
							],
						}
					: {
							simulatorId: UDID,
							categoryIds: ['caches'],
							beforeBytes: 4_096,
							afterBytes: 1_024,
							reclaimedBytes: 3_072,
							wasBooted: true,
							bootStateRestored: true,
						};
			return {
				stdout: JSON.stringify({
					protocolVersion: 2,
					requestId: request.requestId,
					ok: true,
					result,
				}),
				stderr: '',
				exitCode: 0,
			};
		});
		const mutationBroker = {
			runSimulatorMutation: vi.fn(async (input: string) => {
				const request = JSON.parse(input) as { requestId: string };
				return JSON.stringify({
					protocolVersion: 2,
					requestId: request.requestId,
					ok: true,
					result: {
						simulatorId: UDID,
						categoryIds: ['caches'],
						beforeBytes: 4_096,
						afterBytes: 1_024,
						reclaimedBytes: 3_072,
						wasBooted: true,
						bootStateRestored: true,
					},
				});
			}),
		};
		const client = new SimHelperClient({
			resourceDirectory: '/signed',
			appVersion: '0.1.0',
			runner,
			trustVerifier: vi.fn(async () => verified()),
			mutationBroker,
		});
		await expect(client.planDiskCleanup(UDID)).resolves.toMatchObject({
			simulatorId: UDID,
			categories: [{ id: 'caches', canClean: true }],
		});
		await expect(client.cleanDisk(UDID, ['caches'])).resolves.toMatchObject({
			reclaimedBytes: 3_072,
			bootStateRestored: true,
		});
		const cleanupRequest = JSON.parse(
			mutationBroker.runSimulatorMutation.mock.calls[0]?.[0] ?? '{}'
		) as {
			payload: unknown;
		};
		expect(cleanupRequest.payload).toEqual({
			simulatorId: UDID,
			categoryIds: ['caches'],
			confirmation: 'CLEAN_SIMULATOR_DISK',
		});
		await expect(client.cleanDisk(UDID, ['caches', 'caches'])).rejects.toBeDefined();
		expect(runner).toHaveBeenCalledOnce();
		expect(mutationBroker.runSimulatorMutation).toHaveBeenCalledOnce();
	});

	it('surfaces the native host code and reason when the broker refuses a mutation', async () => {
		const runner = vi.fn(async () => {
			throw new Error('the direct read-only runner must not carry a mutation');
		});
		const mutationBroker = {
			runSimulatorMutation: vi.fn(async () => {
				throw new NativeHostResponseError(
					'mutation_authorization_required',
					'The desktop parent is not a production-signed PUMPD application.',
					false
				);
			}),
		};
		const client = new SimHelperClient({
			resourceDirectory: '/signed',
			appVersion: '0.1.0',
			runner,
			trustVerifier: vi.fn(async () => verified()),
			mutationBroker,
		});
		await expect(client.cleanDisk(UDID, ['caches'])).rejects.toMatchObject({
			code: 'helper_process_failed',
			message: expect.stringMatching(
				/native host mutation_authorization_required.*not a production-signed PUMPD application/
			),
		});
		expect(runner).not.toHaveBeenCalled();
	});

	it('preserves the helper denial code and reason returned through the broker', async () => {
		const runner = vi.fn(async () => {
			throw new Error('the direct read-only runner must not carry a mutation');
		});
		const reason =
			"The helper's parent is not an authenticated PUMPD mutation broker: verify live broker signature: static codesign requirement bound to live cdhash failed";
		const mutationBroker = {
			runSimulatorMutation: vi.fn(async (input: string) => {
				const request = JSON.parse(input) as { requestId: string };
				return JSON.stringify({
					protocolVersion: 2,
					requestId: request.requestId,
					ok: false,
					error: {
						code: 'mutation_authorization_required',
						message: reason,
						retryable: false,
					},
				});
			}),
		};
		const client = new SimHelperClient({
			resourceDirectory: '/signed',
			appVersion: '0.1.0',
			runner,
			trustVerifier: vi.fn(async () => verified()),
			mutationBroker,
		});
		await expect(client.cleanDisk(UDID, ['caches'])).rejects.toMatchObject({
			code: 'mutation_authorization_required',
			message: reason,
		});
	});

	it('requires deterministic doctor blocker arrays at the helper boundary', async () => {
		let blockedByServiceIds: string[] | null = [];
		const runner = vi.fn(async (_executable, _args, options) => {
			const request = JSON.parse(options.stdin ?? '') as {
				requestId: string;
				payload: { simulatorId: string; requiredCapabilities: string[] };
			};
			return {
				stdout: JSON.stringify({
					protocolVersion: 2,
					requestId: request.requestId,
					ok: true,
					result: {
						simulatorId: request.payload.simulatorId,
						healthy: true,
						managedDisabledServiceIds: [],
						capabilities: [
							{
								id: request.payload.requiredCapabilities[0],
								available: true,
								blockedByServiceIds,
							},
						],
					},
				}),
				stderr: '',
				exitCode: 0,
			};
		});
		const client = new SimHelperClient({
			resourceDirectory: '/signed',
			appVersion: '0.1.0',
			runner,
			trustVerifier: vi.fn(async () => verified()),
		});

		await expect(client.doctor(UDID, ['storekit'])).resolves.toMatchObject({
			capabilities: [{ id: 'storekit', blockedByServiceIds: [] }],
		});
		blockedByServiceIds = null;
		await expect(client.doctor(UDID, ['storekit'])).rejects.toBeDefined();
	});

	it('sends only an exact UDID and bounded name to the clone adapter', async () => {
		const runner = vi.fn();
		const mutationBroker = {
			runSimulatorMutation: vi.fn(async (input: string) => {
				const request = JSON.parse(input) as {
					requestId: string;
					operation: string;
					payload: unknown;
				};
				expect(request).toMatchObject({
					operation: 'clone_simulator',
					payload: { simulatorId: UDID, name: 'PUMPD Clone' },
				});
				return JSON.stringify({
					protocolVersion: 2,
					requestId: request.requestId,
					ok: true,
					result: {
						sourceSimulatorId: UDID,
						simulatorId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
						name: 'PUMPD Clone',
					},
				});
			}),
		};
		const client = new SimHelperClient({
			resourceDirectory: '/signed',
			appVersion: '0.1.0',
			runner,
			trustVerifier: vi.fn(async () => verified()),
			mutationBroker,
		});
		await expect(client.cloneSimulator(UDID, ' PUMPD Clone ')).resolves.toEqual({
			sourceSimulatorId: UDID,
			simulatorId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
			name: 'PUMPD Clone',
		});
		await expect(
			client.cloneSimulator('booted; rm -rf /', 'Unsafe')
		).rejects.toBeDefined();
		expect(runner).not.toHaveBeenCalled();
		expect(mutationBroker.runSimulatorMutation).toHaveBeenCalledOnce();
	});

	it('fails closed when a mutation broker is unavailable without spawning the helper', async () => {
		const runner = vi.fn();
		const client = new SimHelperClient({
			resourceDirectory: '/signed',
			appVersion: '0.1.0',
			runner,
			trustVerifier: vi.fn(async () => verified()),
		});
		await expect(client.cleanDisk(UDID, ['caches'])).rejects.toMatchObject({
			code: 'mutation_broker_unavailable',
		});
		expect(runner).not.toHaveBeenCalled();
	});

	it('verifies once and binds a strict one-request handshake to its response ID', async () => {
		const verifier = vi.fn(async () => verified());
		const runner = vi.fn(async (executable, args, options) => {
			expect(executable).toBe('/signed/pumpd-sim-helper');
			expect(args).toEqual([]);
			const request = JSON.parse(options.stdin ?? '') as {
				protocolVersion: number;
				requestId: string;
				operation: string;
				payload: unknown;
			};
			expect(request).toMatchObject({
				protocolVersion: 2,
				operation: 'handshake',
				payload: {},
			});
			return {
				stdout: JSON.stringify({
					protocolVersion: 2,
					requestId: request.requestId,
					ok: true,
					result: handshakeResult(),
				}),
				stderr: '',
				exitCode: 0,
			};
		});
		const client = new SimHelperClient({
			resourceDirectory: '/signed',
			appVersion: '0.1.0',
			runner,
			trustVerifier: verifier,
		});
		await expect(client.handshake()).resolves.toMatchObject({
			helperVersion: '0.1.0',
			catalogVersion: 'simslim-v0.8.0-09fc9cbb-pumpd.1-presets.2',
		});
		expect(verifier).toHaveBeenCalledTimes(1);
	});

	it('rejects a handshake that disagrees with the verified package manifest', async () => {
		const runner = vi.fn(async (_executable, _args, options) => {
			const request = JSON.parse(options.stdin ?? '') as { requestId: string };
			return {
				stdout: JSON.stringify({
					protocolVersion: 2,
					requestId: request.requestId,
					ok: true,
					result: { ...handshakeResult(), helperVersion: 'different' },
				}),
				stderr: '',
				exitCode: 0,
			};
		});
		const client = new SimHelperClient({
			resourceDirectory: '/signed',
			appVersion: '0.1.0',
			runner,
			trustVerifier: vi.fn(async () => verified()),
		});
		await expect(client.handshake()).rejects.toBeInstanceOf(NativeHelperTrustError);
	});
});
