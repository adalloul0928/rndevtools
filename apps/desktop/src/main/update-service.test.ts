import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { supportsUpdates, UpdateService } from './update-service';

class Updater extends EventEmitter {
	checkForUpdates = vi.fn(async () => {});
	downloadUpdate = vi.fn(async () => {});
	quitAndInstall = vi.fn();
}

function setup(enabled = true) {
	const updater = new Updater();
	const nativeUpdater = new EventEmitter();
	const publish = vi.fn();
	const requestQuit = vi.fn();
	const service = new UpdateService({
		currentVersion: '0.2.0',
		updater: enabled ? updater : undefined,
		nativeUpdater,
		publish,
		requestQuit,
	});
	return { service, updater, nativeUpdater, publish, requestQuit };
}

async function flush() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function available(context: ReturnType<typeof setup>) {
	context.service.run('check');
	await flush();
	context.updater.emit('update-available', {
		version: '0.3.0',
		releaseNotes: 'not sent to the renderer',
	});
}

afterEach(() => vi.useRealTimers());

describe('desktop updates', () => {
	it('enables only public packaged Apple silicon releases', () => {
		expect(supportsUpdates(true, 'darwin', 'arm64', 'public')).toBe(true);
		for (const inputs of [
			[false, 'darwin', 'arm64', 'public'],
			[true, 'darwin', 'arm64', 'local-development'],
			[true, 'darwin', 'x64', 'public'],
			[true, 'win32', 'arm64', 'public'],
			[true, 'darwin', 'arm64', undefined],
		] as const) {
			expect(supportsUpdates(inputs[0], inputs[1], inputs[2], inputs[3])).toBe(
				false
			);
		}
		vi.useFakeTimers();
		const context = setup(false);
		context.service.start();
		for (const operation of ['check', 'download', 'install'] as const)
			context.service.run(operation);
		expect(vi.getTimerCount()).toBe(0);
		expect(context.service.getState().status).toBe('unsupported');
		expect(context.requestQuit).not.toHaveBeenCalled();
	});

	it('checks on startup and periodically without downloading or duplicating checks', async () => {
		vi.useFakeTimers();
		const context = setup();
		context.service.start();
		context.service.start();
		await vi.advanceTimersByTimeAsync(10_000);
		context.service.run('check');
		expect(context.updater.checkForUpdates).toHaveBeenCalledTimes(1);
		context.updater.emit('update-not-available');
		await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
		expect(context.updater.checkForUpdates).toHaveBeenCalledTimes(2);
		expect(context.updater.downloadUpdate).not.toHaveBeenCalled();
		context.service.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('requires an explicit download and native signature verification before restart', async () => {
		const context = setup();
		await available(context);
		expect(context.service.getState()).toEqual({
			status: 'available',
			currentVersion: '0.2.0',
			version: '0.3.0',
		});
		expect(context.updater.downloadUpdate).not.toHaveBeenCalled();
		context.service.run('install');
		expect(context.requestQuit).not.toHaveBeenCalled();
		context.service.run('download');
		context.service.run('download');
		await flush();
		expect(context.updater.downloadUpdate).toHaveBeenCalledTimes(1);
		context.updater.emit('download-progress', { percent: 42.75 });
		expect(context.service.getState().percent).toBe(42);
		context.updater.emit('update-downloaded');
		expect(context.service.getState().status).toBe('verifying');
		context.service.run('install');
		expect(context.requestQuit).not.toHaveBeenCalled();
		context.nativeUpdater.emit('update-downloaded');
		expect(context.service.getState().status).toBe('ready');
		context.service.run('check');
		expect(context.service.getState().status).toBe('ready');
		context.service.run('install');
		context.service.run('install');
		expect(context.requestQuit).toHaveBeenCalledTimes(1);
		expect(context.updater.quitAndInstall).not.toHaveBeenCalled();
		context.service.stop();
		expect(context.service.installOnQuit()).toBe(true);
		expect(context.updater.quitAndInstall).toHaveBeenCalledTimes(1);
	});

	it('keeps progress bounded and ignores events outside an active download', async () => {
		const context = setup();
		context.updater.emit('update-downloaded');
		context.nativeUpdater.emit('update-downloaded');
		expect(context.service.getState().status).toBe('idle');
		await available(context);
		context.service.run('download');
		await flush();
		for (const percent of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY, '50'])
			context.updater.emit('download-progress', { percent });
		expect(context.service.getState().percent).toBe(0);
	});

	it('rejects malformed and prerelease metadata before offering a download', async () => {
		for (const version of ['0.3.0-beta.1', '<script>', '1'.repeat(100)]) {
			const context = setup();
			context.service.run('check');
			await flush();
			context.updater.emit('update-available', { version });
			expect(context.service.getState().status).toBe('error');
			context.service.run('download');
			expect(context.updater.downloadUpdate).not.toHaveBeenCalled();
		}
	});

	it('recovers from network failure without exposing URLs, paths or tokens', async () => {
		const context = setup();
		context.updater.checkForUpdates.mockRejectedValueOnce(
			new Error('https://example.com/?token=private')
		);
		context.service.run('check');
		await flush();
		expect(context.service.getState().status).toBe('error');
		expect(JSON.stringify(context.publish.mock.calls)).not.toContain('private');
		await available(context);
		expect(context.service.getState().status).toBe('available');
	});

	it('never offers a restart after a signature failure or shutdown', async () => {
		const context = setup();
		await available(context);
		context.service.run('download');
		await flush();
		context.updater.emit('update-downloaded');
		context.updater.emit(
			'error',
			new Error('Invalid signature /Users/example/update.zip')
		);
		context.nativeUpdater.emit('update-downloaded');
		expect(context.service.getState().status).toBe('error');
		context.service.run('install');
		expect(context.service.installOnQuit()).toBe(false);
		expect(context.requestQuit).not.toHaveBeenCalled();
		context.service.stop();
		context.publish.mockClear();
		context.updater.emit('error', new Error('late failure'));
		context.service.run('check');
		expect(context.publish).not.toHaveBeenCalled();
	});
});
