import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import afterPack from './after-pack.cjs';

const previous = process.env.CSC_IDENTITY_AUTO_DISCOVERY;
afterEach(() => {
	if (previous === undefined) delete process.env.CSC_IDENTITY_AUTO_DISCOVERY;
	else process.env.CSC_IDENTITY_AUTO_DISCOVERY = previous;
});

function context(identity) {
	return {
		packager: {
			platformSpecificBuildOptions: {
				hardenedRuntime: true,
				entitlements: 'build/entitlements.mac.plist',
			},
			codeSigningInfo: { value: Promise.resolve({ keychainFile: null }) },
			helper: {
				findSigningIdentity: async (_mas, _development, requested) =>
					identity ?? (requested === '-' ? { name: '-' } : null),
			},
		},
	};
}

test('local ad-hoc app and helpers disable team-based library validation', async () => {
	process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
	const input = context(null);
	const signing = await afterPack.resolveNativeSigning(input);
	assert.equal(signing.localAdHoc, true);
	assert.equal(signing.hardenedRuntime, false);
	assert.equal(signing.config.hardenedRuntime, false);
	assert.equal(
		input.packager.platformSpecificBuildOptions.hardenedRuntime,
		true
	);
});

test('Developer ID signing retains hardened runtime and its configured entitlements', async () => {
	delete process.env.CSC_IDENTITY_AUTO_DISCOVERY;
	const input = context({
		name: 'Developer ID Application: Example Team (ABCDE12345)',
		hash: 'example',
	});
	const signing = await afterPack.resolveNativeSigning(input);
	assert.equal(signing.localAdHoc, false);
	assert.equal(signing.hardenedRuntime, true);
	assert.equal(signing.config, input.packager.platformSpecificBuildOptions);
});
