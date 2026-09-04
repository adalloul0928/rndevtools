import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const MAX_SETTINGS_BYTES = 64 * 1024;
const settingsSchema = z.strictObject({
	version: z.literal(1),
	xcodeDeveloperDirectory: z
		.string()
		.min(1)
		.max(4 * 1024)
		.optional(),
});
type DesktopSettings = z.infer<typeof settingsSchema>;

export class DesktopSettingsStore {
	readonly #directory: string;
	readonly #filePath: string;
	#settings: DesktopSettings = { version: 1 };
	#writeQueue: Promise<void> = Promise.resolve();

	constructor(directory: string) {
		this.#directory = path.resolve(directory);
		this.#filePath = path.join(this.#directory, 'settings-v1.json');
	}

	async load(): Promise<DesktopSettings> {
		await mkdir(this.#directory, { recursive: true, mode: 0o700 });
		await chmod(this.#directory, 0o700);
		try {
			const text = await readFile(this.#filePath, 'utf8');
			if (Buffer.byteLength(text, 'utf8') > MAX_SETTINGS_BYTES) {
				throw new Error('Desktop settings exceed the safe size limit.');
			}
			this.#settings = settingsSchema.parse(JSON.parse(text) as unknown);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			this.#settings = { version: 1 };
		}
		return { ...this.#settings };
	}

	async setXcodeDeveloperDirectory(value: string | undefined): Promise<void> {
		const nextSettings = settingsSchema.parse({
			version: 1,
			...(value ? { xcodeDeveloperDirectory: value } : {}),
		});
		const snapshot = JSON.stringify(nextSettings);
		const write = this.#writeQueue
			.catch(() => undefined)
			.then(async () => {
				await this.#writeAtomically(snapshot);
				this.#settings = nextSettings;
			});
		this.#writeQueue = write;
		await write;
	}

	async #writeAtomically(contents: string): Promise<void> {
		await mkdir(this.#directory, { recursive: true, mode: 0o700 });
		await chmod(this.#directory, 0o700);
		const temporaryPath = path.join(
			this.#directory,
			`.settings-v1-${process.pid}-${randomUUID()}.tmp`
		);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporaryPath, 'wx', 0o600);
			await handle.writeFile(`${contents}\n`, 'utf8');
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporaryPath, this.#filePath);
		} finally {
			await handle?.close().catch(() => undefined);
			await unlink(temporaryPath).catch(() => undefined);
		}
	}
}
