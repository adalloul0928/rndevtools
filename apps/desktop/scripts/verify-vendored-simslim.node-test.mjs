import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyVendoredSimSlim } from './verify-vendored-simslim.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceHelper = path.resolve(
	scriptDirectory,
	'..',
	'native',
	'rndevtools-sim-helper'
);
const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

test('accepts only the anchored reviewed SimSlim patch set', () => {
	assert.deepEqual(verifyVendoredSimSlim(sourceHelper), {
		upstreamVersion: 'v0.8.0',
		upstreamCommit: '09fc9cbbca35db5230e6d571a0a366fe6876266e',
		patchSet: 'pumpd.1',
		upstreamSourceManifestSha256:
			'8a7681f26eb84be6b5a84a1326973c35c1ba4320e27c706655d3eed8bd31af08',
		patchSha256:
			'69bef9b9d08e900652acb77fd13463f6bc5f8735df1aa994ba6be6d353146083',
		vendoredSourceManifestSha256:
			'b2045d5332b79e52875d592189f37de2c817c12a341cddbb75499f3085b0e4c7',
		files: 16,
	});
});

test('rejects source tampering even when the checksum manifest is unchanged', () => {
	const helper = copyFixture();
	const clonePath = path.join(
		helper,
		'vendor/github.com/mobai-app/simslim/clone.go'
	);
	writeFileSync(clonePath, `${readFileSync(clonePath, 'utf8')}\n// tampered\n`);
	assert.throws(
		() => verifyVendoredSimSlim(helper),
		/Vendored SimSlim source checksum mismatch/
	);
});

test('the anchored patch reverses the final tree to the anchored upstream base', () => {
	const root = mkdtempSync(
		path.join(tmpdir(), 'rndevtools-simslim-derivation-')
	);
	temporaryDirectories.push(root);
	const finalSource = path.join(
		sourceHelper,
		'vendor/github.com/mobai-app/simslim'
	);
	const reconstructedBase = path.join(root, 'simslim');
	cpSync(finalSource, reconstructedBase, { recursive: true });
	const patchPath = path.join(sourceHelper, 'PUMPD_PATCHSET_pumpd.1.patch');
	const result = spawnSync('git', ['apply', '--reverse', patchPath], {
		cwd: reconstructedBase,
		encoding: 'utf8',
	});
	assert.equal(result.status, 0, result.stderr);
	for (const line of readFileSync(
		path.join(sourceHelper, 'UPSTREAM_SOURCE_SHA256SUMS'),
		'utf8'
	)
		.trim()
		.split('\n')) {
		const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9_.-]+)$/.exec(line);
		assert.ok(match);
		const [, expected, file] = match;
		const actual = createHash('sha256')
			.update(readFileSync(path.join(reconstructedBase, file)))
			.digest('hex');
		assert.equal(actual, expected, file);
	}
});

test('rejects coordinated source and editable checksum-manifest tampering', () => {
	const helper = copyFixture();
	const clonePath = path.join(
		helper,
		'vendor/github.com/mobai-app/simslim/clone.go'
	);
	const checksumPath = path.join(helper, 'VENDORED_SOURCE_SHA256SUMS');
	writeFileSync(clonePath, `${readFileSync(clonePath, 'utf8')}\n// tampered\n`);
	writeFileSync(
		checksumPath,
		readFileSync(checksumPath, 'utf8').replace(
			/^[a-f0-9]{64}( {2}vendor\/github\.com\/mobai-app\/simslim\/clone\.go)$/m,
			`${'0'.repeat(64)}$1`
		)
	);
	assert.throws(
		() => verifyVendoredSimSlim(helper),
		/checksum manifest is not the reviewed pumpd\.1 manifest/
	);
});

function copyFixture() {
	const root = mkdtempSync(path.join(tmpdir(), 'rndevtools-vendored-simslim-'));
	temporaryDirectories.push(root);
	const helper = path.join(root, 'rndevtools-sim-helper');
	cpSync(sourceHelper, helper, { recursive: true });
	return helper;
}
