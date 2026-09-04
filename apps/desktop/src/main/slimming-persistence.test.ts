import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SlimmingPersistence } from './slimming-persistence';

const UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const directories: string[] = [];

async function fixture() {
	const directory = await mkdtemp(path.join(tmpdir(), 'pumpd-slimming-store-'));
	directories.push(directory);
	return { directory, store: new SlimmingPersistence(directory) };
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

describe('slimming persistence', () => {
	it('atomically persists a restart-safe token while public snapshots omit it', async () => {
		const { directory, store } = await fixture();
		await store.load();
		await store.beginPendingMutation(UDID, {
			id: 'pending-1',
			actionId: 'action-1',
			operation: 'apply_profile',
			profileId: 'pumpd-development',
			startedAt: 1,
			checkpointToken: 'opaque-restart-safe-token',
			originalBootState: 'Booted',
			beforeServiceIds: [],
			desiredServiceIds: ['com.apple.feedbackd'],
			compatibilityKey: `compatibility-${'a'.repeat(64)}`,
			compatibilityStatus: 'unknown',
			matrixVersion: 'matrix-v1',
			tuple: {
				macOSBuild: '25F80',
				xcodeBuild: '17F113',
				coreSimulatorBuild: '1051.55',
				runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
				runtimeBuild: '23F77',
				hostArchitecture: 'arm64',
				helperVersion: '0.1.0',
				helperBuildCommit: 'b'.repeat(40),
				catalogVersion: 'catalog-v1',
			},
		});
		await store.resolvePendingMutation(UDID, 'pending-1', {
			kind: 'complete',
			checkpointMetadata: {
				id: 'checkpoint-1',
				createdAt: 1,
				sourceOperationId: 'operation-1',
				helperVersion: '0.1.0',
				catalogVersion: 'catalog-v1',
				compatibilityMatrixVersion: 'matrix-v1',
			},
			operation: {
				id: 'operation-1',
				actionId: 'action-1',
				kind: 'profile.apply',
				status: 'complete',
				startedAt: 1,
				finishedAt: 2,
				changed: true,
				condition: 'profile-match',
				message: 'Complete.',
			},
		});
		const filePath = path.join(directory, 'state-v1.json');
		expect((await stat(filePath)).mode & 0o777).toBe(0o600);
		expect(await readFile(filePath, 'utf8')).toContain('opaque-restart-safe-token');
		expect(JSON.stringify(store.snapshot())).not.toContain('opaque-restart-safe-token');

		const reloaded = new SlimmingPersistence(directory);
		await reloaded.load();
		expect(reloaded.checkpointToken(UDID)).toBe('opaque-restart-safe-token');
		expect(reloaded.snapshot().operationsBySimulator[UDID]).toHaveLength(1);
	});

	it('fails closed on malformed existing state instead of silently replacing it', async () => {
		const { directory, store } = await fixture();
		await writeFile(path.join(directory, 'state-v1.json'), '{"version":1,"bad":true}');
		await expect(store.load()).rejects.toThrow();
	});

	it('persists a bounded acknowledgement batch in one restart-safe update', async () => {
		const { directory, store } = await fixture();
		await store.load();
		const keys = [`compatibility-${'a'.repeat(64)}`, `compatibility-${'b'.repeat(64)}`];
		await store.acknowledgeAll(keys, 42);

		const reloaded = new SlimmingPersistence(directory);
		await reloaded.load();
		expect(keys.every((key) => reloaded.isAcknowledged(key))).toBe(true);
	});

	it('does not authorize an acknowledgement in memory when its atomic write fails', async () => {
		const { directory, store } = await fixture();
		await store.load();
		const key = `compatibility-${'c'.repeat(64)}`;
		await rm(directory, { recursive: true });
		await writeFile(directory, 'blocks recreation');

		await expect(store.acknowledge(key, 42)).rejects.toThrow();
		expect(store.isAcknowledged(key)).toBe(false);
	});
});
