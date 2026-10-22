import type { RestorePoint } from './restore-points';
import {
	estimateRestorePointBytes,
	RestorePointRepository,
	type RestorePointStorage,
} from './restore-repository';

const KEY = '@rndevtools/core/restore-points/v1';

function point(id: string, createdAt: number): RestorePoint {
	const withoutSize = {
		id,
		label: id,
		createdAt,
		sources: [
			{
				sourceId: 'state',
				sourceTitle: 'State',
				json: '{"ok":true}',
				preview: '{"ok":true}',
				bytes: 11,
			},
		],
	};
	return {
		...withoutSize,
		estimatedBytes: estimateRestorePointBytes(withoutSize),
	};
}

function documentWith(...points: readonly RestorePoint[]): string {
	return JSON.stringify({
		schemaVersion: 1,
		namespace: 'rndevtools-restore-points',
		points,
	});
}

function createStorage(initial?: string) {
	const values = new Map<string, string>();
	if (initial !== undefined) values.set(KEY, initial);
	let failingReads = 0;
	const setItem = jest.fn((key: string, value: string) => {
		values.set(key, value);
	});
	const removeItem = jest.fn((key: string) => {
		values.delete(key);
	});
	const storage: RestorePointStorage = {
		getItem: async (key) => {
			if (failingReads > 0) {
				failingReads -= 1;
				throw new Error('disk unavailable');
			}
			return values.get(key);
		},
		setItem,
		removeItem,
	};
	return {
		values,
		setItem,
		removeItem,
		storage,
		failReads: (count: number) => {
			failingReads = count;
		},
	};
}

function createRepository(storage: RestorePointStorage) {
	return new RestorePointRepository({
		storage,
		maxPoints: 8,
		maxSourceBytes: 1024,
		maxTotalBytes: 64 * 1024,
	});
}

const REFUSAL =
	'Stored restore points could not be loaded (disk unavailable), so nothing was written. Retry loading them or discard the stored data.';

describe('RestorePointRepository load failures', () => {
	it('refuses every write while the stored document could not be loaded', async () => {
		const stored = point('kept', 1);
		const { storage, setItem, values, failReads } = createStorage(
			documentWith(stored),
		);
		failReads(1);
		const repository = createRepository(storage);
		await repository.ready;

		expect(repository.getLoadError()).toBe('disk unavailable');
		expect(repository.getSnapshot()).toEqual([]);
		await expect(repository.add(point('new', 2))).rejects.toThrow(REFUSAL);
		await expect(repository.rename('kept', 'Renamed')).rejects.toThrow(REFUSAL);
		await expect(repository.remove('kept')).rejects.toThrow(REFUSAL);
		await expect(repository.clear()).rejects.toThrow(REFUSAL);
		await expect(
			repository.importJson(documentWith(point('imported', 3))),
		).rejects.toThrow(REFUSAL);
		await expect(repository.duplicate('kept')).rejects.toThrow(
			'no longer available',
		);
		expect(setItem).not.toHaveBeenCalled();
		expect(values.get(KEY)).toBe(documentWith(stored));
	});

	it('reload() loads the stored points once storage recovers and writes merge with them', async () => {
		const stored = point('kept', 1);
		const { storage, setItem, values, failReads } = createStorage(
			documentWith(stored),
		);
		failReads(1);
		const repository = createRepository(storage);
		const observed: Array<string | undefined> = [];
		repository.subscribeToLoadError(() => {
			observed.push(repository.getLoadError());
		});
		await repository.ready;
		expect(repository.getLoadError()).toBe('disk unavailable');

		await repository.reload();

		expect(repository.getLoadError()).toBeUndefined();
		expect(repository.getServerLoadError()).toBeUndefined();
		expect(observed).toEqual(['disk unavailable', undefined]);
		expect(repository.getSnapshot().map((candidate) => candidate.id)).toEqual([
			'kept',
		]);
		const added = point('new', 2);
		await repository.add(added);
		expect(setItem).toHaveBeenCalledTimes(1);
		expect(JSON.parse(values.get(KEY) ?? '{}')).toEqual({
			schemaVersion: 1,
			namespace: 'rndevtools-restore-points',
			points: [stored, added],
		});
	});

	it('reload() rejects and keeps the error while storage still fails', async () => {
		const { storage, failReads } = createStorage(
			documentWith(point('kept', 1)),
		);
		failReads(2);
		const repository = createRepository(storage);
		await repository.ready;

		await expect(repository.reload()).rejects.toThrow('disk unavailable');
		expect(repository.getLoadError()).toBe('disk unavailable');

		await repository.reload();
		expect(repository.getLoadError()).toBeUndefined();
		expect(repository.getSnapshot()).toHaveLength(1);
	});

	it('runs a reload behind queued writes in order', async () => {
		const stored = point('kept', 1);
		const { storage, values, failReads } = createStorage(documentWith(stored));
		failReads(1);
		const repository = createRepository(storage);
		await repository.ready;

		const refused = repository.add(point('first', 2));
		const reloaded = repository.reload();
		const accepted = repository.add(point('second', 3));

		await expect(refused).rejects.toThrow(REFUSAL);
		await reloaded;
		await accepted;
		expect(
			(
				JSON.parse(values.get(KEY) ?? '{}') as { points: RestorePoint[] }
			).points.map((candidate) => candidate.id),
		).toEqual(['kept', 'second']);
	});

	it('a corrupt document sets the error and discardStoredData() removes it so writes resume', async () => {
		const { storage, removeItem, setItem, values } = createStorage('{not json');
		const repository = createRepository(storage);
		await repository.ready;

		expect(repository.getLoadError()).toBe(
			'Restore-point document is malformed.',
		);
		await expect(repository.add(point('new', 2))).rejects.toThrow(
			'could not be loaded (Restore-point document is malformed.)',
		);
		expect(setItem).not.toHaveBeenCalled();

		await repository.discardStoredData();

		expect(removeItem).toHaveBeenCalledWith(KEY);
		expect(values.has(KEY)).toBe(false);
		expect(repository.getLoadError()).toBeUndefined();
		const added = point('new', 2);
		await repository.add(added);
		expect(JSON.parse(values.get(KEY) ?? '{}')).toEqual({
			schemaVersion: 1,
			namespace: 'rndevtools-restore-points',
			points: [added],
		});
	});

	it('discardStoredData() writes an empty document when storage has no removeItem', async () => {
		const values = new Map<string, string>([[KEY, '{not json']]);
		const repository = createRepository({
			getItem: (key) => values.get(key),
			setItem: (key, value) => {
				values.set(key, value);
			},
		});
		await repository.ready;
		expect(repository.getLoadError()).toBe(
			'Restore-point document is malformed.',
		);

		await repository.discardStoredData();

		expect(values.get(KEY)).toBe(documentWith());
		expect(repository.getLoadError()).toBeUndefined();
		expect(repository.getSnapshot()).toEqual([]);
	});

	it('persists the readable points when the stored document held entries it cannot read', async () => {
		const stored = point('kept', 1);
		const document = JSON.parse(documentWith(stored)) as { points: unknown[] };
		document.points.push({ id: 'broken', label: '', sources: [] });
		const { storage, setItem, values } = createStorage(
			JSON.stringify(document),
		);
		const repository = createRepository(storage);
		await repository.ready;

		expect(repository.getLoadError()).toBeUndefined();
		expect(repository.getSnapshot().map((candidate) => candidate.id)).toEqual([
			'kept',
		]);
		expect(setItem).toHaveBeenCalledTimes(1);
		expect(values.get(KEY)).toBe(documentWith(stored));
	});

	it('does not treat a failed cleanup write as a load error', async () => {
		const stored = point('kept', 1);
		const document = JSON.parse(documentWith(stored)) as { points: unknown[] };
		document.points.push({ id: 'broken', label: '', sources: [] });
		const { storage, setItem, values } = createStorage(
			JSON.stringify(document),
		);
		setItem.mockImplementationOnce(() => {
			throw new Error('disk full');
		});
		const repository = createRepository(storage);
		await repository.ready;

		// The points loaded; only the tidy-up write failed.
		expect(repository.getLoadError()).toBeUndefined();
		expect(repository.getSnapshot().map((candidate) => candidate.id)).toEqual([
			'kept',
		]);
		const added = point('new', 2);
		await repository.add(added);
		expect(JSON.parse(values.get(KEY) ?? '{}')).toEqual({
			schemaVersion: 1,
			namespace: 'rndevtools-restore-points',
			points: [stored, added],
		});
	});

	it('is a no-op without storage', async () => {
		const repository = new RestorePointRepository({
			maxPoints: 2,
			maxSourceBytes: 1024,
			maxTotalBytes: 4096,
		});
		await repository.ready;
		await repository.reload();
		await repository.discardStoredData();
		expect(repository.getLoadError()).toBeUndefined();
		await repository.add(point('new', 2));
		expect(repository.getSnapshot()).toHaveLength(1);
	});
});
