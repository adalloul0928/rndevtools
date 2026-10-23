type Entry<T> = { value: T; bytes: number };

/** Bounded FIFO storage. Immutable arrays are materialized only for readers. */
export class RetainedEventBuffer<T> {
	readonly #maxEvents: number;
	readonly #maxBytes: number;
	#entries: Array<Entry<T> | undefined> = [];
	#head = 0;
	#count = 0;
	#bytes = 0;
	#snapshot: readonly T[] | undefined = Object.freeze([]);

	constructor(maxEvents: number, maxBytes: number) {
		this.#maxEvents = maxEvents;
		this.#maxBytes = maxBytes;
	}

	get length(): number {
		return this.#count;
	}
	get bytes(): number {
		return this.#bytes;
	}

	append(value: T, bytes: number): number {
		let evicted = 0;
		while (
			this.#count > 0 &&
			(this.#count === this.#maxEvents || this.#bytes + bytes > this.#maxBytes)
		) {
			const entry = this.#entries[this.#head];
			this.#bytes -= entry?.bytes ?? 0;
			this.#entries[this.#head] = undefined;
			this.#head = (this.#head + 1) % this.#maxEvents;
			this.#count -= 1;
			evicted += 1;
		}
		this.#entries[(this.#head + this.#count) % this.#maxEvents] = {
			value,
			bytes,
		};
		this.#count += 1;
		this.#bytes += bytes;
		this.#snapshot = undefined;
		return evicted;
	}

	replace(
		predicate: (value: T) => boolean,
		value: T,
		estimate: () => number,
	): boolean {
		const entries = [...this.#retainedEntries()];
		const index = entries.findIndex((entry) => predicate(entry.value));
		if (index < 0) return false;
		const bytes = estimate();
		if (bytes > this.#maxBytes) entries.splice(index, 1);
		else entries[index] = { value, bytes };
		this.#reset(entries);
		return true;
	}

	remove(predicate: (value: T) => boolean): boolean {
		const entries = [...this.#retainedEntries()].filter(
			(entry) => !predicate(entry.value),
		);
		if (entries.length === this.#count) return false;
		this.#reset(entries);
		return true;
	}

	clear(): void {
		this.#entries = [];
		this.#head = 0;
		this.#count = 0;
		this.#bytes = 0;
		this.#snapshot = undefined;
	}

	getSnapshot(): readonly T[] {
		this.#snapshot ??= Object.freeze(
			Array.from(this.#retainedEntries(), (entry) => entry.value),
		);
		return this.#snapshot;
	}

	*#retainedEntries(): Generator<Entry<T>> {
		for (let offset = 0; offset < this.#count; offset += 1) {
			const entry = this.#entries[(this.#head + offset) % this.#maxEvents];
			if (entry) yield entry;
		}
	}

	#reset(entries: readonly Entry<T>[]): void {
		this.clear();
		for (const entry of entries) this.append(entry.value, entry.bytes);
	}
}
