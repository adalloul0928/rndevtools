#!/usr/bin/env node
/**
 * Proves the release bundle is pruned, and that the proof can fail.
 *
 * First it exports the iOS and Android release bundles the way a store build
 * does (production, minified, Hermes bytecode) with no app variable set,
 * because a release build must be pruned without being told to, and runs
 * `rndevtools-verify-bundle` over them: it must pass. Then it exports the
 * Android release bundle again with `RNDEVTOOLS_DEMO_KEEP_DEVTOOLS=1`, which
 * `metro.config.js` turns into `keepInReleaseBundles: true`, the one way to
 * keep devtools in a release bundle, and runs the verifier again: it must
 * fail and name a devtools marker. Without that second run, a verifier that
 * finds nothing would pass the first.
 *
 * It complements `verify-prune-seam.mjs`, which is fast enough for every
 * change; this one takes the time of two exports and runs in CI.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const expo = require.resolve('expo/bin/cli');
const verifier = require.resolve('@rndevtools/react-native/verify-bundle');
const { DEFAULT_MARKERS } = await import(pathToFileURL(verifier).href);

// Read only by this app's metro.config.js. The release run must not inherit
// it from the shell, or the first export would silently keep devtools too.
const KEEP_DEVTOOLS = 'RNDEVTOOLS_DEMO_KEEP_DEVTOOLS';
const { [KEEP_DEVTOOLS]: _ignored, ...releaseEnv } = process.env;

// Throws instead of exiting, so the temporary export below is removed on every
// path, the failing ones included.
function fail(message) {
	throw new Error(message);
}

function exportBundle(outputDir, platforms, env) {
	const result = spawnSync(
		process.execPath,
		[
			expo,
			'export',
			...platforms.flatMap((platform) => ['--platform', platform]),
			'--output-dir',
			outputDir,
		],
		{ cwd: projectRoot, env, stdio: 'inherit' },
	);
	if (result.status !== 0) {
		fail(`expo export ${platforms.join(' ')} failed (${result.status ?? result.error?.message}).`);
	}
}

function verifyBundle(outputDir) {
	return spawnSync(process.execPath, [verifier, outputDir], {
		cwd: projectRoot,
		env: releaseEnv,
		encoding: 'utf8',
	});
}

function run() {
	// 1. The guarantee: a release export, with nothing set, is clean.
	const release = path.join(projectRoot, 'build');
	exportBundle(release, ['ios', 'android'], releaseEnv);
	const clean = verifyBundle(release);
	if (clean.status !== 0) {
		fail(`The release bundle failed verification:\n${clean.stderr}`);
	}
	console.log(clean.stdout.trim());

	// 2. The control: the same pipeline with devtools kept must fail the verifier,
	// naming a marker. One platform is enough; the seam does not depend on it.
	const unpruned = mkdtempSync(path.join(os.tmpdir(), 'rndevtools-demo-unpruned-'));
	try {
		exportBundle(unpruned, ['android'], { ...releaseEnv, [KEEP_DEVTOOLS]: '1' });
		const dirty = verifyBundle(unpruned);
		if (dirty.status === 0) {
			fail(
				'The verifier passed a release bundle that keeps its devtools, so a clean result proves nothing.',
			);
		}
		const named = DEFAULT_MARKERS.filter((marker) => dirty.stderr.includes(`: ${marker}`));
		if (!dirty.stderr.includes('Production bundle contains devtools code:') || named.length === 0) {
			fail(`The verifier failed on the unpruned bundle for another reason:\n${dirty.stderr}`);
		}
		console.log(
			`Verified the check can fail: with ${KEEP_DEVTOOLS}=1 the verifier named ${named.length} marker(s): ${named.join(', ')}.`,
		);
	} finally {
		rmSync(unpruned, { recursive: true, force: true });
	}
}

try {
	run();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
