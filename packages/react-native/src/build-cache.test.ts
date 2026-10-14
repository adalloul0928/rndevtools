/**
 * The provider is Node-only, so this test reaches Node's modules through a
 * typed `require` rather than adding @types/node to a React Native package.
 */
declare const require: (id: string) => unknown;
declare const process: { pid: number; ppid: number };

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
	statSync: (p: string) => { isDirectory: () => boolean };
};
type Path = { join: (...parts: string[]) => string; sep: string };
type Os = { tmpdir: () => string };
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
type BuildCacheModule = Provider & {
	createBuildCacheProvider: (internals?: {
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
	}) => Provider;
	entryDirectory: (
		context: Context,
		options?: { cacheDirectory?: string },
	) => string;
	defaultCacheRoot: (env?: Record<string, string>, homedir?: string) => string;
};

const fs = require('node:fs') as Fs;
const os = require('node:os') as Os;
const path = require('node:path') as Path;
const {
	createBuildCacheProvider,
	defaultCacheRoot,
	entryDirectory,
	resolveBuildCache,
	uploadBuildCache,
} = require('../build-cache.js') as BuildCacheModule;
const {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	existsSync,
	readFileSync,
	statSync,
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
		);
		expect(ios).toBe(path.join(cacheDirectory, 'ios', 'Debug', HASH));
		const release = entryDirectory(
			{
				fingerprintHash: HASH,
				platform: 'ios',
				runOptions: { configuration: 'Release' },
			},
			{ cacheDirectory },
		);
		expect(release).toBe(path.join(cacheDirectory, 'ios', 'Release', HASH));
		const android = entryDirectory(
			{
				fingerprintHash: HASH,
				platform: 'android',
				runOptions: { variant: 'debug' },
			},
			{ cacheDirectory },
		);
		expect(android).toBe(path.join(cacheDirectory, 'android', 'debug', HASH));
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
			path.join(cacheDirectory, 'android', 'debug', HASH, 'app-debug.apk'),
		);
		expect(await resolveBuildCache(context, { cacheDirectory })).toBe(stored);
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
