import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import verifyNativeResources from './verify-native-resources.cjs';

const scripts = dirname(fileURLToPath(import.meta.url));

export function verifyDevelopmentHelpers({
	platform = process.platform,
	architecture = process.arch,
	desktopDirectory = resolve(scripts, '..'),
	verify = verifyNativeResources,
	run = spawnSync,
} = {}) {
	if (platform !== 'darwin')
		return 'Native helpers are only available on macOS.';
	const directory = join(
		desktopDirectory,
		'build',
		'native',
		`mac-${architecture}`
	);
	try {
		lstatSync(directory);
	} catch (error) {
		if (error?.code === 'ENOENT') {
			return 'Native helpers are not built; Simulator tools remain unavailable. Run pnpm --filter @rndevtools/desktop native:build to enable them.';
		}
		throw error;
	}
	try {
		verify(directory, { architecture });
		const result = run(
			process.execPath,
			[
				join(scripts, 'verify-native-host-capabilities.mjs'),
				join(directory, 'rndevtools-native-host'),
			],
			{ encoding: 'utf8', timeout: 70_000, maxBuffer: 512 * 1024 }
		);
		if (result.error || result.status !== 0 || result.signal) {
			throw new Error(
				'The native host does not report the current version and capabilities.'
			);
		}
	} catch (error) {
		throw new Error(
			'Existing native helpers are stale or invalid. Run pnpm --filter @rndevtools/desktop native:build before starting development.',
			{ cause: error }
		);
	}
	return 'Verified existing development native helpers.';
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		process.stdout.write(`${verifyDevelopmentHelpers()}\n`);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	}
}
