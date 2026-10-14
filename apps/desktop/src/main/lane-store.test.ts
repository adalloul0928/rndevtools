import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Lane } from '../shared/lane-protocol';
import { LaneStore } from './lane-store';

const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

function lane(id: string, overrides: Partial<Lane> = {}): Lane {
	return {
		id,
		worktreePath: '/Users/dev/app-feature',
		branch: 'feature',
		simulatorUdid: UDID,
		environment: 'development',
		port: 8_100,
		metro: 'starting',
		logPath: '/Users/dev/lane.log',
		startedAt: 1,
		...overrides,
	};
}

describe('LaneStore', () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-lanes-'));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('persists lanes and repositories across restarts', async () => {
		const store = new LaneStore(root);
		await store.start();
		const id = store.newLaneId();
		await store.upsert(lane(id));
		await store.addRepository('/Users/dev/app');

		const reopened = new LaneStore(root);
		await reopened.start();
		expect(reopened.lanes()).toEqual([lane(id)]);
		expect(reopened.repositories()).toEqual(['/Users/dev/app']);
		expect(reopened.logPathFor(id)).toBe(path.join(root, 'logs', `${id}.log`));
	});

	it('updates in place, removes, and returns copies rather than live state', async () => {
		const store = new LaneStore(root);
		await store.start();
		const id = store.newLaneId();
		await store.upsert(lane(id));
		await store.upsert(lane(id, { metro: 'ready', metroPid: 99 }));
		expect(store.lanes()).toHaveLength(1);
		expect(store.get(id)).toMatchObject({ metro: 'ready', metroPid: 99 });
		const copy = store.get(id) as Lane;
		copy.metro = 'stopped';
		expect(store.get(id)?.metro).toBe('ready');
		expect(await store.remove(id)).toBe(true);
		expect(await store.remove(id)).toBe(false);
	});

	it('quarantines a corrupt file instead of failing to start', async () => {
		const store = new LaneStore(root);
		await store.start();
		await store.upsert(lane(store.newLaneId()));
		const file = path.join(root, 'lanes.json');
		const { writeFile } = await import('node:fs/promises');
		await writeFile(file, '{not json');
		const reopened = new LaneStore(root);
		await reopened.start();
		expect(reopened.lanes()).toEqual([]);
		const { readdir } = await import('node:fs/promises');
		expect(
			(await readdir(root)).some((entry) => entry.includes('.corrupt-'))
		).toBe(true);
	});

	it('writes a versioned, strictly validated document', async () => {
		const store = new LaneStore(root);
		await store.start();
		await store.upsert(lane(store.newLaneId()));
		const document = JSON.parse(
			await readFile(path.join(root, 'lanes.json'), 'utf8')
		);
		expect(document.version).toBe(1);
		expect(Array.isArray(document.lanes)).toBe(true);
		await expect(
			store.upsert({ ...lane(store.newLaneId()), port: 1 } as Lane)
		).rejects.toThrow();
	});
});
