import { createHash } from 'node:crypto';
import {
	chmod,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyAgentCli, verifySimulatorHelper } from './native-helper-trust';

const directories: string[] = [];

async function fixture() {
	const directory = await mkdtemp(path.join(tmpdir(), 'pumpd-helper-trust-'));
	directories.push(directory);
	const executable = path.join(directory, 'pumpd-sim-helper');
	const nativeHost = path.join(directory, 'pumpd-native-host');
	const cli = path.join(directory, 'pumpd-devtools');
	await writeFile(executable, 'simulator helper');
	await writeFile(nativeHost, 'native helper');
	await writeFile(cli, 'agent cli');
	await chmod(executable, 0o755);
	await chmod(nativeHost, 0o755);
	await chmod(cli, 0o755);
	const entry = (name: string, body: string) => ({
		name,
		file: name,
		sha256: createHash('sha256').update(body).digest('hex'),
		size: Buffer.byteLength(body),
	});
	const manifest = {
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
			simulator: entry('pumpd-sim-helper', 'simulator helper'),
			nativeHost: entry('pumpd-native-host', 'native helper'),
			cli: entry('pumpd-devtools', 'agent cli'),
		},
	};
	await writeFile(
		path.join(directory, 'manifest.json'),
		JSON.stringify(manifest)
	);
	return { directory, executable };
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true }))
	);
});

describe('native helper trust', () => {
	it('verifies manifest identity, digest, executable type, and signature', async () => {
		const { directory, executable } = await fixture();
		const canonicalExecutable = await realpath(executable);
		const signatureVerifier = vi.fn(async () => undefined);
		await expect(
			verifySimulatorHelper({
				resourceDirectory: directory,
				appVersion: '0.1.0',
				architecture: 'arm64',
				platform: 'darwin',
				signatureVerifier,
			})
		).resolves.toMatchObject({ executablePath: canonicalExecutable });
		expect(signatureVerifier).toHaveBeenCalledWith(canonicalExecutable);
	});

	it('independently verifies the bundled local agent CLI', async () => {
		const { directory } = await fixture();
		const canonicalCli = await realpath(path.join(directory, 'pumpd-devtools'));
		const signatureVerifier = vi.fn(async () => undefined);
		await expect(
			verifyAgentCli({
				resourceDirectory: directory,
				appVersion: '0.1.0',
				architecture: 'arm64',
				platform: 'darwin',
				signatureVerifier,
			})
		).resolves.toMatchObject({ executablePath: canonicalCli });
		expect(signatureVerifier).toHaveBeenCalledWith(canonicalCli);
	});

	it('rejects digest changes before invoking a helper', async () => {
		const { directory, executable } = await fixture();
		await writeFile(executable, 'changed helper');
		const signatureVerifier = vi.fn(async () => undefined);
		await expect(
			verifySimulatorHelper({
				resourceDirectory: directory,
				appVersion: '0.1.0',
				architecture: 'arm64',
				platform: 'darwin',
				signatureVerifier,
			})
		).rejects.toMatchObject({ kind: 'untrusted' });
		expect(signatureVerifier).not.toHaveBeenCalled();
	});

	it('rejects symbolic-link helper substitution', async () => {
		const { directory, executable } = await fixture();
		await rm(executable);
		await symlink('/usr/bin/true', executable);
		await expect(
			verifySimulatorHelper({
				resourceDirectory: directory,
				appVersion: '0.1.0',
				architecture: 'arm64',
				platform: 'darwin',
				signatureVerifier: async () => undefined,
			})
		).rejects.toMatchObject({ kind: 'untrusted' });
	});
});
