import { createHash } from 'node:crypto';
import {
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const manifestPath = new URL('./heroui-pro-integrity.json', import.meta.url);

/** Hash the hydrated payload; nested installer dependencies stay lockfile-owned. */
export function inspectHeroUiPayload(packageDirectory) {
	const root = realpathSync(packageDirectory);
	const files = {};
	let bytes = 0;
	let fileCount = 0;
	function visit(relative) {
		const full = path.join(root, relative);
		const stat = lstatSync(full);
		if (stat.isSymbolicLink())
			throw new Error(`HeroUI payload contains a symlink: ${relative}`);
		if (stat.isDirectory()) {
			for (const name of readdirSync(full).sort()) visit(`${relative}/${name}`);
			return;
		}
		bytes += stat.size;
		if (
			!stat.isFile() ||
			stat.size > 32 * 1024 * 1024 ||
			bytes > 128 * 1024 * 1024 ||
			++fileCount > 4096
		) {
			throw new Error('HeroUI payload exceeds its supported file bounds.');
		}
		files[relative] = createHash('sha256')
			.update(readFileSync(full))
			.digest('hex');
	}
	try {
		visit('package.json');
		visit('LICENSE');
		visit('dist');
	} catch (error) {
		if (error.code === 'ENOENT')
			throw new Error(
				'HeroUI Pro is not hydrated. Install with a licensed HEROUI_AUTH_TOKEN before building the renderer.'
			);
		throw error;
	}
	const metadata = JSON.parse(
		readFileSync(path.join(root, 'package.json'), 'utf8')
	);
	if (
		metadata.name !== '@heroui-pro/react' ||
		typeof metadata.version !== 'string' ||
		!files['dist/index.js']
	)
		throw new Error('Unrecognized HeroUI Pro payload.');
	return {
		schemaVersion: 1,
		package: metadata.name,
		version: metadata.version,
		files,
	};
}

export function verifyHeroUiPayload(packageDirectory, expected) {
	const actual = inspectHeroUiPayload(packageDirectory);
	if (
		expected.schemaVersion !== 1 ||
		actual.package !== expected.package ||
		actual.version !== expected.version
	)
		throw new Error(
			'HeroUI Pro payload version differs from its reviewed integrity manifest.'
		);
	const names = Object.keys(actual.files);
	if (
		names.length !== Object.keys(expected.files).length ||
		names.some((name) => actual.files[name] !== expected.files[name])
	)
		throw new Error(
			'HeroUI Pro payload differs from its reviewed integrity manifest. Review the licensed update before recording new hashes.'
		);
	return actual;
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	if (
		process.argv.length > 3 ||
		(process.argv[2] && process.argv[2] !== '--record')
	)
		throw new Error('Usage: node verify-heroui-pro.mjs [--record]');
	const directory = path.dirname(
		require.resolve('@heroui-pro/react/package.json')
	);
	if (process.argv[2] === '--record') {
		writeFileSync(
			manifestPath,
			`${JSON.stringify(inspectHeroUiPayload(directory), null, 2)}\n`
		);
		console.log(
			'Recorded HeroUI Pro payload hashes. Review this manifest change before committing.'
		);
	} else {
		const actual = verifyHeroUiPayload(
			directory,
			JSON.parse(readFileSync(manifestPath, 'utf8'))
		);
		console.log(
			`Verified HeroUI Pro ${actual.version}: ${Object.keys(actual.files).length} payload files.`
		);
	}
}
