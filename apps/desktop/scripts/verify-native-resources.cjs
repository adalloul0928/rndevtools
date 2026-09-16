const { createHash, randomUUID } = require('node:crypto');
const {
	lstatSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} = require('node:fs');
const path = require('node:path');

const expectedHelperFiles = Object.freeze({
	simulator: 'rndevtools-sim-helper',
	nativeHost: 'rndevtools-native-host',
	cli: 'rndevtools',
});

function verifyNativeResources(resourcesDirectory) {
	const resolvedDirectory = path.resolve(resourcesDirectory);
	const manifest = readSupportedManifest(resolvedDirectory);
	for (const [key, expectedFile] of Object.entries(expectedHelperFiles)) {
		const { data, stats } = inspectHelper(resolvedDirectory, key, expectedFile);
		const helper = manifest.helpers[key];
		const digest = createHash('sha256').update(data).digest('hex');
		if (stats.size !== helper.size || digest !== helper.sha256) {
			throw new Error(
				`Native helper ${key} does not match its integrity manifest.`
			);
		}
	}
	return manifest;
}

function readSupportedManifest(resolvedDirectory) {
	const manifestPath = path.join(resolvedDirectory, 'manifest.json');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	if (
		manifest.schemaVersion !== 1 ||
		manifest.platform !== 'darwin' ||
		!['arm64', 'x64'].includes(manifest.architecture) ||
		manifest.protocolVersion !== 2 ||
		manifest.compatibilityMatrixVersion !== '2026-09-03-v2' ||
		manifest.catalog?.version !== 'simslim-v0.8.0-09fc9cbb-pumpd.1-presets.2' ||
		manifest.catalog?.upstreamCommit !==
			'09fc9cbbca35db5230e6d571a0a366fe6876266e' ||
		manifest.catalog?.patchSet !== 'pumpd.1' ||
		manifest.catalog?.upstreamSourceManifestSha256 !==
			'8a7681f26eb84be6b5a84a1326973c35c1ba4320e27c706655d3eed8bd31af08' ||
		manifest.catalog?.patchSha256 !==
			'69bef9b9d08e900652acb77fd13463f6bc5f8735df1aa994ba6be6d353146083' ||
		manifest.catalog?.vendoredSourceManifestSha256 !==
			'b2045d5332b79e52875d592189f37de2c817c12a341cddbb75499f3085b0e4c7'
	) {
		throw new Error('Native resource manifest has an unsupported format.');
	}
	if (
		typeof manifest.buildCommit !== 'string' ||
		!/^[a-f0-9]{40}(?:-dirty:[a-f0-9]{64})?$/.test(manifest.buildCommit)
	) {
		throw new Error(
			'Native resource manifest has an unsupported build identity.'
		);
	}
	for (const [key, expectedFile] of Object.entries(expectedHelperFiles)) {
		const helper = manifest.helpers?.[key];
		if (
			!helper ||
			helper.name !== expectedFile ||
			helper.file !== expectedFile ||
			helper.file !== helper.name ||
			!/^rndevtools(?:-[a-z-]+)?$/.test(helper.file)
		) {
			throw new Error(`Native resource manifest is missing ${key}.`);
		}
	}
	return manifest;
}

function inspectHelper(resolvedDirectory, key, expectedFile) {
	const helperPath = path.join(resolvedDirectory, expectedFile);
	const relativePath = path.relative(resolvedDirectory, helperPath);
	if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
		throw new Error(`Native helper ${key} escapes its resource directory.`);
	}
	const stats = lstatSync(helperPath);
	if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o111) === 0) {
		throw new Error(`Native helper ${key} is not a regular executable file.`);
	}
	return { data: readFileSync(helperPath), stats };
}

function refreshNativeResourceManifest(resourcesDirectory, verifiedManifest) {
	const resolvedDirectory = path.resolve(resourcesDirectory);
	const manifestPath = path.join(resolvedDirectory, 'manifest.json');
	const manifest = readSupportedManifest(resolvedDirectory);
	if (
		!verifiedManifest ||
		JSON.stringify(manifest) !== JSON.stringify(verifiedManifest)
	) {
		throw new Error(
			'Refreshing a native resource manifest requires the exact previously verified manifest.'
		);
	}
	const helpers = {};
	for (const [key, expectedFile] of Object.entries(expectedHelperFiles)) {
		const { data, stats } = inspectHelper(resolvedDirectory, key, expectedFile);
		helpers[key] = {
			...manifest.helpers[key],
			sha256: createHash('sha256').update(data).digest('hex'),
			size: stats.size,
		};
	}

	const refreshedManifest = { ...manifest, helpers };
	const temporaryPath = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
	try {
		writeFileSync(
			temporaryPath,
			`${JSON.stringify(refreshedManifest, null, 2)}\n`,
			{
				encoding: 'utf8',
				flag: 'wx',
				mode: 0o644,
			}
		);
		renameSync(temporaryPath, manifestPath);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch (cleanupError) {
			if (cleanupError?.code !== 'ENOENT') {
				throw new AggregateError(
					[error, cleanupError],
					'Failed to refresh the native resource manifest and clean up its temporary file.'
				);
			}
		}
		throw error;
	}
	return refreshedManifest;
}

if (require.main === module) {
	if (process.argv.length > 3) {
		process.stderr.write(
			'Usage: node verify-native-resources.cjs [resources-directory]\n'
		);
		process.exit(2);
	}
	try {
		const resourcesDirectory =
			process.argv[2] ??
			path.join(__dirname, '..', 'build', 'native', `mac-${process.arch}`);
		const manifest = verifyNativeResources(resourcesDirectory);
		process.stdout.write(
			`Verified native resources for mac-${manifest.architecture}.\n`
		);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exit(1);
	}
}

module.exports = verifyNativeResources;
module.exports.refreshNativeResourceManifest = refreshNativeResourceManifest;
