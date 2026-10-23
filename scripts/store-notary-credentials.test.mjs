import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { storeNotaryCredentials } from './store-notary-credentials.mjs';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = {
	APPLE_API_KEY_P8: key,
	APPLE_API_KEY_ID: 'EXAMPLE1234',
	APPLE_API_ISSUER: '00000000-0000-4000-8000-000000000001',
	APPLE_KEYCHAIN_PROFILE: 'test-profile',
	CSC_KEY_PASSWORD: 'fixture-secret',
	PATH: '/usr/bin',
};
for (const failure of [false, true]) {
	test(`notary private key stays out of argv/env and is removed after ${failure ? 'failure' : 'success'}`, () => {
		let keyPath;
		const run = (command, args, options) => {
			assert.equal(command, '/usr/bin/xcrun');
			keyPath = args[args.indexOf('--key') + 1];
			assert.equal(readFileSync(keyPath, 'utf8'), key);
			assert.equal(statSync(keyPath).mode & 0o777, 0o600);
			assert.equal(statSync(path.dirname(keyPath)).mode & 0o777, 0o700);
			assert.ok(!args.includes(key));
			assert.deepEqual(options.env, { PATH: '/usr/bin' });
			if (failure) throw new Error(key);
		};
		if (failure)
			assert.throws(
				() => storeNotaryCredentials({ env, run }),
				(error) =>
					!error.message.includes(key) &&
					/could not be stored/.test(error.message),
			);
		else storeNotaryCredentials({ env, run });
		assert.ok(keyPath);
		assert.equal(existsSync(keyPath), false);
	});
}
test('invalid credentials are rejected before a subprocess starts', () => {
	for (const update of [
		{ APPLE_API_KEY_P8: 'invalid' },
		{ APPLE_API_KEY_ID: '../key' },
		{ APPLE_API_ISSUER: 'invalid' },
	]) {
		assert.throws(
			() =>
				storeNotaryCredentials({
					env: { ...env, ...update },
					run: () => assert.fail('Must not run'),
				}),
			/Notarization/,
		);
	}
});
