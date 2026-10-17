/**
 * The verifier is a Node-only ES module with top-level `await`, which Jest
 * cannot load here, so this test runs the real CLI as a child process. Node's
 * modules are reached through a typed `require` rather than adding
 * @types/node to a React Native package.
 */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { execPath: string };

type Fs = {
	mkdtempSync: (prefix: string) => string;
	mkdirSync: (p: string, options?: { recursive?: boolean }) => void;
	rmSync: (
		p: string,
		options?: { recursive?: boolean; force?: boolean },
	) => void;
	writeFileSync: (p: string, data: string) => void;
};
type Path = {
	dirname: (p: string) => string;
	join: (...parts: string[]) => string;
};
type Os = { tmpdir: () => string };
type SpawnResult = { status: number | null; stdout: string; stderr: string };
type ChildProcess = {
	spawnSync: (
		command: string,
		args: readonly string[],
		options: { encoding: 'utf8' },
	) => SpawnResult;
};

const { mkdtempSync, mkdirSync, rmSync, writeFileSync } =
	require('node:fs') as Fs;
const os = require('node:os') as Os;
const path = require('node:path') as Path;
const { spawnSync } = require('node:child_process') as ChildProcess;

const VERIFIER = path.join(__dirname, '..', 'verify-bundle.mjs');
const roots: string[] = [];

function bundle(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(os.tmpdir(), 'rndevtools-verify-'));
	roots.push(root);
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
		expect(result.stdout.trim()).toBe(`No devtools markers found in ${root}`);
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
			'_expo/static/js/android/index-4567cdef.hbc':
				'Æ\u001fHermes\u0000http://localhost:8081/',
		});
		const result = verify('--forbid-loopback-urls', root);
		expect(result.status).toBe(1);
		const js = path.join(root, BUNDLE);
		const hbc = path.join(root, '_expo/static/js/android/index-4567cdef.hbc');
		expect(result.stderr).toContain(
			[
				'Production bundle contains loopback URLs:',
				`${hbc}: http://localhost:8081`,
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
			`No devtools markers found in ${root}; also checked: loopback URLs`,
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
			`No devtools markers found in ${root}; also checked: preset supabase-local`,
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
