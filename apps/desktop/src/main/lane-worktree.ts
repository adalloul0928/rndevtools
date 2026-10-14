import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runSimulatorCommand } from './simulator-command-runner';

const GIT_PATH = '/usr/bin/git';
const GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 512 * 1024;

export type DiscoveredWorktree = {
	path: string;
	branch: string;
	repositoryRoot: string;
	dirty: boolean;
};

export type WorktreeExpoIdentity = {
	scheme?: string;
	bundleIdentifier?: string;
};

export type WorktreeInspectorPort = {
	repositoryRoot: (worktreePath: string) => Promise<string>;
	listWorktrees: (repositoryRoot: string) => Promise<DiscoveredWorktree[]>;
	readExpoIdentity: (worktreePath: string) => Promise<WorktreeExpoIdentity>;
};

async function git(args: readonly string[], cwd: string): Promise<string> {
	const result = await runSimulatorCommand(GIT_PATH, ['-C', cwd, ...args], {
		timeoutMs: GIT_TIMEOUT_MS,
		maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
	});
	return result.stdout;
}

/**
 * The main checkout that owns a worktree. `git worktree list` run from any
 * linked worktree reports the whole set with the main checkout first.
 */
async function repositoryRootOf(worktreePath: string): Promise<string> {
	const output = await git(['worktree', 'list', '--porcelain'], worktreePath);
	const first = output.split('\n').find((line) => line.startsWith('worktree '));
	if (!first) {
		throw new Error(`${worktreePath} is not inside a git repository.`);
	}
	return first.slice('worktree '.length).trim();
}

/** Parses `git worktree list --porcelain` into one entry per checkout. */
export function parseWorktreeList(
	output: string,
	repositoryRoot: string
): Omit<DiscoveredWorktree, 'dirty'>[] {
	const entries: Omit<DiscoveredWorktree, 'dirty'>[] = [];
	let current: { path?: string; branch?: string; detached?: boolean } = {};
	const flush = () => {
		if (current.path) {
			entries.push({
				path: current.path,
				branch: current.detached
					? 'detached'
					: (current.branch ?? 'unknown').replace(/^refs\/heads\//, ''),
				repositoryRoot,
			});
		}
		current = {};
	};
	for (const line of output.split('\n')) {
		if (line === '') {
			flush();
			continue;
		}
		if (line.startsWith('worktree ')) current.path = line.slice(9).trim();
		else if (line.startsWith('branch ')) current.branch = line.slice(7).trim();
		else if (line === 'detached') current.detached = true;
	}
	flush();
	return entries;
}

async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
	const output = await git(
		['status', '--porcelain', '--untracked-files=no'],
		worktreePath
	).catch(() => '');
	return output.trim().length > 0;
}

async function listWorktrees(
	repositoryRoot: string
): Promise<DiscoveredWorktree[]> {
	const output = await git(['worktree', 'list', '--porcelain'], repositoryRoot);
	const entries = parseWorktreeList(output, repositoryRoot);
	return Promise.all(
		entries.map(async (entry) => ({
			...entry,
			dirty: await isWorktreeDirty(entry.path),
		}))
	);
}

function stringAt(value: unknown, keys: readonly string[]): string | undefined {
	let cursor: unknown = value;
	for (const key of keys) {
		if (!cursor || typeof cursor !== 'object') return undefined;
		cursor = (cursor as Record<string, unknown>)[key];
	}
	return typeof cursor === 'string' && cursor.length <= 256
		? cursor
		: undefined;
}

/**
 * Reads the URL scheme and iOS bundle identifier from the worktree's static
 * Expo config. Dynamic `app.config.js` files are not evaluated: running
 * arbitrary project code inside the desktop app is not worth a launch URL.
 * Callers fall back to a user-supplied scheme when the static file is absent.
 */
export async function readExpoIdentity(
	worktreePath: string
): Promise<WorktreeExpoIdentity> {
	for (const file of ['app.json', 'app.config.json']) {
		try {
			const raw = await readFile(path.join(worktreePath, file), {
				encoding: 'utf8',
			});
			if (raw.length > MAX_CONFIG_BYTES) continue;
			const parsed: unknown = JSON.parse(raw);
			const expo =
				stringAt(parsed, ['expo', 'slug']) !== undefined
					? (parsed as { expo: unknown }).expo
					: parsed;
			const scheme = stringAt(expo, ['scheme']);
			const schemes = Array.isArray(
				(expo as { scheme?: unknown } | undefined)?.scheme
			)
				? ((expo as { scheme: unknown[] }).scheme.find(
						(entry) => typeof entry === 'string'
					) as string | undefined)
				: undefined;
			const slug = stringAt(expo, ['slug']);
			const resolvedScheme =
				scheme ?? schemes ?? (slug ? `exp+${slug}` : undefined);
			const bundleIdentifier = stringAt(expo, ['ios', 'bundleIdentifier']);
			return {
				...(resolvedScheme ? { scheme: resolvedScheme } : {}),
				...(bundleIdentifier ? { bundleIdentifier } : {}),
			};
		} catch {
			// Try the next file name.
		}
	}
	return {};
}

export const worktreeInspector: WorktreeInspectorPort = {
	repositoryRoot: repositoryRootOf,
	listWorktrees,
	readExpoIdentity,
};
