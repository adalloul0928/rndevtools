import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	packaged: false,
	readFileSync: vi.fn(),
	quit: vi.fn(),
	create: vi.fn(),
}));

vi.mock('node:fs', () => ({ readFileSync: mocks.readFileSync }));
vi.mock('electron', () => ({
	app: {
		get isPackaged() {
			return mocks.packaged;
		},
		getAppPath: () => '/example/RN Devtools.app/Contents/Resources/app.asar',
		getVersion: () => '0.2.0',
		quit: mocks.quit,
	},
	autoUpdater: new EventEmitter(),
}));
vi.mock('electron-updater', () => ({
	default: {
		MacUpdater: class extends EventEmitter {
			autoDownload = true;
			autoInstallOnAppQuit = false;
			allowPrerelease = true;
			allowDowngrade = true;
			constructor() {
				super();
				mocks.create(this);
			}
		},
	},
}));

import { createDesktopUpdater } from './desktop-updater';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	mocks.packaged = false;
});

it('does not construct or contact an updater for source and local packages', () => {
	expect(createDesktopUpdater(vi.fn()).getState().status).toBe('unsupported');
	expect(mocks.readFileSync).not.toHaveBeenCalled();
	mocks.packaged = true;
	mocks.readFileSync.mockReturnValue(
		JSON.stringify({ rndevtoolsReleaseMode: 'local-development' })
	);
	expect(createDesktopUpdater(vi.fn()).getState().status).toBe('unsupported');
	expect(mocks.create).not.toHaveBeenCalled();
});

it('requires a user download, excludes prereleases and downgrades, and stages for signature verification', () => {
	vi.stubGlobal('process', { ...process, platform: 'darwin', arch: 'arm64' });
	mocks.packaged = true;
	mocks.readFileSync.mockReturnValue(
		JSON.stringify({ rndevtoolsReleaseMode: 'public' })
	);
	expect(createDesktopUpdater(vi.fn()).getState().status).toBe('idle');
	const updater = mocks.create.mock.calls[0]?.[0];
	expect(updater.autoDownload).toBe(false);
	expect(updater.autoInstallOnAppQuit).toBe(true);
	expect(updater.allowPrerelease).toBe(false);
	expect(updater.allowDowngrade).toBe(false);
	expect(mocks.quit).not.toHaveBeenCalled();
});
