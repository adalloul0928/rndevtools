import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
	new URL('../.github/workflows/release.yml', import.meta.url),
	'utf8',
);

test('signing requires a version tag and its protected environment', () => {
	const desktop = workflow.split('  desktop-app:\n')[1];
	assert.ok(desktop, 'Desktop release job must exist');
	assert.match(desktop, /^ {4}if: startsWith\(github.ref, 'refs\/tags\/v'\)$/m);
	assert.match(desktop, /^ {4}environment: release-signing$/m);
	assert.doesNotMatch(desktop, /^ {4}env:/m, 'No job-wide signing environment');
});

test('signing credentials cannot reach installation or verification steps', () => {
	let step;
	for (const line of workflow.split('\n')) {
		if (/^ {6}- /.test(line)) step = line.trim();
		if (!/secrets\.(APPLE_|MAC_CERTIFICATE)/.test(line)) continue;
		assert.equal(step, '- name: Build, sign, notarize and verify arm64 DMG');
	}
});
