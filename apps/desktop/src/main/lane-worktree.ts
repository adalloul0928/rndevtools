import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
	runSimulatorCommand,
	SimulatorCommandError,
} from './simulator-command-runner';

const GIT_PATH = '/usr/bin/git';
const GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 512 * 1024;
/** How long a worktree's dirty flag is shown before git is asked again. */
const DIRTY_TTL_MS = 30_000;
/** How many worktrees' dirty flags are kept; the least recently checked go first. */
const MAX_DIRTY_ENTRIES = 512;
/** `git status` runs one listing has going at once; each uses several threads. */
const MAX_PARALLEL_STATUS = 4;

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
	/**
	 * Every checkout of the repository. A `dirty` flag may be up to
	 * DIRTY_TTL_MS old, as agents poll this; `fresh` asks git again.
	 */
	listWorktrees: (
		repositoryRoot: string,
		options?: { fresh?: boolean }
	) => Promise<DiscoveredWorktree[]>;
	readExpoIdentity: (worktreePath: string) => Promise<WorktreeExpoIdentity>;
};

type CommandRunner = typeof runSimulatorCommand;
type Git = (args: readonly string[], cwd: string) => Promise<string>;

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

/**
 * Whether a worktree has tracked changes. `--no-optional-locks` keeps the
 * status from taking the worktree's index.lock, which would make an agent's
 * commit there fail. A status too long to read is dirty; one that cannot run
 * reads as clean, since the flag is only shown.
 */
async function isWorktreeDirty(
	git: Git,
	worktreePath: string
): Promise<boolean> {
	try {
		const output = await git(
			['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'],
			worktreePath
		);
		return output.trim().length > 0;
	} catch (error) {
		return (
			error instanceof SimulatorCommandError && error.kind === 'output-limit'
		);
	}
}

/** `run` over `items`, at most `limit` at a time, results in order. */
async function mapLimited<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (next < items.length) {
				const index = next;
				next += 1;
				const item = items[index] as T;
				results[index] = await run(item);
			}
		}
	);
	await Promise.all(workers);
	return results;
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

/**
 * Reads worktrees through git. Agents waiting on a device poll the listing,
 * so each worktree's dirty flag is reused for DIRTY_TTL_MS, and at most
 * MAX_PARALLEL_STATUS statuses run at once.
 */
export function createWorktreeInspector({
	runCommand = runSimulatorCommand,
	now = Date.now,
}: {
	runCommand?: CommandRunner;
	now?: () => number;
} = {}): WorktreeInspectorPort {
	const git: Git = async (args, cwd) =>
		(
			await runCommand(GIT_PATH, ['-C', cwd, ...args], {
				timeoutMs: GIT_TIMEOUT_MS,
				maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
			})
		).stdout;
	const dirtyByPath = new Map<string, { dirty: boolean; checkedAt: number }>();

	const isDirty = async (
		worktreePath: string,
		fresh: boolean
	): Promise<boolean> => {
		const known = dirtyByPath.get(worktreePath);
		if (!fresh && known && now() - known.checkedAt < DIRTY_TTL_MS) {
			return known.dirty;
		}
		const dirty = await isWorktreeDirty(git, worktreePath);
		dirtyByPath.delete(worktreePath);
		dirtyByPath.set(worktreePath, { dirty, checkedAt: now() });
		for (const stale of dirtyByPath.keys()) {
			if (dirtyByPath.size <= MAX_DIRTY_ENTRIES) break;
			dirtyByPath.delete(stale);
		}
		return dirty;
	};

	return {
		/**
		 * The main checkout that owns a worktree. `git worktree list` run from
		 * any linked worktree reports the whole set with the main checkout
		 * first.
		 */
		repositoryRoot: async (worktreePath) => {
			const output = await git(
				['worktree', 'list', '--porcelain'],
				worktreePath
			);
			const first = output
				.split('\n')
				.find((line) => line.startsWith('worktree '));
			if (!first) {
				throw new Error(`${worktreePath} is not inside a git repository.`);
			}
			return first.slice('worktree '.length).trim();
		},
		listWorktrees: async (repositoryRoot, { fresh = false } = {}) => {
			const output = await git(
				['worktree', 'list', '--porcelain'],
				repositoryRoot
			);
			return mapLimited(
				parseWorktreeList(output, repositoryRoot),
				MAX_PARALLEL_STATUS,
				async (entry) => ({ ...entry, dirty: await isDirty(entry.path, fresh) })
			);
		},
		readExpoIdentity,
	};
}

export const worktreeInspector: WorktreeInspectorPort =
	createWorktreeInspector();
