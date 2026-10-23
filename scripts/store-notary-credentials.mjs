import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function storeNotaryCredentials({
	env = process.env,
	run = execFileSync,
	temporaryRoot = tmpdir(),
} = {}) {
	const key = env.APPLE_API_KEY_P8;
	const keyId = env.APPLE_API_KEY_ID;
	const issuer = env.APPLE_API_ISSUER;
	const profile = env.APPLE_KEYCHAIN_PROFILE;
	if (
		typeof key !== 'string' ||
		key.length > 16_384 ||
		!key.startsWith('-----BEGIN PRIVATE KEY-----') ||
		!/^[A-Z0-9]{10,20}$/.test(keyId ?? '') ||
		!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(issuer ?? '') ||
		!/^[A-Za-z0-9_-]{1,80}$/.test(profile ?? '')
	) {
		throw new Error(
			'Notarization requires a P8 private key, key ID, issuer UUID and keychain profile.',
		);
	}
	try {
		createPrivateKey(key);
	} catch {
		throw new Error('Notarization private key is not valid PEM.');
	}
	const directory = mkdtempSync(path.join(temporaryRoot, 'rndevtools-notary-'));
	const keyPath = path.join(directory, 'AuthKey.p8');
	try {
		writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
		const childEnvironment = {};
		for (const name of [
			'PATH',
			'HOME',
			'TMPDIR',
			'DEVELOPER_DIR',
			'LANG',
			'LC_ALL',
		]) {
			if (env[name]) childEnvironment[name] = env[name];
		}
		run(
			'/usr/bin/xcrun',
			[
				'notarytool',
				'store-credentials',
				profile,
				'--key',
				keyPath,
				'--key-id',
				keyId,
				'--issuer',
				issuer,
			],
			{
				env: childEnvironment,
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 60_000,
				maxBuffer: 1024 * 1024,
			},
		);
	} catch {
		// Tool output can contain credentials or key contents; keep it private.
		throw new Error(
			'Notarization credentials could not be stored. Verify the API key and Apple account access.',
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	storeNotaryCredentials();
}
