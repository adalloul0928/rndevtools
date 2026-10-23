import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import verify from './verify-native-resources.cjs';

const directories = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true });
});
function fixture(appVersion = '0.2.0', architecture = 'arm64') {
	const dir = mkdtempSync(path.join(tmpdir(), 'rndevtools-resource-identity-'));
	directories.push(dir);
	const helpers = {};
	for (const [key, name] of Object.entries({
		simulator: 'rndevtools-sim-helper',
		nativeHost: 'rndevtools-native-host',
		cli: 'rndevtools',
	})) {
		const bytes = Buffer.from(`fixture ${name}`);
		writeFileSync(path.join(dir, name), bytes, { mode: 0o755 });
		helpers[key] = {
			name,
			file: name,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			size: bytes.length,
		};
	}
	writeFileSync(
		path.join(dir, 'manifest.json'),
		JSON.stringify({
			schemaVersion: 1,
			platform: 'darwin',
			appVersion,
			architecture,
			buildCommit: 'a'.repeat(40),
			protocolVersion: 2,
			compatibilityMatrixVersion: '2026-09-03-v2',
			catalog: {
				version: 'simslim-v0.12.2-6518ba7e-rndevtools.1-presets.3',
				upstreamCommit: '6518ba7eab1123d7e1d7797b0e05f51043b42a5b',
				patchSet: 'rndevtools.1',
				upstreamSourceManifestSha256:
					'bbd7640e2738197be54564d9f9926710a0dc5e13ee674d6e00e48bd5714b6172',
				patchSha256:
					'99703cfc6fa2bddf360f364b115edd0f235df82282e3e809daff543641a472f0',
				vendoredSourceManifestSha256:
					'887daa4543b0aecaefbdd9c7edb6e46e00205fecaba254c09527579dc84175d2',
			},
			helpers,
		})
	);
	return dir;
}
const expected = { appVersion: '0.2.0', architecture: 'arm64' };
test('accepts matching native resources', () => {
	assert.equal(verify(fixture(), expected).appVersion, '0.2.0');
});
test('rejects stale native versions despite matching digests', () => {
	assert.throws(() => verify(fixture('0.1.0'), expected), /desktop build/);
});
test('rejects another target architecture despite matching digests', () => {
	assert.throws(
		() => verify(fixture('0.2.0', 'x64'), expected),
		/desktop build/
	);
});
