const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const afterPack = require('./after-pack.cjs');
const verifyNativeResources = require('./verify-native-resources.cjs');

const { buildNativeCodeSignArguments } = afterPack;
const { refreshNativeResourceManifest } = verifyNativeResources;
const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

test('refreshes helper digests only after the source manifest was verified', () => {
	const directory = createFixture();
	const verifiedManifest = verifyNativeResources(directory);
	const helperPath = path.join(directory, 'pumpd-sim-helper');
	writeFileSync(
		helperPath,
		Buffer.concat([readFileSync(helperPath), Buffer.from('-signed')])
	);

	assert.throws(
		() => verifyNativeResources(directory),
		/does not match its integrity manifest/
	);
	assert.throws(
		() => refreshNativeResourceManifest(directory),
		/requires the exact previously verified manifest/
	);

	const refreshed = refreshNativeResourceManifest(directory, verifiedManifest);
	assert.notEqual(
		refreshed.helpers.simulator.sha256,
		verifiedManifest.helpers.simulator.sha256
	);
	assert.deepEqual(verifyNativeResources(directory), refreshed);
});

test('rejects helper substitutions even when the manifest names are changed', () => {
	const directory = createFixture();
	const manifestPath = path.join(directory, 'manifest.json');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	manifest.helpers.simulator.name = 'pumpd-native-host';
	manifest.helpers.simulator.file = 'pumpd-native-host';
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

	assert.throws(() => verifyNativeResources(directory), /missing simulator/);
});

test('rejects symlinked helper resources', () => {
	const directory = createFixture();
	const helperPath = path.join(directory, 'pumpd-native-host');
	const replacementPath = path.join(directory, 'replacement');
	writeFileSync(replacementPath, 'replacement', { mode: 0o755 });
	unlinkSync(helperPath);
	symlinkSync(replacementPath, helperPath);

	assert.throws(
		() => verifyNativeResources(directory),
		/not a regular executable file/
	);
});

test('constructs bounded helper signing arguments without shell evaluation', () => {
	assert.deepEqual(
		buildNativeCodeSignArguments('/Applications/PUMPD/helper', {
			identity: '0123456789ABCDEF',
			keychainFile: '/tmp/build.keychain',
			hardenedRuntime: true,
			timestamp: 'https://timestamp.apple.com/ts01',
		}),
		[
			'--force',
			'--sign',
			'0123456789ABCDEF',
			'--identifier',
			'helper',
			'--keychain',
			'/tmp/build.keychain',
			'--options',
			'runtime',
			'--timestamp=https://timestamp.apple.com/ts01',
			'/Applications/PUMPD/helper',
		]
	);
	assert.deepEqual(
		buildNativeCodeSignArguments('/tmp/helper', {
			identity: '-',
			keychainFile: null,
			hardenedRuntime: false,
			timestamp: 'none',
		}),
		[
			'--force',
			'--sign',
			'-',
			'--identifier',
			'helper',
			'--timestamp=none',
			'/tmp/helper',
		]
	);
});

function createFixture() {
	const directory = mkdtempSync(path.join(tmpdir(), 'pumpd-native-manifest-'));
	temporaryDirectories.push(directory);
	const helperDefinitions = {
		simulator: 'pumpd-sim-helper',
		nativeHost: 'pumpd-native-host',
		cli: 'pumpd-devtools',
	};
	const helpers = {};
	for (const [key, file] of Object.entries(helperDefinitions)) {
		const helperPath = path.join(directory, file);
		writeFileSync(helperPath, `${key}-bytes`, { mode: 0o755 });
		chmodSync(helperPath, 0o755);
		const data = readFileSync(helperPath);
		helpers[key] = {
			name: file,
			file,
			sha256: createHash('sha256').update(data).digest('hex'),
			size: data.length,
		};
	}
	writeFileSync(
		path.join(directory, 'manifest.json'),
		`${JSON.stringify(
			{
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
				helpers,
			},
			null,
			2
		)}\n`
	);
	return directory;
}
