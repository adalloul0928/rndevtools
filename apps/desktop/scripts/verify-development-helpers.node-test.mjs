import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyDevelopmentHelpers } from './verify-development-helpers.mjs';

function fixture(t) {
	const desktopDirectory = mkdtempSync(
		join(tmpdir(), 'rndevtools-dev-helpers-')
	);
	t.after(() => rmSync(desktopDirectory, { recursive: true, force: true }));
	return { desktopDirectory, platform: 'darwin', architecture: 'arm64' };
}

test('development checks native helpers before starting Electron', () => {
	const manifest = JSON.parse(
		readFileSync(new URL('../package.json', import.meta.url), 'utf8')
	);
	assert.match(
		manifest.scripts.dev,
		/node scripts\/verify-development-helpers\.mjs && electron-vite dev$/
	);
});

test('missing or unsupported helpers leave diagnostics available without launching a helper', (t) => {
	const options = fixture(t);
	options.run = () => assert.fail('must not spawn');
	assert.match(verifyDevelopmentHelpers(options), /not built/);
	assert.match(
		verifyDevelopmentHelpers({ ...options, platform: 'linux' }),
		/macOS/
	);
});

test('a stale or damaged manifest prevents execution and gives a rebuild command', (t) => {
	const options = fixture(t);
	mkdirSync(join(options.desktopDirectory, 'build/native/mac-arm64'), {
		recursive: true,
	});
	assert.throws(
		() =>
			verifyDevelopmentHelpers({
				...options,
				run: () => assert.fail('must not spawn'),
			}),
		/native:build/
	);
});

test('host version or capability failures prevent a development launch', (t) => {
	const options = fixture(t);
	mkdirSync(join(options.desktopDirectory, 'build/native/mac-arm64'), {
		recursive: true,
	});
	for (const result of [
		{ status: 1 },
		{ error: new Error('timeout') },
		{ status: 0, signal: 'SIGTERM' },
	]) {
		assert.throws(
			() =>
				verifyDevelopmentHelpers({
					...options,
					verify: () => {},
					run: () => result,
				}),
			/native:build/
		);
	}
});

test('verified resources also require a bounded read-only capability probe', (t) => {
	const options = fixture(t);
	const directory = join(options.desktopDirectory, 'build/native/mac-arm64');
	mkdirSync(directory, { recursive: true });
	const calls = [];
	assert.match(
		verifyDevelopmentHelpers({
			...options,
			verify: (path, identity) => calls.push([path, identity]),
			run: (command, args, config) => {
				assert.equal(command, process.execPath);
				assert.match(args[0], /verify-native-host-capabilities.mjs$/);
				assert.equal(args[1], join(directory, 'rndevtools-native-host'));
				assert.ok(config.timeout > 0 && config.maxBuffer > 0);
				return { status: 0 };
			},
		}),
		/Verified/
	);
	assert.deepEqual(calls, [[directory, { architecture: 'arm64' }]]);
});
