import { randomUUID } from 'node:crypto';
import {
	chmod,
	lstat,
	mkdir,
	opendir,
	readFile,
	rename,
	unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { type Lane, laneSchema } from '../shared/lane-protocol';
import { isMissing, writeFileAtomic } from './private-files';

const storedLanesSchema = z.strictObject({
	version: z.literal(1),
	lanes: z.array(laneSchema).max(64),
	repositories: z.array(z.string().min(2).max(1_024)).max(32),
});
type StoredLanes = z.infer<typeof storedLanesSchema>;

const LANE_LOG_NAME =
	/^lane-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.log$/i;
const MAX_LOG_PRUNE_ENTRIES = 2_048;

/** Detached Metro processes outlive the desktop, so their leases must persist. */
export class LaneStore {
	readonly #root: string;
	readonly #file: string;
	#data: StoredLanes = { version: 1, lanes: [], repositories: [] };
	#writeQueue: Promise<void> = Promise.resolve();
	#loaded = false;

	constructor(root: string) {
		this.#root = path.resolve(root);
		this.#file = path.join(this.#root, 'lanes.json');
	}

	logPathFor(laneId: string): string {
		return path.join(this.#root, 'logs', `${laneId}.log`);
	}

	async start(): Promise<void> {
		this.#loaded = false;
		await mkdir(path.join(this.#root, 'logs'), {
			recursive: true,
			mode: 0o700,
		});
		await chmod(this.#root, 0o700);
		try {
			const raw = await readFile(this.#file, 'utf8');
			const parsed = storedLanesSchema.safeParse(JSON.parse(raw));
			if (parsed.success) this.#data = parsed.data;
			else await this.#quarantine();
		} catch (error) {
			if (error instanceof SyntaxError) await this.#quarantine();
			else if (!isMissing(error)) throw error;
		}
		this.#loaded = true;
	}

	/** Prune old, unowned logs without following symlinks. */
	async pruneLogs(maxAgeMs: number, now = Date.now()): Promise<number> {
		const directory = path.join(this.#root, 'logs');
		const current = new Set(
			this.#data.lanes.flatMap((lane) => [
				`${lane.id}.log`,
				path.basename(lane.logPath),
			])
		);
		let removed = 0;
		let seen = 0;
		try {
			for await (const entry of await opendir(directory)) {
				seen += 1;
				if (seen > MAX_LOG_PRUNE_ENTRIES) break;
				if (
					!entry.isFile() ||
					!LANE_LOG_NAME.test(entry.name) ||
					current.has(entry.name)
				) {
					continue;
				}
				const file = path.join(directory, entry.name);
				try {
					const info = await lstat(file);
					if (!info.isFile() || now - info.mtimeMs < maxAgeMs) continue;
					await unlink(file);
					removed += 1;
				} catch {
					// Pruning is best-effort.
				}
			}
		} catch {
			// Pruning is best-effort.
		}
		return removed;
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
		await this.#update((data) => {
			const found = data.lanes.some(
				(candidate) => candidate.id === validated.id
			);
			return {
				...data,
				lanes: found
					? data.lanes.map((candidate) =>
							candidate.id === validated.id ? validated : candidate
						)
					: [...data.lanes, validated],
			};
		});
	}

	remove(laneId: string): Promise<boolean> {
		return this.#update((data) => {
			const lanes = data.lanes.filter((lane) => lane.id !== laneId);
			return lanes.length === data.lanes.length
				? undefined
				: { ...data, lanes };
		});
	}

	async addRepository(root: string): Promise<void> {
		const resolved = path.resolve(root);
		await this.#update((data) => {
			if (data.repositories.includes(resolved)) return undefined;
			if (data.repositories.length >= 32) {
				throw new Error('At most 32 repositories can be tracked for lanes.');
			}
			return { ...data, repositories: [...data.repositories, resolved] };
		});
	}

	removeRepository(root: string): Promise<boolean> {
		const resolved = path.resolve(root);
		return this.#update((data) => {
			const repositories = data.repositories.filter(
				(entry) => entry !== resolved
			);
			return repositories.length === data.repositories.length
				? undefined
				: { ...data, repositories };
		});
	}

	async #quarantine(): Promise<void> {
		await rename(this.#file, `${this.#file}.corrupt-${Date.now()}`);
	}

	#update(
		operation: (data: StoredLanes) => StoredLanes | undefined
	): Promise<boolean> {
		const write = this.#writeQueue.then(async () => {
			if (!this.#loaded)
				throw new Error('Lane storage must load successfully before writing.');
			const next = operation(this.#data);
			if (!next) return false;
			const validated = storedLanesSchema.parse(next);
			await writeFileAtomic(
				this.#file,
				JSON.stringify(validated, null, '\t'),
				'lanes'
			);
			this.#data = validated;
			return true;
		});
		this.#writeQueue = write.then(
			() => undefined,
			() => undefined
		);
		return write;
	}
}
