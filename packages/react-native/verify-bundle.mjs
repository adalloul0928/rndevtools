#!/usr/bin/env node
/**
 * Asserts that a production bundle contains no devtools code.
 *
 * `withDevtoolsPruning` cuts the module graph, but a new import added months
 * later can quietly reconnect it. Running this over an exported bundle turns
 * that regression into a build failure instead of a shipped diagnostic panel.
 *
 * Opt-in checks also catch a release bundle that was built against a
 * developer's machine: `--forbid-loopback-urls` fails on literal loopback
 * URLs, and `--preset supabase-local` fails on Supabase secret keys,
 * service-role JWTs, and the local stack's default JWTs.
 *
 * Usage:
 *   npx rndevtools-verify-bundle <bundle-directory-or-file>
 *     [--marker "Extra String"] [--forbid-loopback-urls]
 *     [--preset supabase-local]
 */
import { Buffer } from 'node:buffer';
import { realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Strings that only appear when devtools code is present. These are panel
 * copy and internal identifiers, not import specifiers, because a production
 * bundle drops specifiers and module paths but keeps string literals intact.
 */
export const DEFAULT_MARKERS = Object.freeze([
	'@rndevtools/core',
	'packages/core/src',
	'DebugCameraFixtureError',
	'rndevtools-debug-camera-',
	'rndevtools-restore-points',
	'rndevtools-scenarios',
	'Registered application storage adapters',

	// Each marker below sits on the runtime path of an entry point that the
	// ones above cannot see. `src/verify-bundle.test.ts` pins each to its
	// source and runs that source through Expo's production transform.

	// `@rndevtools/react-native/desktop`
	'Desktop diagnostics client started.',
	// The scope of the errors these two entry points throw, a string literal in
	// their own code rather than the import specifier it matches.
	'@rndevtools/react-native/authorization',
	'@rndevtools/react-native/adapters/storage',
	// `@rndevtools/core/desktop-protocol`
	'scenarios.discardRecovery',
	// `@rndevtools/core/plugins/images`
	'Clear image diagnostics',
	// `@rndevtools/core/plugins/image-overlay`, which the react-native image
	// overlay builds its controller on.
	'Reference image dimensions exceed the safe decode budget.',
	// `@rndevtools/core/redact`, which `/serialize` loads too: the label for a
	// property whose getter the sanitizer does not run.
	'[Accessor omitted]',
	// `@rndevtools/core/plugins/network-presentation`
	'[URL omitted: export limit]',
]);

const USAGE =
	'Usage: rndevtools-verify-bundle <bundle-directory-or-file> [--marker "Extra String"] [--forbid-loopback-urls] [--preset supabase-local]';

// Exported web and Hermes output (`.js`, `.hbc`), and the embedded bundles
// that Xcode, Gradle and `expo export:embed` write (`main.jsbundle`,
// `index.android.bundle`).
const BUNDLE_FILE = /\.(?:[cm]?js|hbc|bundle|jsbundle)$/i;

// Hermes bytecode: `.hbc`, and the embedded bundles, which are bytecode when
// Hermes is on and plain JavaScript otherwise. Hermes keeps every string
// literal in one byte array, as 8-bit bytes when all its characters are
// ASCII and as UTF-16LE otherwise, each literal right after the previous
// one, so these files are searched as bytes in both encodings.
const BYTECODE_FILE = /\.(?:hbc|bundle|jsbundle)$/i;

// Literal loopback hosts, including `*.localhost` (RFC 6761) and JSON-escaped
// slashes. Hostnames that merely start with `localhost.` are not loopback.
const LOOPBACK_URL_BODY = String.raw`(?:https?|wss?):(?:\/\/|\\\/\\\/)(?:(?:[a-z\d-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?![\w.-])`;
const LOOPBACK_URL = new RegExp(String.raw`\b${LOOPBACK_URL_BODY}`, 'gi');
// Hermes keeps its string literals back to back in one byte array, so in
// bytecode the previous literal's last character precedes a URL
// (`globalThishttp://127.0.0.1:8081/`) and a word boundary would hide it.
const LOOPBACK_URL_IN_BYTECODE = new RegExp(LOOPBACK_URL_BODY, 'gi');

// A key body follows the prefix. supabase-js itself ships the bare prefix in
// its key-type check, so the prefix alone is not a finding.
const SUPABASE_SECRET_KEY = /sb_secret_[A-Za-z\d_-]{20,}/;
// A token's claims are its second part. Hermes keeps its string literals back
// to back, so a token's signature can run straight into the next literal, which
// may be another token's header. A match therefore takes the header and the
// payload only and ends at the dot that closes the payload; the scan resumes
// there and still finds a token that follows. The caps bound the work per
// `eyJ`: a real header is under 200 characters and a real payload a few KiB.
const JWT_CANDIDATE = /eyJ[A-Za-z\d_-]{0,1024}\.[A-Za-z\d_-]{1,16384}\./g;
// The issuer of the default anon and service_role keys that every local
// Supabase stack shares (supabase/cli apps/cli/src/command-internal/go-jwt.ts).
const SUPABASE_LOCAL_ISSUER = 'supabase-demo';

function jwtPayload(candidate) {
	const [header, payload] = candidate.split('.');
	if (!header || !payload) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
		return claims !== null && typeof claims === 'object' ? claims : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Findings name what was found, never the value, so a failing CI log does not
 * leak the key it caught.
 */
function supabaseLocalFindings(contents) {
	const findings = [];
	if (SUPABASE_SECRET_KEY.test(contents)) {
		findings.push('Supabase secret key (sb_secret_…)');
	}
	for (const [candidate] of contents.matchAll(JWT_CANDIDATE)) {
		const claims = jwtPayload(candidate);
		if (!claims) continue;
		const role =
			typeof claims.role === 'string' && /^[a-z_]{1,32}$/.test(claims.role)
				? claims.role
				: undefined;
		if (claims.role === 'service_role') {
			findings.push('JWT with role service_role');
		}
		if (claims.iss === SUPABASE_LOCAL_ISSUER) {
			findings.push(
				`local Supabase JWT (iss ${SUPABASE_LOCAL_ISSUER}${role ? `, role ${role}` : ''})`,
			);
		}
	}
	return findings;
}

const LOOPBACK_CHECK = Object.freeze({
	title: 'Production bundle contains loopback URLs',
	label: 'loopback URLs',
	find: (bundle) => {
		const pattern = bundle.bytecode ? LOOPBACK_URL_IN_BYTECODE : LOOPBACK_URL;
		return bundle.texts.flatMap((text) =>
			Array.from(text.matchAll(pattern), ([url]) => url),
		);
	},
});

const PRESET_CHECKS = new Map([
	[
		'supabase-local',
		Object.freeze({
			title: 'Production bundle contains Supabase secrets or local keys',
			label: 'preset supabase-local',
			find: (bundle) =>
				bundle.texts.flatMap((text) => supabaseLocalFindings(text)),
		}),
	],
]);

function markerCheck(markers) {
	return {
		title: 'Production bundle contains devtools code',
		find: (bundle) => markers.filter((marker) => bundle.has(marker)),
	};
}

/**
 * @param {{ forbidLoopbackUrls?: boolean, presets?: readonly string[] }} options
 */
function optionalChecks(options) {
	const checks = options.forbidLoopbackUrls ? [LOOPBACK_CHECK] : [];
	for (const preset of new Set(options.presets ?? [])) {
		const check = PRESET_CHECKS.get(preset);
		if (!check) {
			throw new Error(
				`Unknown preset: ${preset}. Known presets: ${[...PRESET_CHECKS.keys()].join(', ')}`,
			);
		}
		checks.push(check);
	}
	return checks;
}

async function bundleFilesIn(directory) {
	const files = [];
	// Sorted, so a failing report lists files in the same order on every run.
	for (const entry of (await readdir(directory)).sort()) {
		const absolute = path.join(directory, entry);
		const details = await stat(absolute);
		if (details.isDirectory()) files.push(...(await bundleFilesIn(absolute)));
		else if (BUNDLE_FILE.test(entry)) files.push(absolute);
	}
	return files;
}

async function bundleFiles(root) {
	// A file named directly is checked whatever its extension.
	const files = (await stat(root)).isDirectory()
		? await bundleFilesIn(root)
		: [root];
	// An empty or mistyped output directory must not pass as a clean bundle.
	if (files.length === 0) {
		throw new Error(
			`No bundle files (.js, .hbc, .bundle, .jsbundle, .mjs, .cjs) found in ${root}.`,
		);
	}
	return files;
}

/**
 * What the checks scan in one file: `texts`, its decodings, for the pattern
 * checks, `bytecode`, whether it is a bytecode bundle, and `has`, whether a
 * marker occurs in it. A text bundle is its UTF-8 decoding. A bytecode bundle
 * is decoded as UTF-8, which keeps its 8-bit strings, and as UTF-16LE from
 * byte 0 and from byte 1, which keeps its UTF-16 strings whatever their
 * alignment. A marker is searched as its UTF-8 and its UTF-16LE bytes, because
 * an ASCII marker inside a literal with one non-ASCII character is UTF-16
 * too. The needles are Buffers: on a string needle, `Buffer#includes` reads
 * UTF-16 at even offsets only.
 *
 * @param {string} file
 * @returns {Promise<{ texts: string[], bytecode: boolean, has: (marker: string) => boolean }>}
 */
async function readBundle(file) {
	if (!BYTECODE_FILE.test(file)) {
		const text = await readFile(file, 'utf8');
		return {
			texts: [text],
			bytecode: false,
			has: (marker) => text.includes(marker),
		};
	}
	const bytes = await readFile(file);
	return {
		texts: [
			bytes.toString('utf8'),
			bytes.toString('utf16le'),
			bytes.subarray(1).toString('utf16le'),
		],
		bytecode: true,
		has: (marker) =>
			bytes.includes(Buffer.from(marker, 'utf8')) ||
			bytes.includes(Buffer.from(marker, 'utf16le')),
	};
}

/**
 * @param {string} root Exported bundle directory, or a single bundle file.
 * @param {readonly string[]} [markers] Strings that must not appear, checked
 *   in addition to `DEFAULT_MARKERS`.
 * @param {{ forbidLoopbackUrls?: boolean, presets?: readonly string[] }} [options]
 *   Opt-in checks: literal loopback URLs, and named presets such as
 *   `supabase-local`.
 * @returns {Promise<string[]>} The files that were checked.
 * @throws when there is no bundle file to check, or when any check finds
 *   something, naming every file and finding.
 */
export async function verifyPrunedBundle(root, markers = [], options = {}) {
	const results = [
		markerCheck([...new Set([...DEFAULT_MARKERS, ...markers])]),
		...optionalChecks(options),
	].map((check) => ({ check, lines: [] }));
	const files = await bundleFiles(root);
	for (const file of files) {
		const contents = await readBundle(file);
		for (const { check, lines } of results) {
			for (const finding of new Set(check.find(contents))) {
				lines.push(`${file}: ${finding}`);
			}
		}
	}
	const sections = results
		.filter(({ lines }) => lines.length)
		.map(({ check, lines }) => `${check.title}:\n${lines.join('\n')}`);
	if (sections.length) throw new Error(sections.join('\n'));
	return files;
}

function parseArguments(argv) {
	const parsed = {
		root: undefined,
		markers: [],
		forbidLoopbackUrls: false,
		presets: [],
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--marker' || argument === '--preset') {
			const value = argv[index + 1];
			// An empty marker would match every file.
			if (!value) throw new Error(`${argument} needs a value.\n${USAGE}`);
			(argument === '--marker' ? parsed.markers : parsed.presets).push(value);
			index += 1;
		} else if (argument === '--forbid-loopback-urls') {
			parsed.forbidLoopbackUrls = true;
		} else if (argument === '--help' || argument === '-h') {
			parsed.help = true;
		} else if (argument.startsWith('-') || parsed.root !== undefined) {
			// A misspelled opt-in flag must fail rather than silently skip its check.
			throw new Error(`Unexpected argument: ${argument}\n${USAGE}`);
		} else {
			parsed.root = argument;
		}
	}
	return parsed;
}

function isInvokedAsCli() {
	if (!process.argv[1]) return false;
	// Package managers expose this file through a `node_modules/.bin` symlink,
	// and `--preserve-symlinks-main` keeps that symlink in `import.meta.url`.
	// Compare real paths on both sides, or the guard never fires and the check
	// silently passes.
	try {
		return (
			realpathSync(fileURLToPath(import.meta.url)) ===
			realpathSync(process.argv[1])
		);
	} catch {
		return false;
	}
}

if (isInvokedAsCli()) {
	const { root, markers, help, ...options } = parseArguments(
		process.argv.slice(2),
	);
	if (help) {
		console.log(USAGE);
	} else {
		if (!root) throw new Error(USAGE);
		const files = await verifyPrunedBundle(
			path.resolve(root),
			markers,
			options,
		);
		const checked = `${root} (${files.length} ${files.length === 1 ? 'file' : 'files'})`;
		const extras = optionalChecks(options).map((check) => check.label);
		console.log(
			extras.length
				? `No devtools markers found in ${checked}; also checked: ${extras.join(', ')}`
				: `No devtools markers found in ${checked}`,
		);
	}
}
