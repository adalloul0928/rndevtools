import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { UpdateOperation, UpdateState } from '../shared/update-protocol';

type UpdateClient = Pick<EventEmitter, 'on'> & {
	checkForUpdates(): Promise<unknown>;
	downloadUpdate(): Promise<unknown>;
	quitAndInstall(): void;
};

const releaseSchema = z.object({
	version: z
		.string()
		.max(64)
		.regex(/^\d+\.\d+\.\d+$/),
});

export function supportsUpdates(
	packaged: boolean,
	platform: string,
	arch: string,
	releaseMode: unknown
): boolean {
	return (
		packaged &&
		platform === 'darwin' &&
		arch === 'arm64' &&
		releaseMode === 'public'
	);
}

export class UpdateService {
	private state: UpdateState;
	private busy = false;
	private stopped = false;
	private startupTimer?: NodeJS.Timeout;
	private interval?: NodeJS.Timeout;

	constructor(
		private readonly dependencies: {
			currentVersion: string;
			updater?: UpdateClient | undefined;
			nativeUpdater?: Pick<EventEmitter, 'on'> | undefined;
			publish: (state: UpdateState) => void;
			requestQuit: () => void;
		}
	) {
		this.state = {
			status: dependencies.updater ? 'idle' : 'unsupported',
			currentVersion: dependencies.currentVersion,
		};
		const updater = dependencies.updater;
		if (!updater) return;
		updater.on('update-available', (info: unknown) => {
			if (this.state.status !== 'checking') return;
			const parsed = releaseSchema.safeParse(info);
			if (!parsed.success) return this.fail();
			this.set({ status: 'available', version: parsed.data.version });
		});
		updater.on('update-not-available', () => {
			if (this.state.status === 'checking') this.set({ status: 'current' });
		});
		updater.on('download-progress', (value: unknown) => {
			if (this.state.status !== 'downloading') return;
			const parsed = z
				.object({ percent: z.number().min(0).max(100) })
				.safeParse(value);
			if (!parsed.success) return;
			const percent = Math.floor(parsed.data.percent);
			if (percent !== this.state.percent) this.set({ ...this.state, percent });
		});
		updater.on('update-downloaded', () => {
			if (this.state.status === 'downloading')
				this.set({ ...this.state, status: 'verifying', percent: 100 });
		});
		// Squirrel verifies the code signature after electron-updater verifies the ZIP checksum.
		dependencies.nativeUpdater?.on('update-downloaded', () => {
			if (this.state.status === 'verifying')
				this.set({ ...this.state, status: 'ready' });
		});
		updater.on('error', () => this.fail());
	}

	getState(): UpdateState {
		return { ...this.state };
	}

	start(): void {
		if (!this.dependencies.updater || this.interval || this.stopped) return;
		this.startupTimer = setTimeout(() => this.run('check'), 10_000);
		this.interval = setInterval(() => this.run('check'), 6 * 60 * 60_000);
		this.startupTimer.unref();
		this.interval.unref();
	}

	stop(): void {
		this.stopped = true;
		clearTimeout(this.startupTimer);
		clearInterval(this.interval);
	}

	run(operation: UpdateOperation): UpdateState {
		const updater = this.dependencies.updater;
		if (!updater || this.stopped) return this.getState();
		if (operation === 'install') {
			if (this.state.status === 'ready') {
				this.set({ ...this.state, status: 'installing' });
				this.dependencies.requestQuit();
			}
		} else if (!this.busy) {
			if (
				operation === 'check' &&
				['idle', 'current', 'error'].includes(this.state.status)
			) {
				this.set({ status: 'checking' });
				this.perform(() => updater.checkForUpdates());
			} else if (
				operation === 'download' &&
				this.state.status === 'available'
			) {
				this.set({ ...this.state, status: 'downloading', percent: 0 });
				this.perform(() => updater.downloadUpdate());
			}
		}
		return this.getState();
	}

	installOnQuit(): boolean {
		if (this.state.status !== 'installing') return false;
		this.dependencies.updater?.quitAndInstall();
		return true;
	}

	private perform(operation: () => Promise<unknown>): void {
		this.busy = true;
		void Promise.resolve()
			.then(operation)
			.catch(() => this.fail())
			.finally(() => {
				this.busy = false;
			});
	}

	private fail(): void {
		this.set({
			status: 'error',
			version: this.state.version,
			error:
				'Could not complete the update. Check your connection and try again.',
		});
	}

	private set(state: Omit<UpdateState, 'currentVersion'>): void {
		if (this.stopped) return;
		this.state = { ...state, currentVersion: this.dependencies.currentVersion };
		this.dependencies.publish(this.getState());
	}
}
