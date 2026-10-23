import { readFileSync } from 'node:fs';
import path from 'node:path';
import { app, autoUpdater } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateState } from '../shared/update-protocol';
import { supportsUpdates, UpdateService } from './update-service';

export function createDesktopUpdater(
	publish: (state: UpdateState) => void
): UpdateService {
	const metadata: unknown = app.isPackaged
		? JSON.parse(
				readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')
			)
		: null;
	const releaseMode =
		metadata &&
		typeof metadata === 'object' &&
		'rndevtoolsReleaseMode' in metadata
			? metadata.rndevtoolsReleaseMode
			: undefined;
	const supported = supportsUpdates(
		app.isPackaged,
		process.platform,
		process.arch,
		releaseMode
	);
	const updater = supported ? new electronUpdater.MacUpdater() : undefined;
	if (updater) {
		updater.autoDownload = false;
		updater.autoInstallOnAppQuit = true;
		updater.allowPrerelease = false;
		updater.allowDowngrade = false;
		updater.logger = null;
	}
	return new UpdateService({
		currentVersion: app.getVersion(),
		updater,
		nativeUpdater: supported ? autoUpdater : undefined,
		publish,
		requestQuit: () => {
			setImmediate(() => app.quit());
		},
	});
}
