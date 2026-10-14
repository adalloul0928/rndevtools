const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Expo build cache provider that shares native builds across git worktrees on
 * one machine.
 *
 * Lanes run several worktrees of the same app side by side, each on its own
 * Simulator. Every worktree would otherwise run its own `expo run:ios`, and
 * for the same native fingerprint that is the same twenty-minute build, N
 * times, in parallel. This provider stores the finished binary once under the
 * user's cache directory, keyed by Expo's fingerprint hash, and hands it back
 * to any other worktree whose fingerprint matches. A JavaScript-only change
 * leaves the fingerprint untouched, so a new branch of the same native shell
 * is installed in seconds instead of built.
 *
 * Expo computes the fingerprint (`@expo/fingerprint`) and calls this plugin
 * from `expo run:ios` / `expo run:android` for Simulator and emulator builds:
 *
 *   resolveBuildCache  → return a cached `.app` / `.apk` path, or null to build
 *   uploadBuildCache   → copy the fresh binary into the cache
 *
 * Concurrency: the first worktree to miss claims a lock file for the entry and
 * builds; later worktrees with the same fingerprint wait for it rather than
 * building a duplicate. A lock whose owner process has died is reclaimed.
 *
 * Wire it up in `app.config.js` (plugins must be loaded by Node, so a static
 * `app.json` cannot reference one):
 *
 *   module.exports = ({ config }) => ({
 *     ...config,
 *     experiments: {
 *       ...config.experiments,
 *       buildCacheProvider: {
 *         plugin: '@rndevtools/react-native/build-cache',
 *         // options: { cacheDirectory: '~/Library/Caches/my-app/native' },
 *       },
 *     },
 *   });
 *
 * Nothing here is app-specific: the cache root is a neutral default under
 * `~/Library/Caches/rndevtools` (or `$XDG_CACHE_HOME`), overridable per
 * project, and entries are namespaced by platform, configuration, and the
 * fingerprint hash Expo already computed from the project's own inputs.
 */

const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60 * 1_000;
const LOCK_POLL_INTERVAL_MS = 1_000;
const LOCK_FILE = 'build.lock';
const ARTIFACT_FILE = 'artifact.json';

function defaultCacheRoot(env = process.env, homedir = os.homedir()) {
	if (env.RNDEVTOOLS_BUILD_CACHE_DIR) return env.RNDEVTOOLS_BUILD_CACHE_DIR;
	const base =
		process.platform === 'darwin'
			? path.join(homedir, 'Library', 'Caches')
			: env.XDG_CACHE_HOME || path.join(homedir, '.cache');
	return path.join(base, 'rndevtools', 'native');
}

function expandHome(value, homedir = os.homedir()) {
	return value.replace(/^~(?=$|\/)/, homedir);
}

/** A single path segment that cannot escape the entry directory. */
function safeSegment(value, fallback = 'default') {
	const text = String(value ?? '').replace(/[^a-zA-Z0-9._-]+/g, '-');
	const trimmed = text.replace(/^[.-]+/, '').slice(0, 96);
	return trimmed || fallback;
}

function configurationOf(runOptions = {}) {
	// iOS uses `configuration` (Debug/Release); Android uses `variant` (debug).
	return runOptions.configuration || runOptions.variant || 'Debug';
}

/**
 * Directory for one cache entry. Expo's fingerprint already covers native
 * inputs; the platform and configuration are split out so a Release build is
 * never handed to a Debug run of the same fingerprint.
 */
function entryDirectory(context, options = {}) {
	if (!context || typeof context.fingerprintHash !== 'string') {
		throw new TypeError('build-cache: a fingerprintHash is required.');
	}
	const root = options.cacheDirectory
		? path.resolve(expandHome(options.cacheDirectory))
		: defaultCacheRoot();
	return path.join(
		root,
		safeSegment(context.platform, 'unknown-platform'),
		safeSegment(configurationOf(context.runOptions)),
		safeSegment(context.fingerprintHash, 'no-fingerprint'),
	);
}

function expectedArtifactExtension(platform) {
	return platform === 'android' ? '.apk' : '.app';
}

function readArtifact(entry) {
	try {
		const metadata = JSON.parse(
			fs.readFileSync(path.join(entry, ARTIFACT_FILE), 'utf8'),
		);
		if (typeof metadata.artifact !== 'string') return null;
		// The recorded name is a bare file name; refuse anything else.
		if (metadata.artifact !== path.basename(metadata.artifact)) return null;
		const artifactPath = path.join(entry, metadata.artifact);
		const stat = fs.statSync(artifactPath);
		if (artifactPath.endsWith('.app') && !stat.isDirectory()) return null;
		if (artifactPath.endsWith('.apk') && !stat.isFile()) return null;
		return artifactPath;
	} catch {
		return null;
	}
}

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return error && error.code === 'EPERM';
	}
}

function readLockOwner(lockPath) {
	try {
		return Number(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid);
	} catch {
		return 0;
	}
}

function tryClaimLock(lockPath) {
	try {
		const handle = fs.openSync(lockPath, 'wx');
		fs.writeFileSync(
			handle,
			`${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`,
		);
		fs.closeSync(handle);
		return true;
	} catch (error) {
		if (error && error.code === 'EEXIST') return false;
		throw error;
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns the cached artifact path, or `null` after claiming the right to
 * build it. Waits while another process holds the claim, so parallel lanes
 * with the same fingerprint produce one build.
 */
async function claimOrWait(entry, { waitTimeoutMs, now, sleep: wait }) {
	fs.mkdirSync(entry, { recursive: true });
	const lockPath = path.join(entry, LOCK_FILE);
	const deadline = now() + waitTimeoutMs;
	for (;;) {
		const hit = readArtifact(entry);
		if (hit) return hit;
		if (tryClaimLock(lockPath)) return null;
		const owner = readLockOwner(lockPath);
		if (!owner || !processAlive(owner)) {
			// Abandoned lock: the builder died without uploading. Take it over.
			fs.rmSync(lockPath, { force: true });
			continue;
		}
		if (now() >= deadline) {
			throw new Error(
				`build-cache: timed out after ${Math.round(waitTimeoutMs / 1_000)}s waiting for PID ${owner} to finish building this fingerprint (${lockPath}).`,
			);
		}
		await wait(LOCK_POLL_INTERVAL_MS);
	}
}

function createBuildCacheProvider(internals = {}) {
	const now = internals.now || Date.now;
	const wait = internals.sleep || sleep;

	async function resolveBuildCache(context, options = {}) {
		const entry = entryDirectory(context, options);
		const waitTimeoutMs =
			Number.isFinite(options.waitTimeoutMs) && options.waitTimeoutMs >= 0
				? options.waitTimeoutMs
				: DEFAULT_WAIT_TIMEOUT_MS;
		return claimOrWait(entry, { waitTimeoutMs, now, sleep: wait });
	}

	async function uploadBuildCache(context, options = {}) {
		const entry = entryDirectory(context, options);
		const lockPath = path.join(entry, LOCK_FILE);
		try {
			const buildPath = path.resolve(String(context.buildPath || ''));
			const name = path.basename(buildPath);
			const extension = expectedArtifactExtension(context.platform);
			let stat;
			try {
				stat = fs.statSync(buildPath);
			} catch {
				throw new Error(
					`build-cache: build output ${buildPath} does not exist.`,
				);
			}
			const shapeOk =
				name.endsWith(extension) &&
				(extension === '.app' ? stat.isDirectory() : stat.isFile());
			if (!shapeOk) {
				throw new Error(
					`build-cache: expected a ${extension} ${extension === '.app' ? 'bundle' : 'file'} for ${context.platform}, received ${buildPath}.`,
				);
			}
			fs.mkdirSync(entry, { recursive: true });
			// Copy to a sibling and rename so a reader never sees a half-written
			// artifact: `artifact.json` is only written once the copy is complete.
			const staging = path.join(entry, `${name}.uploading-${process.pid}`);
			const finalPath = path.join(entry, name);
			try {
				fs.rmSync(staging, { recursive: true, force: true });
				fs.cpSync(buildPath, staging, { recursive: true });
				fs.rmSync(finalPath, { recursive: true, force: true });
				fs.renameSync(staging, finalPath);
				fs.writeFileSync(
					path.join(entry, ARTIFACT_FILE),
					`${JSON.stringify(
						{
							artifact: name,
							platform: context.platform,
							configuration: configurationOf(context.runOptions),
							fingerprintHash: context.fingerprintHash,
							createdAt: new Date(now()).toISOString(),
							sourceProject: context.projectRoot,
						},
						null,
						'\t',
					)}\n`,
				);
			} finally {
				fs.rmSync(staging, { recursive: true, force: true });
			}
			return finalPath;
		} finally {
			// Release our claim whether or not the upload succeeded, so waiters
			// either find the artifact or get to build themselves.
			if (readLockOwner(lockPath) === process.pid) {
				fs.rmSync(lockPath, { force: true });
			}
		}
	}

	return { resolveBuildCache, uploadBuildCache };
}

const provider = createBuildCacheProvider();

module.exports = {
	resolveBuildCache: provider.resolveBuildCache,
	uploadBuildCache: provider.uploadBuildCache,
	/** For tests and tooling; not part of the Expo plugin contract. */
	createBuildCacheProvider,
	entryDirectory,
	defaultCacheRoot,
};
