import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	SIMSLIM_PATCH_SET,
	SIMSLIM_PATCH_SHA256,
	SIMSLIM_UPSTREAM_COMMIT,
	SIMSLIM_UPSTREAM_MANIFEST_SHA256,
	SIMSLIM_VENDORED_MANIFEST_SHA256,
	verifyVendoredSimSlim,
} from './verify-vendored-simslim.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const outputRoot = join(desktopDirectory, 'build', 'native');
const goPackage = join(desktopDirectory, 'native', 'rndevtools-sim-helper');
const cliPackage = join(desktopDirectory, 'native', 'rndevtools-cli');
const swiftPackage = join(desktopDirectory, 'native', 'rndevtools-native-host');

// Apple Developer Team ID compiled into the simulator helper's parent
// attestation. Without it the helper fails closed and refuses every mutation,
// which is the correct behaviour for an unsigned local build.
const signingTeamIdentifier = (process.env.APPLE_TEAM_ID ?? '').trim();
const simulatorHelperTeamFlag = signingTeamIdentifier
	? ` -X github.com/adalloul0928/rndevtools-sim-helper/internal/authorization.expectedTeamIdentifier=${signingTeamIdentifier}`
	: '';
if (!simulatorHelperTeamFlag) {
	console.warn(
		'APPLE_TEAM_ID is not set: building a simulator helper that will refuse every mutation. Set it to your Apple Developer Team ID for a distributable build.'
	);
}
const packageManifest = JSON.parse(
	readFileSync(join(desktopDirectory, 'package.json'), 'utf8')
);
const catalogVersion = 'simslim-v0.8.0-09fc9cbb-pumpd.1-presets.2';
verifyVendoredSimSlim(goPackage);
const sourceCommit = nativeSourceIdentity();

const options = parseOptions(process.argv.slice(2));
if (process.platform !== 'darwin' && options.ifSupported) {
	process.stdout.write(
		'Skipping macOS native helpers on this packaging platform.\n'
	);
	process.exit(0);
}
const architectures = options.all
	? ['arm64', 'x64']
	: [options.architecture ?? hostArchitecture()];

if (options.buildGo) {
	requireCommand('go', ['version'], {
		...allowlistedBuildEnvironment(),
		GOENV: 'off',
		GOEXPERIMENT: '',
		GOFLAGS: '',
		GOPROXY: 'off',
		GOTOOLCHAIN: 'local',
		GOWORK: 'off',
	});
}
if (options.buildSwift) {
	if (process.platform !== 'darwin') {
		fail('The Swift native host can only be built on macOS.');
	}
	requireCommand('swift', ['--version'], allowlistedBuildEnvironment());
}

for (const architecture of architectures) {
	const outputDirectory = join(outputRoot, `mac-${architecture}`);
	mkdirSync(outputDirectory, { recursive: true });
	const helpers = {};
	if (!options.buildGo) {
		for (const [key, name] of [
			['simulator', 'rndevtools-sim-helper'],
			['cli', 'rndevtools'],
		]) {
			const existing = join(outputDirectory, name);
			if (!statIfFile(existing)) {
				fail(`Partial native build requires the existing ${name} binary.`);
			}
			helpers[key] = helperManifest(existing, name);
		}
	}
	if (!options.buildSwift) {
		const existing = join(outputDirectory, 'rndevtools-native-host');
		if (!statIfFile(existing)) {
			fail(
				'Partial native build requires the existing rndevtools-native-host binary.'
			);
		}
		helpers.nativeHost = helperManifest(existing, 'rndevtools-native-host');
	}

	if (options.buildGo) {
		const goEnvironment = {
			...allowlistedBuildEnvironment(),
			CGO_ENABLED: '0',
			GOENV: 'off',
			GOEXPERIMENT: '',
			GOFLAGS: '',
			GOARCH: architecture === 'x64' ? 'amd64' : 'arm64',
			GOAMD64: 'v1',
			GOARM64: 'v8.0',
			GOOS: 'darwin',
			GOPROXY: 'off',
			GOTOOLCHAIN: 'local',
			GOWORK: 'off',
		};
		const simulatorDestination = join(outputDirectory, 'rndevtools-sim-helper');
		buildGoBinary(
			goPackage,
			'./cmd/rndevtools-sim-helper',
			simulatorDestination,
			goEnvironment,
			'vendor',
			simulatorHelperTeamFlag
		);
		helpers.simulator = helperManifest(
			simulatorDestination,
			'rndevtools-sim-helper'
		);

		const cliDestination = join(outputDirectory, 'rndevtools');
		buildGoBinary(
			cliPackage,
			'./cmd/rndevtools',
			cliDestination,
			goEnvironment,
			'readonly'
		);
		helpers.cli = helperManifest(cliDestination, 'rndevtools');
	}

	if (options.buildSwift) {
		const swiftArchitecture = architecture === 'x64' ? 'x86_64' : 'arm64';
		const scratchDirectory = join(outputRoot, `.swift-${architecture}`);
		const swiftEnvironment = allowlistedBuildEnvironment();
		const swiftArguments = [
			'build',
			'--package-path',
			swiftPackage,
			'--scratch-path',
			scratchDirectory,
			'--configuration',
			'release',
			'--arch',
			swiftArchitecture,
		];
		run('swift', swiftArguments, desktopDirectory, swiftEnvironment);
		const binaryDirectory = commandOutput(
			'swift',
			[...swiftArguments, '--show-bin-path'],
			desktopDirectory,
			swiftEnvironment
		);
		if (!binaryDirectory) {
			fail(`Swift did not report a binary directory for ${architecture}.`);
		}
		const destination = join(outputDirectory, 'rndevtools-native-host');
		copyFileSync(join(binaryDirectory, 'rndevtools-native-host'), destination);
		chmodSync(destination, 0o755);
		helpers.nativeHost = helperManifest(destination, 'rndevtools-native-host');
	}

	const manifest = {
		schemaVersion: 1,
		platform: 'darwin',
		architecture,
		appVersion: packageManifest.version,
		buildCommit: sourceCommit,
		protocolVersion: 2,
		compatibilityMatrixVersion: '2026-09-03-v2',
		catalog: {
			version: catalogVersion,
			upstreamRepository: 'https://github.com/MobAI-App/simslim',
			upstreamCommit: SIMSLIM_UPSTREAM_COMMIT,
			patchSet: SIMSLIM_PATCH_SET,
			upstreamSourceManifestSha256: SIMSLIM_UPSTREAM_MANIFEST_SHA256,
			patchSha256: SIMSLIM_PATCH_SHA256,
			vendoredSourceManifestSha256: SIMSLIM_VENDORED_MANIFEST_SHA256,
		},
		helpers,
	};
	writeFileSync(
		join(outputDirectory, 'manifest.json'),
		`${JSON.stringify(manifest, null, 2)}\n`
	);
	process.stdout.write(`Built native resources for mac-${architecture}.\n`);
}

function statIfFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function buildGoBinary(
	packageDirectory,
	command,
	destination,
	environment,
	moduleMode,
	extraLdflags = ''
) {
	run(
		'go',
		[
			'build',
			`-mod=${moduleMode}`,
			'-trimpath',
			'-buildvcs=false',
			'-ldflags',
			`-s -w -X main.version=${packageManifest.version} -X main.buildCommit=${sourceCommit}${extraLdflags}`,
			'-o',
			destination,
			command,
		],
		packageDirectory,
		environment
	);
	chmodSync(destination, 0o755);
}

function parseOptions(arguments_) {
	let architecture;
	let all = false;
	let buildGo = true;
	let buildSwift = true;
	let ifSupported = false;
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === '--all') {
			all = true;
		} else if (argument === '--go-only') {
			buildSwift = false;
		} else if (argument === '--swift-only') {
			buildGo = false;
		} else if (argument === '--if-supported') {
			ifSupported = true;
		} else if (argument === '--arch') {
			architecture = arguments_[index + 1];
			index += 1;
		} else {
			fail(`Unknown build option: ${argument}`);
		}
	}
	if (architecture && !['arm64', 'x64'].includes(architecture)) {
		fail(`Unsupported architecture: ${architecture}`);
	}
	if (all && architecture) {
		fail('Use either --all or --arch, not both.');
	}
	if (ifSupported && (all || architecture || !buildGo || !buildSwift)) {
		fail('--if-supported is reserved for the default packaging build.');
	}
	if (!buildGo && !buildSwift) {
		fail('At least one native helper must be selected.');
	}
	return { all, architecture, buildGo, buildSwift, ifSupported };
}

function hostArchitecture() {
	if (process.arch === 'arm64' || process.arch === 'x64') {
		return process.arch;
	}
	fail(`Unsupported host architecture: ${process.arch}`);
}

function helperManifest(path, name) {
	const data = readFileSync(path);
	return {
		name,
		file: name,
		sha256: createHash('sha256').update(data).digest('hex'),
		size: statSync(path).size,
	};
}

function requireCommand(command, arguments_, env) {
	const result = spawnSync(command, arguments_, {
		cwd: desktopDirectory,
		encoding: 'utf8',
		env,
	});
	if (result.error?.code === 'ENOENT') {
		fail(
			`${command} is required to build native helpers but is not installed.`
		);
	}
	if (result.status !== 0) {
		fail(`${command} is present but could not run successfully.`);
	}
}

function run(command, arguments_, cwd, env) {
	const result = spawnSync(command, arguments_, { cwd, env, stdio: 'inherit' });
	if (result.error) {
		fail(`${command} failed to start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		fail(`${command} exited with status ${result.status}.`);
	}
}

function commandOutput(command, arguments_, cwd, env) {
	const result = spawnSync(command, arguments_, { cwd, encoding: 'utf8', env });
	if (result.status !== 0) {
		return '';
	}
	return result.stdout.trim();
}

function allowlistedBuildEnvironment() {
	const environment = {};
	for (const name of [
		'APPLE_TEAM_ID',
		'DEVELOPER_DIR',
		'HOME',
		'LANG',
		'LC_ALL',
		'PATH',
		'SDKROOT',
		'TMPDIR',
	]) {
		const value = process.env[name];
		if (value) environment[name] = value;
	}
	return environment;
}

function nativeSourceIdentity() {
	const gitEnvironment = allowlistedBuildEnvironment();
	const commit = commandOutput(
		'git',
		['rev-parse', 'HEAD'],
		desktopDirectory,
		gitEnvironment
	);
	if (!/^[a-f0-9]{40}$/.test(commit)) {
		fail('A clean Git commit identity is required to build native helpers.');
	}
	const dirty = commandOutput(
		'git',
		[
			'status',
			'--porcelain=v1',
			'--untracked-files=all',
			'--',
			'native',
			'scripts/build-native-helpers.mjs',
			'scripts/verify-vendored-simslim.mjs',
		],
		desktopDirectory,
		gitEnvironment
	);
	if (!dirty) return commit;
	const digest = hashSourceTree([
		goPackage,
		cliPackage,
		swiftPackage,
		resolve(scriptDirectory, 'build-native-helpers.mjs'),
		resolve(scriptDirectory, 'verify-vendored-simslim.mjs'),
	]);
	return `${commit}-dirty:${digest}`;
}

function hashSourceTree(entries) {
	const files = entries.flatMap(collectSourceFiles).sort();
	const hash = createHash('sha256');
	for (const filePath of files) {
		const sourcePath = relative(desktopDirectory, filePath);
		hash.update(sourcePath);
		hash.update('\0');
		hash.update(readFileSync(filePath));
		hash.update('\0');
	}
	return hash.digest('hex');
}

function collectSourceFiles(entryPath) {
	const metadata = lstatSync(entryPath);
	if (metadata.isSymbolicLink()) {
		fail(`Native source identity cannot include a symbolic link: ${entryPath}`);
	}
	if (metadata.isFile()) return [entryPath];
	if (!metadata.isDirectory()) {
		fail(`Native source identity contains a non-regular path: ${entryPath}`);
	}
	return readdirSync(entryPath, { withFileTypes: true }).flatMap((entry) => {
		if (['.build', '.swiftpm'].includes(entry.name)) return [];
		return collectSourceFiles(resolve(entryPath, entry.name));
	});
}

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
