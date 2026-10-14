import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { type Lane, laneSchema } from '../shared/lane-protocol';

const storedLanesSchema = z.strictObject({
	version: z.literal(1),
	lanes: z.array(laneSchema).max(64),
	repositories: z.array(z.string().min(2).max(1_024)).max(32),
});
type StoredLanes = z.infer<typeof storedLanesSchema>;

/**
 * Durable lane leases. Metro processes are detached and outlive the desktop
 * app, so leases must survive a restart: on boot the service reads this file,
 * checks which Metro PIDs are still alive, and reclaims the rest. A JSON file
 * with an atomic rename is enough here; there is no query pattern that would
 * justify SQLite.
 */
export class LaneStore {
	readonly #root: string;
	readonly #file: string;
	#data: StoredLanes = { version: 1, lanes: [], repositories: [] };
	#writeQueue: Promise<void> = Promise.resolve();

	constructor(root: string) {
		this.#root = path.resolve(root);
		this.#file = path.join(this.#root, 'lanes.json');
	}

	get root(): string {
		return this.#root;
	}

	logPathFor(laneId: string): string {
		return path.join(this.#root, 'logs', `${laneId}.log`);
	}

	async start(): Promise<void> {
		await mkdir(path.join(this.#root, 'logs'), {
			recursive: true,
			mode: 0o700,
		});
		await chmod(this.#root, 0o700);
		try {
			const raw = await readFile(this.#file, 'utf8');
			const parsed = storedLanesSchema.safeParse(JSON.parse(raw));
			if (parsed.success) this.#data = parsed.data;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				// A corrupt file must not block the app; it is rebuilt from live
				// state and the old copy is kept for inspection.
				await rename(this.#file, `${this.#file}.corrupt-${Date.now()}`).catch(
					() => undefined
				);
			}
		}
	}

	lanes(): Lane[] {
		return this.#data.lanes.map((lane) => structuredClone(lane));
	}

	repositories(): string[] {
		return [...this.#data.repositories];
	}

	get(laneId: string): Lane | undefined {
		const lane = this.#data.lanes.find((candidate) => candidate.id === laneId);
		return lane ? structuredClone(lane) : undefined;
	}

	newLaneId(): string {
		return `lane-${randomUUID()}`;
	}

	async upsert(lane: Lane): Promise<void> {
		const validated = laneSchema.parse(lane);
		const index = this.#data.lanes.findIndex(
			(candidate) => candidate.id === validated.id
		);
		if (index === -1) this.#data.lanes.push(validated);
		else this.#data.lanes[index] = validated;
		await this.#persist();
	}

	async remove(laneId: string): Promise<boolean> {
		const before = this.#data.lanes.length;
		this.#data.lanes = this.#data.lanes.filter((lane) => lane.id !== laneId);
		if (this.#data.lanes.length === before) return false;
		await this.#persist();
		return true;
	}

	async addRepository(root: string): Promise<void> {
		const resolved = path.resolve(root);
		if (this.#data.repositories.includes(resolved)) return;
		if (this.#data.repositories.length >= 32) {
			throw new Error('At most 32 repositories can be tracked for lanes.');
		}
		this.#data.repositories.push(resolved);
		await this.#persist();
	}

	async removeRepository(root: string): Promise<boolean> {
		const resolved = path.resolve(root);
		const before = this.#data.repositories.length;
		this.#data.repositories = this.#data.repositories.filter(
			(candidate) => candidate !== resolved
		);
		if (this.#data.repositories.length === before) return false;
		await this.#persist();
		return true;
	}

	#persist(): Promise<void> {
		const snapshot = JSON.stringify(this.#data, null, '\t');
		this.#writeQueue = this.#writeQueue
			.catch(() => undefined)
			.then(async () => {
				const temporary = `${this.#file}.${process.pid}.tmp`;
				await writeFile(temporary, snapshot, { mode: 0o600 });
				await rename(temporary, this.#file);
			});
		return this.#writeQueue;
	}
}
