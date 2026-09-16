#!/usr/bin/env node
/**
 * Asserts that a production bundle contains no devtools code.
 *
 * `withDevtoolsPruning` cuts the module graph, but a new import added months
 * later can quietly reconnect it. Running this over an exported bundle turns
 * that regression into a build failure instead of a shipped diagnostic panel.
 *
 * Usage:
 *   npx rndevtools-verify-bundle <bundle-directory> [--marker "Extra String"]
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Strings that only appear when devtools code is present. These are panel
 * copy and internal identifiers, not import specifiers, because a bundler
 * rewrites specifiers but keeps string literals intact.
 */
export const DEFAULT_MARKERS = Object.freeze([
	'@rndevtools/core',
	'packages/core/src',
	'DebugCameraFixtureError',
	'rndevtools-debug-camera-',
	'rndevtools-restore-points',
	'rndevtools-scenarios',
	'Registered application storage adapters',
]);

async function javascriptFiles(root) {
	const files = [];
	for (const entry of await readdir(root)) {
		const absolute = path.join(root, entry);
		const details = await stat(absolute);
		if (details.isDirectory()) files.push(...(await javascriptFiles(absolute)));
		else if (/\.(?:js|hbc)$/.test(entry)) files.push(absolute);
	}
	return files;
}

/**
 * @param {string} root Directory holding an exported bundle.
 * @param {readonly string[]} markers Strings that must not appear.
 * @throws when any marker is found, naming every file and marker.
 */
export async function verifyPrunedBundle(root, markers = DEFAULT_MARKERS) {
	const violations = [];
	for (const file of await javascriptFiles(root)) {
		const contents = await readFile(file, 'utf8');
		for (const marker of markers) {
			if (contents.includes(marker)) violations.push({ file, marker });
		}
	}
	if (violations.length) {
		throw new Error(
			`Production bundle contains devtools code:\n${violations
				.map(({ file, marker }) => `${file}: ${marker}`)
				.join('\n')}`
		);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [, , root, ...rest] = process.argv;
	if (!root) {
		throw new Error(
			'Usage: rndevtools-verify-bundle <bundle-directory> [--marker "Extra String"]'
		);
	}
	const extra = [];
	for (let index = 0; index < rest.length; index += 1) {
		if (rest[index] === '--marker' && rest[index + 1]) {
			extra.push(rest[index + 1]);
			index += 1;
		}
	}
	await verifyPrunedBundle(path.resolve(root), [...DEFAULT_MARKERS, ...extra]);
	console.log(`No devtools markers found in ${root}`);
}
