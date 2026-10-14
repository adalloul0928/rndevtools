import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseWorktreeList, readExpoIdentity } from './lane-worktree';

describe('parseWorktreeList', () => {
	it('parses porcelain output into checkouts with branch names', () => {
		const output = [
			'worktree /Users/dev/app',
			'HEAD 0123456789abcdef0123456789abcdef01234567',
			'branch refs/heads/main',
			'',
			'worktree /Users/dev/app-feature-a',
			'HEAD 89abcdef0123456789abcdef0123456789abcdef',
			'branch refs/heads/feature/a',
			'',
			'worktree /Users/dev/app-detached',
			'HEAD 89abcdef0123456789abcdef0123456789abcdef',
			'detached',
			'',
		].join('\n');
		expect(parseWorktreeList(output, '/Users/dev/app')).toEqual([
			{
				path: '/Users/dev/app',
				branch: 'main',
				repositoryRoot: '/Users/dev/app',
			},
			{
				path: '/Users/dev/app-feature-a',
				branch: 'feature/a',
				repositoryRoot: '/Users/dev/app',
			},
			{
				path: '/Users/dev/app-detached',
				branch: 'detached',
				repositoryRoot: '/Users/dev/app',
			},
		]);
	});

	it('tolerates output without a trailing blank line', () => {
		expect(
			parseWorktreeList(
				'worktree /Users/dev/app\nbranch refs/heads/main',
				'/Users/dev/app'
			)
		).toHaveLength(1);
	});
});

describe('readExpoIdentity', () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-worktree-'));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('reads scheme and bundle identifier from app.json', async () => {
		await writeFile(
			path.join(root, 'app.json'),
			JSON.stringify({
				expo: {
					slug: 'example',
					scheme: 'exampleapp',
					ios: { bundleIdentifier: 'com.example.app' },
				},
			})
		);
		expect(await readExpoIdentity(root)).toEqual({
			scheme: 'exampleapp',
			bundleIdentifier: 'com.example.app',
		});
	});

	it('falls back to exp+slug when no scheme is declared and takes the first of several', async () => {
		await writeFile(
			path.join(root, 'app.json'),
			JSON.stringify({ expo: { slug: 'example' } })
		);
		expect(await readExpoIdentity(root)).toEqual({ scheme: 'exp+example' });
		await writeFile(
			path.join(root, 'app.json'),
			JSON.stringify({ expo: { slug: 'example', scheme: ['one', 'two'] } })
		);
		expect((await readExpoIdentity(root)).scheme).toBe('one');
	});

	it('returns nothing for a worktree without static Expo config', async () => {
		expect(await readExpoIdentity(root)).toEqual({});
		await writeFile(path.join(root, 'app.json'), '{ not json');
		expect(await readExpoIdentity(root)).toEqual({});
	});
});
