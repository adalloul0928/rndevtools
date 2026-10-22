import type { RestorePointStorage } from './restore-points';
import { SCENARIO_SCHEMA_VERSION, type ScenarioDefinition } from './scenario';
import { ScenarioRepository } from './scenario-repository';

const KEY = '@rndevtools/core/scenario-definitions/v1';

function definition(
	overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition {
	return {
		schemaVersion: SCENARIO_SCHEMA_VERSION,
		id: 'offline-home',
		version: 1,
		name: 'Offline home',
		variables: [
			{
				id: 'profile',
				label: 'Network profile',
				type: 'string',
				required: true,
				defaultValue: 'offline',
				options: ['offline', 'edge'],
			},
		],
		preconditions: [],
		steps: [
			{
				id: 'network',
				type: 'network-profile',
				input: {
					profileId: { kind: 'variable', variableId: 'profile' },
				},
			},
		],
		...overrides,
	};
}

function documentWith(...scenarios: readonly ScenarioDefinition[]): string {
	return JSON.stringify({
		schemaVersion: 1,
		namespace: 'rndevtools-scenarios',
		scenarios,
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

const REFUSAL =
	'Stored scenarios could not be loaded (disk unavailable), so nothing was written. Retry loading them or discard the stored data.';

describe('ScenarioRepository load failures', () => {
	it('refuses every write while the stored document could not be loaded', async () => {
		const stored = definition({ id: 'kept', name: 'Kept' });
		const { storage, setItem, values, failReads } = createStorage(
			documentWith(stored),
		);
		failReads(1);
		const repository = new ScenarioRepository({ storage });
		await repository.ready;

		expect(repository.getLoadError()).toBe('disk unavailable');
		expect(repository.getSnapshot()).toMatchObject({
			user: [],
			loadError: 'disk unavailable',
		});
		await expect(
			repository.save(definition({ id: 'new', name: 'New' })),
		).rejects.toThrow(REFUSAL);
		await expect(
			repository.importJson(documentWith(definition({ id: 'imported' }))),
		).rejects.toThrow(REFUSAL);
		await expect(
			repository.remove({ id: 'kept', version: 1, definitionToken: 'stale' }),
		).rejects.toThrow(REFUSAL);
		expect(setItem).not.toHaveBeenCalled();
		expect(values.get(KEY)).toBe(documentWith(stored));
	});

	it('reload() loads the stored scenarios once storage recovers and save() merges with them', async () => {
		const stored = definition({ id: 'kept', name: 'Kept' });
		const { storage, setItem, values, failReads } = createStorage(
			documentWith(stored),
		);
		failReads(1);
		const repository = new ScenarioRepository({ storage });
		const snapshots: Array<string | undefined> = [];
		repository.subscribe(() => {
			snapshots.push(repository.getSnapshot().loadError);
		});
		await repository.ready;
		expect(repository.getLoadError()).toBe('disk unavailable');

		await repository.reload();

		expect(repository.getLoadError()).toBeUndefined();
		expect(repository.getServerLoadError()).toBeUndefined();
		expect(repository.getSnapshot().loadError).toBeUndefined();
		expect(snapshots).toEqual(['disk unavailable', undefined]);
		expect(repository.getSnapshot().user.map((item) => item.id)).toEqual([
			'kept',
		]);
		expect(repository.getTarget('kept')).toBeDefined();
		const added = definition({ id: 'new', name: 'New' });
		await repository.save(added);
		expect(setItem).toHaveBeenCalledTimes(1);
		expect(JSON.parse(values.get(KEY) ?? '{}')).toEqual({
			schemaVersion: 1,
			namespace: 'rndevtools-scenarios',
			scenarios: [stored, added],
		});
	});

	it('reload() rejects while storage still fails', async () => {
		const { storage, failReads } = createStorage(
			documentWith(definition({ id: 'kept' })),
		);
		failReads(2);
		const repository = new ScenarioRepository({ storage });
		await repository.ready;

		await expect(repository.reload()).rejects.toThrow('disk unavailable');
		expect(repository.getLoadError()).toBe('disk unavailable');
		await repository.reload();
		expect(repository.getSnapshot().user).toHaveLength(1);
	});

	it('a corrupt document sets the error and discardStoredData() clears the key', async () => {
		const { storage, removeItem, setItem, values } = createStorage('{not json');
		const repository = new ScenarioRepository({ storage });
		await repository.ready;

		expect(repository.getLoadError()).toBe('Scenario document is malformed.');
		await expect(repository.save(definition({ id: 'new' }))).rejects.toThrow(
			'could not be loaded (Scenario document is malformed.)',
		);
		expect(setItem).not.toHaveBeenCalled();

		await repository.discardStoredData();

		expect(removeItem).toHaveBeenCalledWith(KEY);
		expect(repository.getLoadError()).toBeUndefined();
		const added = definition({ id: 'new', name: 'New' });
		await repository.save(added);
		expect(JSON.parse(values.get(KEY) ?? '{}')).toEqual({
			schemaVersion: 1,
			namespace: 'rndevtools-scenarios',
			scenarios: [added],
		});
	});

	it('discardStoredData() writes an empty document when storage has no removeItem', async () => {
		const values = new Map<string, string>([[KEY, '{not json']]);
		const repository = new ScenarioRepository({
			bundled: [definition()],
			storage: {
				getItem: (key) => values.get(key),
				setItem: (key, value) => {
					values.set(key, value);
				},
			},
		});
		await repository.ready;
		expect(repository.getLoadError()).toBe('Scenario document is malformed.');

		await repository.discardStoredData();

		expect(values.get(KEY)).toBe(documentWith());
		expect(repository.getLoadError()).toBeUndefined();
		expect(repository.getSnapshot().bundled).toHaveLength(1);
		expect(repository.getSnapshot().user).toEqual([]);
	});

	it('persists the readable scenarios when the stored document held entries it cannot read', async () => {
		const stored = definition({ id: 'kept', name: 'Kept' });
		const document = JSON.parse(documentWith(stored)) as {
			scenarios: unknown[];
		};
		document.scenarios.push({ ...definition(), steps: [{ type: 'shell' }] });
		const { storage, setItem, values } = createStorage(
			JSON.stringify(document),
		);
		const repository = new ScenarioRepository({ storage });
		await repository.ready;

		expect(repository.getLoadError()).toBeUndefined();
		expect(repository.getSnapshot().user.map((item) => item.id)).toEqual([
			'kept',
		]);
		expect(setItem).toHaveBeenCalledTimes(1);
		expect(values.get(KEY)).toBe(documentWith(stored));
	});

	it('does not treat a failed cleanup write as a load error', async () => {
		const stored = definition({ id: 'kept', name: 'Kept' });
		const document = JSON.parse(documentWith(stored)) as {
			scenarios: unknown[];
		};
		document.scenarios.push({ ...definition(), steps: [{ type: 'shell' }] });
		const { storage, setItem, values } = createStorage(
			JSON.stringify(document),
		);
		setItem.mockImplementationOnce(() => {
			throw new Error('disk full');
		});
		const repository = new ScenarioRepository({ storage });
		await repository.ready;

		expect(repository.getLoadError()).toBeUndefined();
		expect(repository.getSnapshot().user.map((item) => item.id)).toEqual([
			'kept',
		]);
		const added = definition({ id: 'new', name: 'New' });
		await repository.save(added);
		expect(JSON.parse(values.get(KEY) ?? '{}')).toEqual({
			schemaVersion: 1,
			namespace: 'rndevtools-scenarios',
			scenarios: [stored, added],
		});
	});
});
