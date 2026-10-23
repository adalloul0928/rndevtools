import { RetainedEventBuffer } from './retained-event-buffer';

type Listener = () => void;

export type BoundedEventStoreOptions<T> = {
	maxEvents: number;
	maxBytes: number;
	estimateBytes: (event: T) => number;
};

export class BoundedEventStore<T> {
	readonly #listeners = new Set<Listener>();
	readonly #maxBytes: number;
	readonly #estimateBytes: (event: T) => number;
	readonly #buffer: RetainedEventBuffer<T>;

	constructor(options: BoundedEventStoreOptions<T>) {
		if (!Number.isInteger(options.maxEvents) || options.maxEvents <= 0) {
			throw new Error('maxEvents must be a positive integer');
		}
		if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0) {
			throw new Error('maxBytes must be a positive finite number');
		}
		this.#buffer = new RetainedEventBuffer(options.maxEvents, options.maxBytes);
		this.#maxBytes = options.maxBytes;
		this.#estimateBytes = options.estimateBytes;
	}

	append(event: T): void {
		const eventBytes = this.#eventBytes(event);
		if (eventBytes > this.#maxBytes) {
			return;
		}

		this.#buffer.append(event, eventBytes);
		this.#emit();
	}

	replace(predicate: (event: T) => boolean, event: T): boolean {
		if (!this.#buffer.replace(predicate, event, () => this.#eventBytes(event)))
			return false;
		this.#emit();
		return true;
	}

	upsert(predicate: (event: T) => boolean, event: T): void {
		if (!this.replace(predicate, event)) this.append(event);
	}

	/** Removes a confirmed subset in one notification, preserving admitted sizes. */
	remove(predicate: (event: T) => boolean): void {
		if (!this.#buffer.remove(predicate)) return;
		this.#emit();
	}

	clear = (): void => {
		if (this.#buffer.length === 0) return;
		this.#buffer.clear();
		this.#emit();
	};

	getSnapshot = (): readonly T[] => this.#buffer.getSnapshot();

	getServerSnapshot = (): readonly T[] => this.#buffer.getSnapshot();

	getEstimatedBytes = (): number => this.#buffer.bytes;

	subscribe = (listener: Listener): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	#emit(): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener();
			} catch {
				// A diagnostics observer must never interrupt the instrumented app.
			}
		}
	}

	#eventBytes(event: T): number {
		try {
			const estimate = this.#estimateBytes(event);
			if (!Number.isFinite(estimate)) return this.#maxBytes + 1;
			return Math.max(0, Math.ceil(estimate));
		} catch {
			return this.#maxBytes + 1;
		}
	}
}

export class ExternalStore<T> {
	readonly #listeners = new Set<Listener>();
	#snapshot: T;

	constructor(initialSnapshot: T) {
		this.#snapshot = initialSnapshot;
	}

	set(snapshot: T): void {
		this.#snapshot = snapshot;
		for (const listener of [...this.#listeners]) {
			try {
				listener();
			} catch {
				// A diagnostics observer must never interrupt the instrumented app.
			}
		}
	}

	getSnapshot = (): T => this.#snapshot;

	getServerSnapshot = (): T => this.#snapshot;

	subscribe = (listener: Listener): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
}
