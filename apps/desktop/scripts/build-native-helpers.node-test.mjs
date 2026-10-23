import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nativeHostVersionSource } from './native-host-version.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directories = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'rndevtools-build-guard-'));
	directories.push(root);
	mkdirSync(join(root, 'scripts'));
	for (const file of [
		'build-native-helpers.mjs',
		'native-host-version.mjs',
		'verify-vendored-simslim.mjs',
	])
		cpSync(join(source, 'scripts', file), join(root, 'scripts', file));
	cpSync(
		join(source, 'native/rndevtools-sim-helper'),
		join(root, 'native/rndevtools-sim-helper'),
		{ recursive: true }
	);
	const versionFile = join(
		root,
		'native/rndevtools-native-host/Sources/RNDevtoolsNativeHost/HelperVersion.swift'
	);
	mkdirSync(dirname(versionFile), { recursive: true });
	writeFileSync(versionFile, nativeHostVersionSource('0.1.0'));
	writeFileSync(
		join(root, 'package.json'),
		JSON.stringify({ version: '0.2.0' })
	);
	return {
		root,
		versionFile,
		script: join(root, 'scripts/build-native-helpers.mjs'),
	};
}

function run(input, platform, team, args = []) {
	return spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
		Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
		process.argv = ['node', ${JSON.stringify(input.script)}, ...${JSON.stringify(args)}];
		await import(${JSON.stringify(pathToFileURL(input.script).href)});
	`,
		],
		{
			cwd: input.root,
			encoding: 'utf8',
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				APPLE_TEAM_ID: team,
			},
			timeout: 10_000,
		}
	);
}

test('unsupported packaging returns before regenerating tracked native sources', () => {
	const input = fixture();
	const before = readFileSync(input.versionFile, 'utf8');
	const result = run(input, 'linux', '', ['--if-supported']);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Skipping macOS native helpers/);
	assert.equal(readFileSync(input.versionFile, 'utf8'), before);
});

for (const team of [
	'SHORT',
	'abcdefghij',
	'ABCDE12345 -X main.version=other',
]) {
	test(`rejects a malformed signing team before source writes: ${team}`, () => {
		const input = fixture();
		const before = readFileSync(input.versionFile, 'utf8');
		const result = run(input, 'darwin', team);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /APPLE_TEAM_ID must/);
		assert.equal(readFileSync(input.versionFile, 'utf8'), before);
	});
}
