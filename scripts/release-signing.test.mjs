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

function job(name) {
	return workflow.split(`  ${name}:\n`)[1]?.split(/^ {2}[\w-]+:\n/m)[0];
}

test('package verification has no publishing identity or registry secret', () => {
	const verify = job('verify-packages');
	assert.ok(verify, 'Separate package verification job must exist');
	assert.doesNotMatch(verify, /id-token: write|secrets\.|NODE_AUTH_TOKEN/);
	assert.match(verify, /pnpm --dir packages\/core quality/);
	assert.match(verify, /pnpm --dir packages\/react-native quality/);
	assert.match(verify, /actions\/upload-artifact@/);
});

test('publishing only consumes checked tarballs without dependency execution', () => {
	const publish = job('publish-packages');
	assert.ok(publish);
	assert.match(publish, /needs: \[desktop-app, verify-packages\]/);
	assert.match(publish, /if: startsWith\(github.ref, 'refs\/tags\/v'\)/);
	assert.match(publish, /environment: release-signing/);
	assert.match(publish, /id-token: write/);
	assert.match(publish, /actions\/download-artifact@/);
	assert.match(publish, /sha256sum --check SHA256SUMS.txt/);
	assert.doesNotMatch(
		publish,
		/actions\/checkout|pnpm|npm install|NODE_AUTH_TOKEN|secrets\./,
	);
	assert.equal(
		(publish.match(/npm publish .* --ignore-scripts/g) ?? []).length,
		2,
	);
	const nodeVersion = readFileSync(
		new URL('../.nvmrc', import.meta.url),
		'utf8',
	).trim();
	assert.match(
		publish,
		new RegExp(`node-version: '${nodeVersion.replaceAll('.', '\\.')}'`),
	);
});

test('notarization receives a private key file instead of a password argument', () => {
	assert.doesNotMatch(
		workflow,
		/--password|secrets\.APPLE_APP_SPECIFIC_PASSWORD/,
	);
	assert.match(workflow, /secrets\.APPLE_API_KEY_P8/);
	assert.match(workflow, /node scripts\/store-notary-credentials\.mjs/);
});
