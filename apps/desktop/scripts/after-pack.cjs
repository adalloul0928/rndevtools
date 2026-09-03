const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses');

const execFileAsync = promisify(execFile);

const fuseOptions = Object.freeze({
	version: FuseVersion.V1,
	strictlyRequireAllFuses: true,
	[FuseV1Options.RunAsNode]: false,
	[FuseV1Options.EnableCookieEncryption]: true,
	[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
	[FuseV1Options.EnableNodeCliInspectArguments]: false,
	[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
	[FuseV1Options.OnlyLoadAppFromAsar]: true,
	[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
	[FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
	[FuseV1Options.WasmTrapHandlers]: true,
});

module.exports = async function afterPack(context) {
	const executableName = context.packager.appInfo.productFilename;
	const executablePath =
		context.electronPlatformName === 'darwin'
			? path.join(
					context.appOutDir,
					`${executableName}.app`,
					'Contents',
					'MacOS',
					executableName
				)
			: path.join(
					context.appOutDir,
					context.electronPlatformName === 'win32'
						? `${executableName}.exe`
						: executableName
				);

	await flipFuses(executablePath, fuseOptions);

	// Flipping fuses invalidates Electron's upstream ad-hoc signature, and macOS
	// SIGKILLs a bundle whose signature no longer matches. Re-seal every darwin
	// pack: electron-builder signs after this hook, so a real Developer ID
	// signature simply replaces this one. Gating on a signing environment
	// variable instead would leave a developer without a certificate holding an
	// app that Gatekeeper refuses to launch.
	if (context.electronPlatformName === 'darwin') {
		await execFileAsync('/usr/bin/codesign', [
			'--force',
			'--deep',
			'--sign',
			'-',
			path.join(context.appOutDir, `${executableName}.app`),
		]);
	}
};

module.exports.fuseOptions = fuseOptions;
