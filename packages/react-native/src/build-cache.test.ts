/**
 * The provider is Node-only, so this test reaches Node's modules through a
 * typed `require` rather than adding @types/node to a React Native package.
 */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { pid: number; ppid: number; execPath: string };

type Fs = {
	mkdtempSync: (prefix: string) => string;
	mkdirSync: (p: string, options?: { recursive?: boolean }) => void;
	rmSync: (
		p: string,
		options?: { recursive?: boolean; force?: boolean },
	) => void;
	writeFileSync: (p: string, data: string) => void;
	existsSync: (p: string) => boolean;
	readFileSync: (p: string, encoding: 'utf8') => string;
	readdirSync: (p: string) => string[];
	statSync: (p: string) => { isDirectory: () => boolean };
	utimesSync: (p: string, atime: Date, mtime: Date) => void;
};
type Path = { join: (...parts: string[]) => string; sep: string };
type Os = { tmpdir: () => string };
type ChildProcess = {
	spawn: (
		command: string,
		args: readonly string[],
	) => {
		stdout: { on: (event: 'data', listener: (chunk: string) => void) => void };
		on: (event: 'close', listener: () => void) => void;
	};
};
type RunOptions = { configuration?: string; variant?: string };
type Context = {
	fingerprintHash: string;
	platform: string;
	runOptions: RunOptions;
	projectRoot?: string;
};
type Provider = {
	resolveBuildCache: (
		context: Context,
		options?: { cacheDirectory?: string; waitTimeoutMs?: number },
	) => Promise<string | null>;
	uploadBuildCache: (
		context: Context & { buildPath: string },
		options?: { cacheDirectory?: string },
	) => Promise<string | null>;
};
type Internals = {
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	arch?: string;
	xcodeIdentity?: () => string;
};
type BuildCacheModule = Provider & {
	createBuildCacheProvider: (internals?: Internals) => Provider;
	entryDirectory: (
		context: Context,
		options?: { cacheDirectory?: string },
		internals?: Internals,
	) => string;
	defaultCacheRoot: (env?: Record<string, string>, homedir?: string) => string;
	toolchainSegment: (platform: string, internals?: Internals) => string;
};

const fs = require('node:fs') as Fs;
const os = require('node:os') as Os;
const path = require('node:path') as Path;
const { spawn } = require('node:child_process') as ChildProcess;
const PROVIDER = path.join(__dirname, '..', 'build-cache.js');
const {
	createBuildCacheProvider,
	defaultCacheRoot,
	entryDirectory,
	resolveBuildCache,
	uploadBuildCache,
	toolchainSegment,
} = require('../build-cache.js') as BuildCacheModule;
const TOOLCHAIN = {
	arch: 'arm64',
	xcodeIdentity: () => 'Xcode 26.6\nBuild version 17F100',
};
const iosToolchain = toolchainSegment('ios', TOOLCHAIN);
const androidToolchain = toolchainSegment('android', TOOLCHAIN);
const {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	existsSync,
	readFileSync,
	readdirSync,
	statSync,
	utimesSync,
} = fs;

const HASH = 'a'.repeat(40);

function makeApp(root: string, name = 'ExampleApp.app'): string {
	const appPath = path.join(root, name);
	mkdirSync(path.join(appPath, 'Frameworks'), { recursive: true });
	writeFileSync(path.join(appPath, 'Info.plist'), '<plist/>');
	writeFileSync(path.join(appPath, 'ExampleApp'), 'binary');
	return appPath;
}

describe('build cache provider', () => {
	let cacheDirectory: string;
	let work: string;

	beforeEach(() => {
		cacheDirectory = mkdtempSync(
			path.join(os.tmpdir(), 'rndevtools-build-cache-'),
		);
		work = mkdtempSync(path.join(os.tmpdir(), 'rndevtools-build-work-'));
	});

	afterEach(() => {
		rmSync(cacheDirectory, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	});

	it('exports exactly the shape Expo validates', () => {
		expect(typeof resolveBuildCache).toBe('function');
		expect(typeof uploadBuildCache).toBe('function');
	});

	it('keys entries by platform, configuration, and fingerprint under a neutral root', () => {
		const ios = entryDirectory(
			{ fingerprintHash: HASH, platform: 'ios', runOptions: {} },
			{ cacheDirectory },
			TOOLCHAIN,
		);
		expect(ios).toBe(
			path.join(cacheDirectory, 'ios', 'Debug', iosToolchain, HASH),
		);
		const release = entryDirectory(
			{
				fingerprintHash: HASH,
				platform: 'ios',
				runOptions: { configuration: 'Release' },
			},
			{ cacheDirectory },
			TOOLCHAIN,
		);
		expect(release).toBe(
			path.join(cacheDirectory, 'ios', 'Release', iosToolchain, HASH),
		);
		const android = entryDirectory(
			{
				fingerprintHash: HASH,
				platform: 'android',
				runOptions: { variant: 'debug' },
			},
			{ cacheDirectory },
			TOOLCHAIN,
		);
		expect(android).toBe(
			path.join(cacheDirectory, 'android', 'debug', androidToolchain, HASH),
		);
		// Hostile segments cannot climb out of the cache root.
		const hostile = entryDirectory(
			{
				fingerprintHash: '../../etc',
				platform: '../x',
				runOptions: { configuration: '..' },
			},
			{ cacheDirectory },
		);
		expect(hostile.startsWith(cacheDirectory + path.sep)).toBe(true);
		expect(hostile).not.toContain('..');
		expect(defaultCacheRoot({ RNDEVTOOLS_BUILD_CACHE_DIR: '/tmp/x' })).toBe(
			'/tmp/x',
		);
		expect(defaultCacheRoot({}, '/Users/dev')).toMatch(
			/rndevtools[/\\]native$/,
		);
	});

	it('keys iOS entries by Xcode version and arch so an upgraded toolchain never serves a stale build', () => {
		const before = toolchainSegment('ios', TOOLCHAIN);
		const upgraded = toolchainSegment('ios', {
			...TOOLCHAIN,
			xcodeIdentity: () => 'Xcode 27.0\nBuild version 18A1',
		});
		const otherArch = toolchainSegment('ios', { ...TOOLCHAIN, arch: 'x64' });
		expect(before).toMatch(/^arm64-[0-9a-f]{12}$/);
		expect(upgraded).not.toBe(before);
		expect(otherArch).toMatch(/^x64-/);
		// Android has no Xcode dependency: the Xcode version must not matter.
		expect(
			toolchainSegment('android', {
				...TOOLCHAIN,
				xcodeIdentity: () => 'Xcode 27.0',
			}),
		).toBe(androidToolchain);
		// The real host resolves a toolchain without being told one.
		expect(toolchainSegment('ios')).toMatch(/^[a-z0-9]+-[0-9a-f]{12}$/);
	});

	it('misses once, claims the build, then serves the uploaded .app to the next worktree', async () => {
		const context = {
			fingerprintHash: HASH,
			platform: 'ios',
			runOptions: {},
			projectRoot: work,
		};
		const first = await resolveBuildCache(context, { cacheDirectory });
		expect(first).toBeNull();
		const entry = entryDirectory(context, { cacheDirectory });
		expect(existsSync(path.join(entry, 'build.lock'))).toBe(true);

		const built = makeApp(work);
		const stored = await uploadBuildCache(
			{ ...context, buildPath: built },
			{ cacheDirectory },
		);
		expect(stored).toBe(path.join(entry, 'ExampleApp.app'));
		expect(statSync(stored as string).isDirectory()).toBe(true);
		expect(existsSync(path.join(entry, 'build.lock'))).toBe(false);
		const metadata = JSON.parse(
			readFileSync(path.join(entry, 'artifact.json'), 'utf8'),
		);
		expect(metadata).toMatchObject({
			artifact: 'ExampleApp.app',
			platform: 'ios',
			fingerprintHash: HASH,
			toolchain: toolchainSegment('ios'),
		});

		// A second worktree with the same fingerprint gets the binary, no build.
		const second = await resolveBuildCache(
			{ ...context, projectRoot: '/Users/dev/app-feature-b' },
			{ cacheDirectory },
		);
		expect(second).toBe(stored);
		expect(
			readFileSync(path.join(second as string, 'Info.plist'), 'utf8'),
		).toBe('<plist/>');
	});

	it('makes a second worktree wait for the in-flight build instead of duplicating it', async () => {
		let clock = 0;
		const waits: number[] = [];
		const provider = createBuildCacheProvider({
			now: () => clock,
			sleep: async (ms: number) => {
				waits.push(ms);
				clock += ms;
				// While "waiting", the first builder finishes and uploads.
				if (waits.length === 2) {
					await uploadBuildCache(
						{
							fingerprintHash: HASH,
							platform: 'ios',
							runOptions: {},
							projectRoot: work,
							buildPath: makeApp(work),
						},
						{ cacheDirectory },
					);
				}
			},
		});
		const context = {
			fingerprintHash: HASH,
			platform: 'ios',
			runOptions: {},
			projectRoot: work,
		};
		// This process holds the claim (same PID as the "waiter" in-test, so make
		// the lock belong to another live process: our parent).
		const entry = entryDirectory(context, { cacheDirectory });
		mkdirSync(entry, { recursive: true });
		writeFileSync(
			path.join(entry, 'build.lock'),
			JSON.stringify({ pid: process.ppid, startedAt: 0 }),
		);

		const result = await provider.resolveBuildCache(context, {
			cacheDirectory,
		});
		expect(result).toBe(path.join(entry, 'ExampleApp.app'));
		expect(waits.length).toBeGreaterThanOrEqual(2);
	});

	it('reclaims a lock whose builder died', async () => {
		const context = {
			fingerprintHash: HASH,
			platform: 'ios',
			runOptions: {},
			projectRoot: work,
		};
		const entry = entryDirectory(context, { cacheDirectory });
		mkdirSync(entry, { recursive: true });
		// PID 2^22-1 is far above any live PID on macOS/Linux defaults.
		writeFileSync(
			path.join(entry, 'build.lock'),
			JSON.stringify({ pid: 4_194_303, startedAt: 0 }),
		);
		expect(await resolveBuildCache(context, { cacheDirectory })).toBeNull();
		expect(
			JSON.parse(readFileSync(path.join(entry, 'build.lock'), 'utf8')).pid,
		).toBe(process.pid);
	});

	it('treats a lock whose owner is not written yet as held, not abandoned', async () => {
		let clock = 0;
		const context = {
			fingerprintHash: HASH,
			platform: 'ios',
			runOptions: {},
			projectRoot: work,
		};
		const entry = entryDirectory(context, { cacheDirectory });
		const provider = createBuildCacheProvider({
			now: () => clock,
			sleep: async (ms: number) => {
				clock += ms;
				// The claimant finishes while this worktree waits.
				if (clock === 2_000) {
					await uploadBuildCache(
						{ ...context, buildPath: makeApp(work) },
						{ cacheDirectory },
					);
				}
			},
		});
		mkdirSync(entry, { recursive: true });
		writeFileSync(path.join(entry, 'build.lock'), '');
		expect(await provider.resolveBuildCache(context, { cacheDirectory })).toBe(
			path.join(entry, 'ExampleApp.app'),
		);
		// The waiter never replaced the claim with its own.
		expect(readFileSync(path.join(entry, 'build.lock'), 'utf8')).toBe('');
	});

	it('reclaims a lock that stays unreadable past the grace period', async () => {
		const context = {
			fingerprintHash: HASH,
			platform: 'ios',
			runOptions: {},
			projectRoot: work,
		};
		const entry = entryDirectory(context, { cacheDirectory });
		mkdirSync(entry, { recursive: true });
		const lockPath = path.join(entry, 'build.lock');
		writeFileSync(lockPath, '{"pid":');
		const anHourAgo = new Date(Date.now() - 60 * 60 * 1_000);
		utimesSync(lockPath, anHourAgo, anHourAgo);
		expect(await resolveBuildCache(context, { cacheDirectory })).toBeNull();
		expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
		expect(readdirSync(entry)).toEqual(['build.lock']);
	});

	it('gives exactly one of several racing processes the claim on an abandoned lock', async () => {
		const context = {
			fingerprintHash: HASH,
			platform: 'ios',
			runOptions: {},
			projectRoot: work,
		};
		const worker = path.join(work, 'contender.cjs');
		// Each contender resolves once at a shared instant; the one that claims
		// uploads straight away, so a slow starter sees the artifact, not a lock
		// left by an exited claimant.
		writeFileSync(
			worker,
			`const fs = require('node:fs');
const path = require('node:path');
const [provider, cacheDirectory, startAt, work] = process.argv.slice(2);
const { createBuildCacheProvider } = require(provider);
const cache = createBuildCacheProvider({ sleep: () => new Promise((resolve) => setTimeout(resolve, 20)) });
const context = ${JSON.stringify(context)};
while (Date.now() < Number(startAt)) {}
cache.resolveBuildCache(context, { cacheDirectory }).then(async (hit) => {
	if (hit === null) {
		const app = path.join(fs.mkdtempSync(path.join(work, 'build-')), 'ExampleApp.app');
		fs.mkdirSync(app);
		fs.writeFileSync(path.join(app, 'Info.plist'), '<plist/>');
		await cache.uploadBuildCache({ ...context, buildPath: app }, { cacheDirectory });
	}
	process.stdout.write(hit === null ? 'claimed' : 'hit');
});
`,
		);
		const entry = entryDirectory(context, { cacheDirectory });
		for (let trial = 0; trial < 3; trial += 1) {
			rmSync(entry, { recursive: true, force: true });
			mkdirSync(entry, { recursive: true });
			writeFileSync(
				path.join(entry, 'build.lock'),
				JSON.stringify({ pid: 4_194_303, startedAt: 0 }),
			);
			const startAt = String(Date.now() + 300);
			const outcomes = await Promise.all(
				Array.from(
					{ length: 4 },
					() =>
						new Promise<string>((resolve) => {
							const child = spawn(process.execPath, [
								worker,
								PROVIDER,
								cacheDirectory,
								startAt,
								work,
							]);
							let output = '';
							child.stdout.on('data', (chunk) => {
								output += chunk;
							});
							child.on('close', () => resolve(output));
						}),
				),
			);
			expect(outcomes.sort()).toEqual(['claimed', 'hit', 'hit', 'hit']);
			// No private lock, staging or record files are left behind.
			expect(readdirSync(entry).sort()).toEqual([
				'ExampleApp.app',
				'artifact.json',
			]);
		}
	});

	it('gives up waiting after the timeout with a message naming the owner', async () => {
		let clock = 0;
		const provider = createBuildCacheProvider({
			now: () => clock,
			sleep: async (ms: number) => {
				clock += ms;
			},
		});
		const context = {
			fingerprintHash: HASH,
			platform: 'ios',
			runOptions: {},
			projectRoot: work,
		};
		const entry = entryDirectory(context, { cacheDirectory });
		mkdirSync(entry, { recursive: true });
		writeFileSync(
			path.join(entry, 'build.lock'),
			JSON.stringify({ pid: process.ppid, startedAt: 0 }),
		);
		await expect(
			provider.resolveBuildCache(context, {
				cacheDirectory,
				waitTimeoutMs: 2_500,
			}),
		).rejects.toThrow(
			new RegExp(`timed out after 3s waiting for PID ${process.ppid}`),
		);
	});

	it('rejects a build output of the wrong shape and still releases the claim', async () => {
		const context = {
			fingerprintHash: HASH,
			platform: 'ios',
			runOptions: {},
			projectRoot: work,
		};
		expect(await resolveBuildCache(context, { cacheDirectory })).toBeNull();
		const notAnApp = path.join(work, 'ExampleApp.ipa');
		writeFileSync(notAnApp, 'zip');
		await expect(
			uploadBuildCache({ ...context, buildPath: notAnApp }, { cacheDirectory }),
		).rejects.toThrow(/expected a \.app bundle for ios/);
		const entry = entryDirectory(context, { cacheDirectory });
		expect(existsSync(path.join(entry, 'build.lock'))).toBe(false);
		expect(existsSync(path.join(entry, 'artifact.json'))).toBe(false);
	});

	it('stores Android APKs as files', async () => {
		const context = {
			fingerprintHash: HASH,
			platform: 'android',
			runOptions: { variant: 'debug' },
			projectRoot: work,
		};
		const apk = path.join(work, 'app-debug.apk');
		writeFileSync(apk, 'PK');
		const stored = await uploadBuildCache(
			{ ...context, buildPath: apk },
			{ cacheDirectory },
		);
		expect(stored).toBe(
			path.join(
				cacheDirectory,
				'android',
				'debug',
				toolchainSegment('android'),
				HASH,
				'app-debug.apk',
			),
		);
		expect(await resolveBuildCache(context, { cacheDirectory })).toBe(stored);
	});

	it('never replaces a published artifact, which a worktree may be installing', async () => {
		const context = {
			fingerprintHash: HASH,
			platform: 'ios',
			runOptions: {},
			projectRoot: work,
		};
		const first = makeApp(mkdtempSync(path.join(work, 'first-')));
		const stored = await uploadBuildCache(
			{ ...context, buildPath: first },
			{ cacheDirectory },
		);
		const record = readFileSync(
			path.join(entryDirectory(context, { cacheDirectory }), 'artifact.json'),
			'utf8',
		);
		// A build that raced the lock uploads the same fingerprint again.
		const second = makeApp(mkdtempSync(path.join(work, 'second-')));
		writeFileSync(path.join(second, 'ExampleApp'), 'rebuilt binary');
		expect(
			await uploadBuildCache(
				{ ...context, buildPath: second, projectRoot: '/Users/dev/app-b' },
				{ cacheDirectory },
			),
		).toBe(stored);
		expect(
			readFileSync(path.join(stored as string, 'ExampleApp'), 'utf8'),
		).toBe('binary');
		expect(
			readFileSync(
				path.join(entryDirectory(context, { cacheDirectory }), 'artifact.json'),
				'utf8',
			),
		).toBe(record);
	});

	it('keeps a complete copy that a concurrent upload moved in first', async () => {
		const context = {
			fingerprintHash: HASH,
			platform: 'ios',
			runOptions: {},
			projectRoot: work,
		};
		const entry = entryDirectory(context, { cacheDirectory });
		// The other upload renamed its copy into place but has not recorded it.
		const theirs = makeApp(entry);
		writeFileSync(path.join(theirs, 'ExampleApp'), 'their binary');
		const stored = await uploadBuildCache(
			{ ...context, buildPath: makeApp(work) },
			{ cacheDirectory },
		);
		expect(stored).toBe(theirs);
		expect(readFileSync(path.join(theirs, 'ExampleApp'), 'utf8')).toBe(
			'their binary',
		);
		expect(await resolveBuildCache(context, { cacheDirectory })).toBe(theirs);
		expect(readdirSync(entry).sort()).toEqual([
			'ExampleApp.app',
			'artifact.json',
		]);
	});

	it('ignores a tampered artifact record that points outside the entry', async () => {
		const context = {
			fingerprintHash: HASH,
			platform: 'ios',
			runOptions: {},
			projectRoot: work,
		};
		const entry = entryDirectory(context, { cacheDirectory });
		mkdirSync(entry, { recursive: true });
		makeApp(work);
		writeFileSync(
			path.join(entry, 'artifact.json'),
			JSON.stringify({
				artifact: path.join('..', '..', '..', 'ExampleApp.app'),
			}),
		);
		// Treated as a miss: we claim the build rather than trust the record.
		expect(await resolveBuildCache(context, { cacheDirectory })).toBeNull();
	});
});
