/**
 * The verifier is a Node-only ES module with top-level `await`, which Jest
 * cannot load here, so this test runs the real CLI as a child process. Node's
 * modules are reached through a typed `require` rather than adding
 * @types/node to a React Native package.
 */
declare const require: ((id: string) => unknown) & {
	resolve: (id: string, options?: { paths?: readonly string[] }) => string;
};
declare const __dirname: string;
declare const process: {
	execPath: string;
	env: Record<string, string | undefined>;
	platform: string;
};

/** The part of a Buffer this file reads. */
type Bytes = {
	indexOf: (needle: Bytes) => number;
	subarray: (start?: number, end?: number) => Bytes;
	toString: (encoding: 'hex') => string;
};
type BufferModule = {
	Buffer: {
		from: ((value: string, encoding: 'utf8' | 'utf16le') => Bytes) &
			((values: readonly number[]) => Bytes);
		concat: (parts: readonly Bytes[]) => Bytes;
	};
};

type Fs = {
	mkdtempSync: (prefix: string) => string;
	mkdirSync: (p: string, options?: { recursive?: boolean }) => void;
	readFileSync: ((p: string, encoding: 'utf8') => string) &
		((p: string) => Bytes);
	rmSync: (
		p: string,
		options?: { recursive?: boolean; force?: boolean },
	) => void;
	symlinkSync: (target: string, p: string) => void;
	writeFileSync: (p: string, data: string | Bytes) => void;
};
type Path = {
	dirname: (p: string) => string;
	join: (...parts: string[]) => string;
};
type Os = { tmpdir: () => string };
type Url = { pathToFileURL: (p: string) => { href: string } };
type SpawnResult = {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: { message: string };
};
type ChildProcess = {
	spawnSync: (
		command: string,
		args: readonly string[],
		options: { encoding: 'utf8'; env?: Record<string, string | undefined> },
	) => SpawnResult;
};

const {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} = require('node:fs') as Fs;
const os = require('node:os') as Os;
const path = require('node:path') as Path;
const { pathToFileURL } = require('node:url') as Url;
const { Buffer } = require('node:buffer') as BufferModule;
const { spawnSync } = require('node:child_process') as ChildProcess;

const PACKAGE_ROOT = path.join(__dirname, '..');
const VERIFIER = path.join(PACKAGE_ROOT, 'verify-bundle.mjs');
const VERIFIER_URL = pathToFileURL(VERIFIER).href;
const roots: string[] = [];

function scratch(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), 'rndevtools-verify-'));
	roots.push(root);
	return root;
}

function bundle(files: Record<string, string>): string {
	const root = scratch();
	for (const [name, contents] of Object.entries(files)) {
		const file = path.join(root, name);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, contents);
	}
	return root;
}

function verify(...args: string[]): SpawnResult {
	return spawnSync(process.execPath, [VERIFIER, ...args], {
		encoding: 'utf8',
	});
}

/** Runs `body` as an ES module that has imported the verifier's exports. */
function withVerifierModule(body: string): SpawnResult {
	return spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`import { DEFAULT_MARKERS, verifyPrunedBundle } from ${JSON.stringify(VERIFIER_URL)};\n${body}`,
		],
		{ encoding: 'utf8' },
	);
}

function base64Url(value: unknown): string {
	return btoa(JSON.stringify(value))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/** Token-shaped fixtures are built at runtime so no key literal sits in source. */
function jwt(payload: Record<string, unknown>): string {
	return `${base64Url({ alg: 'HS256', typ: 'JWT' })}.${base64Url(payload)}.${'s'.repeat(43)}`;
}

const SECRET_KEY = `sb_secret_${'k'.repeat(22)}_${'c'.repeat(8)}`;
const SERVICE_ROLE_JWT = jwt({ iss: 'supabase', role: 'service_role' });
const LOCAL_ANON_JWT = jwt({ iss: 'supabase-demo', role: 'anon' });
const BUNDLE = '_expo/static/js/ios/index-0123abcd.js';

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('rndevtools-verify-bundle defaults', () => {
	it('checks only devtools markers when no opt-in flag is given', () => {
		const root = bundle({
			[BUNDLE]: `fetch("http://127.0.0.1:54321/rest/v1");var k="${SECRET_KEY}",j="${SERVICE_ROLE_JWT}";`,
		});
		const result = verify(root);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(
			`No devtools markers found in ${root} (1 file)`,
		);
	});

	it('still fails on devtools markers with the existing report', () => {
		const root = bundle({ [BUNDLE]: 'require("@rndevtools/core")' });
		const result = verify(root, '--marker', 'Example Debug Panel');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			`Production bundle contains devtools code:\n${path.join(root, BUNDLE)}: @rndevtools/core`,
		);
	});
});

describe('rndevtools-verify-bundle inputs', () => {
	it('fails when there is no bundle file to check', () => {
		const empty = bundle({});
		const emptyResult = verify(empty);
		expect(emptyResult.status).toBe(1);
		expect(emptyResult.stderr).toContain(
			`No bundle files (.js, .hbc, .bundle, .jsbundle, .mjs, .cjs) found in ${empty}.`,
		);
		const noBundle = bundle({
			'_expo/static/js/ios/index-0123abcd.js.map': '{}',
			'assets/logo.png': 'png',
		});
		const noBundleResult = verify(noBundle);
		expect(noBundleResult.status).toBe(1);
		expect(noBundleResult.stderr).toContain('No bundle files');
	});

	it('scans embedded native bundles and extensions in any case', () => {
		const ios = 'App.app/main.jsbundle';
		const android = 'generated/assets/react/release/index.android.bundle';
		const upper = 'web/INDEX.JS';
		const root = bundle({
			[ios]: 'var a="@rndevtools/core/runtime-state";',
			[android]: 'var s="rndevtools-scenarios";',
			[upper]: 'var r="rndevtools-restore-points";',
		});
		const result = verify(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			[
				'Production bundle contains devtools code:',
				`${path.join(root, ios)}: @rndevtools/core`,
				`${path.join(root, android)}: rndevtools-scenarios`,
				`${path.join(root, upper)}: rndevtools-restore-points`,
			].join('\n'),
		);
	});

	it('checks a single bundle file named directly and reports the file count', () => {
		const dirty = bundle({ 'main.jsbundle': 'var s="rndevtools-scenarios";' });
		const dirtyResult = verify(path.join(dirty, 'main.jsbundle'));
		expect(dirtyResult.status).toBe(1);
		expect(dirtyResult.stderr).toContain(
			`${path.join(dirty, 'main.jsbundle')}: rndevtools-scenarios`,
		);
		const clean = bundle({ 'main.jsbundle': 'console.log("ok")' });
		const file = path.join(clean, 'main.jsbundle');
		const cleanResult = verify(file);
		expect(cleanResult.status).toBe(0);
		expect(cleanResult.stdout.trim()).toBe(
			`No devtools markers found in ${file} (1 file)`,
		);
		const two = bundle({ [BUNDLE]: 'ok', 'ios/main.jsbundle': 'ok' });
		expect(verify(two).stdout.trim()).toBe(
			`No devtools markers found in ${two} (2 files)`,
		);
	});
});

// Each marker stands for an entry point that the older markers cannot see in
// a production bundle, where only string literals survive.
const PINNED_MARKERS: readonly (readonly [marker: string, source: string])[] = [
	[
		'Desktop diagnostics client started.',
		path.join(__dirname, 'desktop', 'client.ts'),
	],
	[
		'@rndevtools/react-native/authorization',
		path.join(__dirname, 'authorization.ts'),
	],
	[
		'@rndevtools/react-native/adapters/storage',
		path.join(__dirname, 'adapters', 'storage.ts'),
	],
	[
		'scenarios.discardRecovery',
		require.resolve('@rndevtools/core/desktop-protocol'),
	],
	[
		'Clear image diagnostics',
		require.resolve('@rndevtools/core/plugins/images'),
	],
	[
		'Reference image dimensions exceed the safe decode budget.',
		require.resolve('@rndevtools/core/plugins/image-overlay'),
	],
	['[Accessor omitted]', require.resolve('@rndevtools/core/redact')],
	[
		'[URL omitted: export limit]',
		require.resolve('@rndevtools/core/plugins/network-presentation'),
	],
];

/**
 * Transforms each module the way `expo export` does for a release build:
 * Expo's default Metro transformer with `dev: false` and `minify: true`,
 * which inlines `__DEV__`, folds constants, drops import specifiers and
 * comments, and minifies. `expo/metro-config` is resolved from this package,
 * as a host's `metro.config.js` resolves it. The modules each one requires
 * are listed next to its output, in `<name>.dependencies.json`, which the
 * verifier does not read.
 */
const PRODUCTION_TRANSFORM = `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const { projectRoot, outputRoot, modules } = JSON.parse(process.argv[1]);
const require = createRequire(path.join(projectRoot, 'package.json'));
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(projectRoot);
const { transform } = require(config.transformerPath);
const platform = 'ios';
const { transform: defaults } = await config.transformer.getTransformOptions(
	[],
	{ dev: false, hot: false, platform },
	async () => [],
);
const options = {
	...defaults,
	customTransformOptions: { __proto__: null, engine: 'hermes' },
	dev: false,
	hot: false,
	minify: true,
	platform,
	type: 'module',
	unstable_transformProfile: 'hermes-stable',
};
for (const [name, source] of Object.entries(modules)) {
	const { dependencies, output } = await transform(
		config.transformer,
		projectRoot,
		source,
		readFileSync(source),
		options,
	);
	const file = path.join(outputRoot, name);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, output[0].data.code);
	writeFileSync(
		file + '.dependencies.json',
		JSON.stringify(dependencies.map((dependency) => dependency.name)),
	);
}
`;

/** Writes the release-build output of each source to a bundle directory. */
function exportForProduction(
	modules: Readonly<Record<string, string>>,
): string {
	const outputRoot = scratch();
	const result = spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			PRODUCTION_TRANSFORM,
			JSON.stringify({ projectRoot: PACKAGE_ROOT, outputRoot, modules }),
		],
		{ encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } },
	);
	if (result.status !== 0) throw new Error(result.stderr);
	return outputRoot;
}

/**
 * The `hermesc` that react-native's `hermes-compiler` dependency ships for
 * this platform, found through react-native as Expo finds it, so pnpm's
 * layout gives the copy react-native uses. A supported platform without the
 * binary is a broken install, so this throws instead of skipping: a skipped
 * suite would leave the bytecode path unproven without a signal.
 */
const HERMESC_BY_PLATFORM: Readonly<Record<string, string>> = {
	darwin: 'osx-bin/hermesc',
	linux: 'linux64-bin/hermesc',
	win32: 'win64-bin/hermesc.exe',
};

function hermesc(): string {
	const binary = HERMESC_BY_PLATFORM[process.platform];
	if (!binary) {
		throw new Error(`hermes-compiler ships no hermesc for ${process.platform}`);
	}
	const reactNative = path.dirname(
		require.resolve('react-native/package.json'),
	);
	const compiler = path.dirname(
		require.resolve('hermes-compiler/package.json', { paths: [reactNative] }),
	);
	return path.join(compiler, 'hermesc', binary);
}

// The first eight bytes of every Hermes bytecode file.
const HERMES_MAGIC = 'c61fbc03c103191f';

/**
 * Compiles `source` to Hermes bytecode as a release build does (`hermesc
 * -emit-binary -O`, the flags Expo, Gradle and Xcode pass), writes it to
 * `output` and returns its bytes. Hermes stores a string literal as 8-bit
 * bytes when every character is ASCII and as UTF-16 otherwise.
 */
function compileHermes(source: string, output: string): Bytes {
	const input = path.join(scratch(), 'index.js');
	writeFileSync(input, source);
	mkdirSync(path.dirname(output), { recursive: true });
	const result = spawnSync(
		hermesc(),
		['-emit-binary', '-O', '-out', output, input],
		{ encoding: 'utf8' },
	);
	if (result.status !== 0) {
		throw new Error(result.error?.message ?? result.stderr);
	}
	const bytes = readFileSync(output);
	// Bytecode, not a compiler log or an empty file.
	expect(bytes.subarray(0, 8).toString('hex')).toBe(HERMES_MAGIC);
	return bytes;
}

describe('default markers', () => {
	it('catch the entry points the older markers cannot see', () => {
		const files = PINNED_MARKERS.map(([marker], index) => ({
			name: `_expo/static/js/ios/module-${index}.js`,
			marker,
		}));
		const root = bundle(
			Object.fromEntries(
				files.map(({ name, marker }) => [name, `x("${marker}")`]),
			),
		);
		const result = verify(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			[
				'Production bundle contains devtools code:',
				...files.map(
					({ name, marker }) => `${path.join(root, name)}: ${marker}`,
				),
			].join('\n'),
		);
	});

	it('stay string literals in the runtime code they stand for', () => {
		const defaults = withVerifierModule(
			'console.log(JSON.stringify(DEFAULT_MARKERS));',
		);
		expect(defaults.status).toBe(0);
		const markers = JSON.parse(defaults.stdout) as string[];
		for (const [marker, source] of PINNED_MARKERS) {
			expect(markers).toContain(marker);
			// Quoted, so a comment that mentions the marker does not count.
			expect(readFileSync(source, 'utf8')).toContain(`'${marker}'`);
		}
	});

	it("survive Expo's production transform of the code they stand for", () => {
		// The transform must drop what a marker cannot rely on, or keeping the
		// pinned markers would prove nothing.
		const control = path.join(scratch(), 'control.ts');
		writeFileSync(
			control,
			[
				"const unused = 'rndevtools-unused-constant';",
				'// rndevtools-comment',
				'declare const __DEV__: boolean;',
				'export function report(): void {',
				"\tif (__DEV__) console.log('rndevtools-development-branch');",
				'}',
			].join('\n'),
		);
		const controlName = '_expo/static/js/ios/control.js';
		const modules = PINNED_MARKERS.map(([marker, source], index) => ({
			name: `_expo/static/js/ios/module-${index}.js`,
			marker,
			source,
		}));
		const sources: Record<string, string> = { [controlName]: control };
		for (const { name, source } of modules) sources[name] = source;
		const root = exportForProduction(sources);

		expect(readFileSync(path.join(root, controlName), 'utf8')).not.toContain(
			'rndevtools-',
		);
		const result = verify(root);
		expect(result.status).toBe(1);
		for (const { name, marker } of modules) {
			expect(result.stderr).toContain(`${path.join(root, name)}: ${marker}`);
		}
	});

	it("catch core's /serialize through the /redact module its release build requires", () => {
		const serialize = '_expo/static/js/ios/serialize.js';
		const redact = '_expo/static/js/ios/redact.js';
		const root = exportForProduction({
			[serialize]: require.resolve('@rndevtools/core/serialize'),
			[redact]: require.resolve('@rndevtools/core/redact'),
		});
		const dependencies = JSON.parse(
			readFileSync(path.join(root, `${serialize}.dependencies.json`), 'utf8'),
		) as string[];
		expect(dependencies).toContain('./redact');
		const result = verify(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			`${path.join(root, redact)}: [Accessor omitted]`,
		);
	});
});

describe('verifyPrunedBundle', () => {
	it('checks the default markers on top of the markers it is given', () => {
		const extra = 'ios/extra.js';
		const root = bundle({
			[BUNDLE]: 'var s="rndevtools-scenarios";',
			[extra]: 'var t="Example Debug Panel";',
		});
		const result = withVerifierModule(
			`await verifyPrunedBundle(${JSON.stringify(root)}, ['Example Debug Panel']);`,
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			[
				'Production bundle contains devtools code:',
				`${path.join(root, BUNDLE)}: rndevtools-scenarios`,
				`${path.join(root, extra)}: Example Debug Panel`,
			].join('\n'),
		);
	});

	it('resolves to the files it checked', () => {
		const root = bundle({ [BUNDLE]: 'ok', 'ios/main.jsbundle': 'ok' });
		const result = withVerifierModule(
			`console.log(JSON.stringify(await verifyPrunedBundle(${JSON.stringify(root)})));`,
		);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual([
			path.join(root, BUNDLE),
			path.join(root, 'ios/main.jsbundle'),
		]);
	});
});

describe('rndevtools-verify-bundle entry point', () => {
	it('runs through a .bin symlink, also when Node preserves the symlink', () => {
		const root = bundle({ [BUNDLE]: 'var s="rndevtools-scenarios";' });
		const bin = path.join(scratch(), 'node_modules', '.bin');
		mkdirSync(bin, { recursive: true });
		const link = path.join(bin, 'rndevtools-verify-bundle');
		symlinkSync(VERIFIER, link);
		for (const flags of [
			[],
			['--preserve-symlinks-main'],
			['--preserve-symlinks', '--preserve-symlinks-main'],
		]) {
			const result = spawnSync(process.execPath, [...flags, link, root], {
				encoding: 'utf8',
			});
			expect({ flags, status: result.status }).toEqual({ flags, status: 1 });
			expect(result.stderr).toContain(
				`${path.join(root, BUNDLE)}: rndevtools-scenarios`,
			);
		}
	});

	it('stays inert when another module imports it', () => {
		const script = path.join(scratch(), 'import-verifier.mjs');
		writeFileSync(
			script,
			`import { DEFAULT_MARKERS } from ${JSON.stringify(VERIFIER_URL)};\nconsole.log(DEFAULT_MARKERS.length > 0 ? 'imported' : 'empty');\n`,
		);
		// A bare `--marker` would fail the run if the CLI started.
		const result = spawnSync(process.execPath, [script, '--marker'], {
			encoding: 'utf8',
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe('imported');
	});
});

const HBC = '_expo/static/js/android/index-4567cdef.hbc';

describe('Hermes bytecode', () => {
	it('finds a marker Hermes stores as UTF-16, and a default marker inside such a literal', () => {
		const root = scratch();
		const hbc = path.join(root, HBC);
		const bytes = compileHermes(
			'var a="Example Débug Panel",b="rndevtools-scenarios — restore";globalThis.x=[a,b];',
			hbc,
		);
		// The fixture must take the UTF-16 path, or this proves nothing.
		expect(bytes.indexOf(Buffer.from('Example Débug Panel', 'utf8'))).toBe(-1);
		expect(
			bytes.indexOf(Buffer.from('Example Débug Panel', 'utf16le')),
		).toBeGreaterThan(0);
		expect(bytes.indexOf(Buffer.from('rndevtools-scenarios', 'utf8'))).toBe(-1);
		const result = verify(root, '--marker', 'Example Débug Panel');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			[
				'Production bundle contains devtools code:',
				`${hbc}: rndevtools-scenarios`,
				`${hbc}: Example Débug Panel`,
			].join('\n'),
		);
	});

	it('keeps the default markers through hermesc -O on the code they stand for', () => {
		const modules = PINNED_MARKERS.map(([marker, source], index) => ({
			name: `module-${index}.js`,
			marker,
			source,
		}));
		const js = exportForProduction(
			Object.fromEntries(modules.map(({ name, source }) => [name, source])),
		);
		const root = scratch();
		const files = modules.map(({ name, marker }) => {
			const hbc = path.join(
				root,
				'_expo/static/js/android',
				name.replace(/\.js$/, '.hbc'),
			);
			compileHermes(readFileSync(path.join(js, name), 'utf8'), hbc);
			return { hbc, marker };
		});
		const result = verify(root);
		expect(result.status).toBe(1);
		for (const { hbc, marker } of files) {
			expect(result.stderr).toContain(`${hbc}: ${marker}`);
		}
	});

	it('finds a service-role token Hermes stores right after another token', () => {
		// Hermes keeps its literals back to back, so the first token's signature
		// runs straight into the second token's header.
		const root = scratch();
		const hbc = path.join(root, HBC);
		const hosted = jwt({ iss: 'supabase', ref: 'project', role: 'anon' });
		const bytes = compileHermes(
			`var tokens=["${hosted}","${SERVICE_ROLE_JWT}"];globalThis.x=tokens;`,
			hbc,
		);
		// The fixture must keep the two literals adjacent, or this proves nothing.
		expect(
			bytes.indexOf(Buffer.from(`${hosted}${SERVICE_ROLE_JWT}`, 'utf8')),
		).toBeGreaterThan(0);
		const result = verify(root, '--preset', 'supabase-local');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`${hbc}: JWT with role service_role`);
		expect(result.stderr).not.toContain('eyJ');
	});

	it('finds a token inside a literal Hermes stores as UTF-16', () => {
		const root = scratch();
		const hbc = path.join(root, HBC);
		const literal = `Bearer ${SERVICE_ROLE_JWT} — é`;
		const bytes = compileHermes(
			`var header="${literal}";globalThis.x=header;`,
			hbc,
		);
		// UTF-16, so the old UTF-8 read cannot see the token.
		expect(bytes.indexOf(Buffer.from(SERVICE_ROLE_JWT, 'utf8'))).toBe(-1);
		expect(
			bytes.indexOf(Buffer.from(SERVICE_ROLE_JWT, 'utf16le')),
		).toBeGreaterThan(0);
		const result = verify(root, '--preset', 'supabase-local');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`${hbc}: JWT with role service_role`);
	});

	it('reads UTF-16 text whichever byte it starts at', () => {
		// Hermes aligns its UTF-16 literals, but the verifier does not rely on it:
		// the same text one byte in is found too. Hand-built, since hermesc output
		// cannot place a literal at an odd offset.
		const url = Buffer.from('http://localhost:8081/', 'utf16le');
		const even = scratch();
		const odd = scratch();
		const evenFile = path.join(even, HBC);
		const oddFile = path.join(odd, HBC);
		for (const [file, bytes] of [
			[evenFile, url],
			[oddFile, Buffer.concat([Buffer.from([0]), url])],
		] as const) {
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, bytes);
		}
		for (const [root, file] of [
			[even, evenFile],
			[odd, oddFile],
		] as const) {
			const result = verify(root, '--forbid-loopback-urls');
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`${file}: http://localhost:8081`);
		}
	});
});

describe('--forbid-loopback-urls', () => {
	it('flags literal loopback URLs in JavaScript and Hermes bytecode', () => {
		const root = bundle({
			[BUNDLE]: [
				'"http://127.0.0.1:54321/rest/v1"',
				'"HTTPS://LOCALHOST:3000"',
				'"http://[::1]:8081/status"',
				'"ws://app.localhost:8080/socket"',
				'"http:\\/\\/127.0.0.1:9000"',
			].join(';'),
		});
		const hbc = path.join(root, HBC);
		// One URL Hermes stores as UTF-16, one as 8-bit bytes.
		compileHermes(
			'var a="Example Débug Panel",u="http://localhost:8081/café",v="http://127.0.0.1:54321/rest/v1";globalThis.x=[a,u,v];',
			hbc,
		);
		const result = verify('--forbid-loopback-urls', root);
		expect(result.status).toBe(1);
		const js = path.join(root, BUNDLE);
		const lines = result.stderr.split('\n');
		// hermesc orders its string table, and so the findings in it, as it likes.
		expect(lines.filter((line) => line.startsWith(`${hbc}: `)).sort()).toEqual(
			[
				`${hbc}: http://127.0.0.1:54321`,
				`${hbc}: http://localhost:8081`,
			].sort(),
		);
		expect(result.stderr).toContain(
			[
				'Production bundle contains loopback URLs:',
				...lines.filter((line) => line.startsWith(`${hbc}: `)),
				`${js}: http://127.0.0.1:54321`,
				`${js}: HTTPS://LOCALHOST:3000`,
				`${js}: http://[::1]:8081`,
				`${js}: ws://app.localhost:8080`,
				`${js}: http:\\/\\/127.0.0.1:9000`,
			].join('\n'),
		);
	});

	it('passes hosts that only look like loopback, and files outside the bundle', () => {
		const root = bundle({
			[BUNDLE]:
				'"https://localhost.example.com";"https://api.example.com";"http://localhost-preview.example.com";"localhost:8081"',
			'_expo/static/js/ios/index-0123abcd.js.map':
				'{"sourcesContent":["fetch(\\"http://localhost:8081\\")"]}',
		});
		const result = verify(root, '--forbid-loopback-urls');
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(
			`No devtools markers found in ${root} (1 file); also checked: loopback URLs`,
		);
	});
});

describe('--preset supabase-local', () => {
	it('flags secret keys, service-role JWTs, and local default JWTs without echoing them', () => {
		const root = bundle({
			[BUNDLE]: `var a="${SECRET_KEY}",b="${SERVICE_ROLE_JWT}",c="${LOCAL_ANON_JWT}";`,
		});
		const result = verify(root, '--preset', 'supabase-local');
		expect(result.status).toBe(1);
		const file = path.join(root, BUNDLE);
		expect(result.stderr).toContain(
			[
				'Production bundle contains Supabase secrets or local keys:',
				`${file}: Supabase secret key (sb_secret_…)`,
				`${file}: JWT with role service_role`,
				`${file}: local Supabase JWT (iss supabase-demo, role anon)`,
			].join('\n'),
		);
		expect(result.stderr).not.toContain(SECRET_KEY);
		expect(result.stderr).not.toContain('eyJ');
	});

	it('passes a hosted client configuration and the prefix check supabase-js ships', () => {
		const root = bundle({
			[BUNDLE]: [
				'function isNewKey(e){return e.startsWith("sb_publishable_")||e.startsWith("sb_secret_")}',
				`var url="https://project.example.com",key="sb_publishable_${'p'.repeat(22)}_${'c'.repeat(8)}"`,
				`var anon="${jwt({ iss: 'supabase', ref: 'project', role: 'anon' })}"`,
				'var notJwt="eyJ-eyJ-eyJ.";',
			].join(';'),
		});
		const result = verify(root, '--preset', 'supabase-local');
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(
			`No devtools markers found in ${root} (1 file); also checked: preset supabase-local`,
		);
	});
});

describe('rndevtools-verify-bundle arguments', () => {
	it('fails closed on unknown flags, unknown presets, and missing values', () => {
		const root = bundle({ [BUNDLE]: 'ok' });
		const misspelled = verify(root, '--forbid-loopback-url');
		expect(misspelled.status).toBe(1);
		expect(misspelled.stderr).toContain(
			'Unexpected argument: --forbid-loopback-url',
		);
		const unknownPreset = verify(root, '--preset', 'example-preset');
		expect(unknownPreset.status).toBe(1);
		expect(unknownPreset.stderr).toContain(
			'Unknown preset: example-preset. Known presets: supabase-local',
		);
		const missingValue = verify(root, '--marker');
		expect(missingValue.status).toBe(1);
		expect(missingValue.stderr).toContain('--marker needs a value.');
		const twoDirectories = verify(root, root);
		expect(twoDirectories.status).toBe(1);
		expect(twoDirectories.stderr).toContain('Unexpected argument:');
	});

	it('prints usage for --help and fails without a directory', () => {
		const help = verify('--help');
		expect(help.status).toBe(0);
		expect(help.stdout).toContain('Usage: rndevtools-verify-bundle');
		const missing = verify();
		expect(missing.status).toBe(1);
		expect(missing.stderr).toContain('Usage: rndevtools-verify-bundle');
	});
});
