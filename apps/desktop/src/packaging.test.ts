import { createRequire } from 'node:module';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { describe, expect, it } from 'vitest';

type AfterPackHook = ((context: unknown) => Promise<void>) & {
	readonly fuseOptions: Readonly<Record<string, boolean | FuseVersion>>;
};

const require = createRequire(import.meta.url);
const afterPack = require('../scripts/after-pack.cjs') as AfterPackHook;
const beforeBuild = require('../scripts/before-build.cjs') as () => Promise<boolean>;

describe('desktop packaging safeguards', () => {
	it('bundles runtime dependencies before electron-builder scans the monorepo', async () => {
		await expect(beforeBuild()).resolves.toBe(false);
	});

	it('locks down Electron escape hatches in packaged binaries', () => {
		expect(afterPack.fuseOptions).toMatchObject({
			version: FuseVersion.V1,
			strictlyRequireAllFuses: true,
			[FuseV1Options.RunAsNode]: false,
			[FuseV1Options.EnableCookieEncryption]: true,
			[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
			[FuseV1Options.EnableNodeCliInspectArguments]: false,
			[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
			[FuseV1Options.OnlyLoadAppFromAsar]: true,
			[FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
		});
		expect(Object.isFrozen(afterPack.fuseOptions)).toBe(true);
	});
});
