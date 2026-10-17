import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	type SupabaseOperation,
	supabaseOperationSchema,
	supabaseStateSchema,
} from '../../shared/supabase-protocol';
import { AgentCliError } from '../agent-cli-service';
import { SECRET_SHAPED } from './cli-fixtures.test-support';
import {
	createEngineHarness,
	disposeEngineHarnesses,
	type EngineHarness,
	fakeLane,
	fakeSession,
} from './engine.test-support';
import type { SupabaseOperationContext } from './service-ports';

// These suites drive the orchestrator through hundreds of store writes. The
// stores' atomic, fsync'd writes are tested on their own; here the same bytes
// and modes are written without the fsync, so the suites don't starve the
// stores' durability tests of disk time when files run in parallel.
vi.mock('./policy-store', async (importOriginal) => {
	const original = await importOriginal<typeof import('./policy-store')>();
	const { chmod, writeFile } = await import('node:fs/promises');
	const { dirname } = await import('node:path');
	return {
		...original,
		writeSupabaseStoreFile: async (
			file: string,
			contents: string,
			maxBytes: number
		) => {
			if (Buffer.byteLength(contents, 'utf8') > maxBytes) {
				throw new RangeError(`${file} would exceed its limit.`);
			}
			await original.ensureSupabaseStoreDirectory(dirname(file));
			await writeFile(file, contents, { mode: 0o600 });
			await chmod(file, 0o600);
		},
	};
});

afterEach(disposeEngineHarnesses);

const OPERATOR: SupabaseOperationContext = {
	actor: { kind: 'operator', senderId: 1 },
	confirmed: false,
};
const CONFIRMED: SupabaseOperationContext = { ...OPERATOR, confirmed: true };
const CLAUDE = { kind: 'claude', sessionId: 'session-a' } as const;
const SIGNAL = new AbortController().signal;

let counter = 0;
function op(fields: Record<string, unknown>): SupabaseOperation {
	counter += 1;
	return supabaseOperationSchema.parse({
		actionId: `action-${counter}`,
		...fields,
	});
}

async function startStack(h: EngineHarness, worktree: string): Promise<string> {
	const stackId = await h.identity(worktree);
	const receipt = await h.engine.runOperation(
		op({ kind: 'start', stackId }),
		OPERATOR
	);
	expect(receipt.completed).toBe(true);
	await h.settle();
	return stackId;
}

/** An agent's up: a session hold, no pin. */
async function agentUp(
	h: EngineHarness,
	worktree: string,
	holder: { kind: 'claude' | 'codex' | 'other'; sessionId: string } = CLAUDE
) {
	const result = await h.engine.runAgentOperation(
		{ operation: 'up', target: { worktreePath: worktree }, waitMs: 45_000 },
		{ requestId: 'request-1', holder, synthetic: false },
		SIGNAL
	);
	await h.settle();
	return result;
}

function stateOf(h: EngineHarness, stackId: string) {
	return h.engine.getState().stacks.find((stack) => stack.id === stackId);
}

describe('SupabaseEngine while off', () => {
	it('runs no process while local Supabase is off', async () => {
		const h = await createEngineHarness({ start: false });
		const repo = await h.repository('repo', { migrations: 1 });
		h.lanes.lanes = [fakeLane({ worktreePath: repo })];
		await h.engine.start();
		await h.settle();
		h.engine.setInterest('renderer-1', {
			view: 'stacks',
			inspectStackId: 'a'.repeat(64),
			sections: ['overview'],
		});
		const lane = await h.engine.ensureForLane({
			laneId: 'lane-11111111-2222-4333-8444-555555555555',
			worktreePath: repo,
			branch: 'main',
			environmentId: 'development',
			policy: 'auto',
		});
		expect(lane.summary).toMatchObject({
			status: 'skipped',
			reason: 'disabled',
		});
		await expect(
			h.engine.runAgentOperation(
				{ operation: 'ls' },
				{ requestId: 'request-1', holder: CLAUDE, synthetic: false },
				SIGNAL
			)
		).rejects.toBeInstanceOf(AgentCliError);
		await h.engine.releaseHolder({ holder: CLAUDE });
		const facts = await h.engine.describeConfirmation(
			op({ kind: 'set-enabled', enabled: true })
		);
		expect(facts?.choices[0]?.label).toBe('Turn on');
		const refused = await h.engine.runOperation(
			op({ kind: 'refresh' }),
			OPERATOR
		);
		expect(refused.error?.code).toBe('feature_off');
		h.engine.doctor();
		h.engine.holderKeys();
		h.engine.steering();
		await h.advance(30 * 60_000);
		expect(h.processCalls()).toBe(0);
		expect(h.clock.pendingTimers).toBe(0);
		const state = supabaseStateSchema.parse(h.engine.getState());
		expect(state.source).toBe('live');
		expect(state.discovery.status).toBe('off');
	});

	it('runs no process on a Mac that cannot run native stacks', async () => {
		const h = await createEngineHarness({
			enabled: true,
			supported: false,
			start: false,
		});
		await h.repository('repo');
		await h.engine.start();
		await h.advance(10 * 60_000);
		expect(h.processCalls()).toBe(0);
		expect(h.engine.getState().availability.platform.supported).toBe(false);
	});

	it('stops probing once turned off, and removes the steering file', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		await h.repository('repo');
		await h.engine.start();
		await h.settle();
		await expect(stat(h.engine.steeringWriter.file)).resolves.toBeTruthy();
		const receipt = await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		expect(receipt.completed).toBe(true);
		await h.settle();
		await expect(stat(h.engine.steeringWriter.file)).rejects.toThrow();
		const before = h.processCalls();
		await h.advance(30 * 60_000);
		expect(h.processCalls()).toBe(before);
		expect(h.clock.pendingTimers).toBe(0);
	});
});

describe('SupabaseEngine cadence', () => {
	it('reads the cheap tier every 15 s and lists on owner changes and every 5 min', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		expect(h.cli.count('stack list')).toBe(1);
		const owners = () =>
			h.discovery.probes.filter((probe) => probe === 'owners').length;
		const before = owners();
		await h.advance(15_000);
		expect(owners()).toBe(before + 1);
		// Nothing changed: no new list within 5 min.
		await h.advance(60_000);
		expect(h.cli.count('stack list')).toBe(1);
		// Another tool starts the worktree's stack: the owner set changes.
		h.cli.addStack({
			id: await h.identity(repo),
			projectRoot: repo,
			running: true,
		});
		await h.advance(15_000);
		expect(h.cli.count('stack list')).toBe(2);
		await h.advance(5 * 60_000 + 15_000);
		expect(h.cli.count('stack list')).toBeGreaterThanOrEqual(3);
	});

	it('measures footprint and disk only while a window shows the tab', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		await startStack(h, repo);
		const rss = () =>
			h.discovery.probes.filter((probe) => probe === 'rss').length;
		const du = () =>
			h.discovery.probes.filter((probe) => probe === 'du').length;
		await h.advance(60_000);
		expect(rss()).toBe(0);
		expect(du()).toBe(0);
		h.engine.setInterest('renderer-1', { view: 'stacks', sections: [] });
		await h.advance(1);
		expect(rss()).toBe(1);
		expect(du()).toBe(1);
		await h.advance(30_000);
		expect(rss()).toBe(2);
		expect(du()).toBe(1);
		h.engine.setInterest('renderer-1', { view: 'hidden', sections: [] });
		await h.advance(20 * 60_000);
		expect(rss()).toBe(2);
		expect(du()).toBe(1);
	});

	it('reads the inspected stack every 10 s while visible', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		const stackId = await startStack(h, repo);
		const statuses = () => h.cli.count('stack status');
		const before = statuses();
		h.engine.setInterest('renderer-1', {
			view: 'stacks',
			inspectStackId: stackId,
			sections: ['overview'],
		});
		await h.settle();
		expect(statuses()).toBe(before + 1);
		await h.advance(10_000);
		expect(statuses()).toBeGreaterThanOrEqual(before + 2);
		h.engine.setInterest('renderer-1', { view: 'hidden', sections: [] });
		await h.settle();
		const hidden = statuses();
		await h.advance(14_000);
		expect(statuses()).toBe(hidden);
	});

	it('never extends an automatic stop while the tab is watched', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.settle();
		await agentUp(h, repo);
		const stackId = await h.identity(repo);
		expect(stateOf(h, stackId)?.state).toBe('running');
		await h.engine.runAgentOperation(
			{ operation: 'down', target: { worktreePath: repo } },
			{ requestId: 'request-2', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		await h.settle();
		h.engine.setInterest('renderer-1', {
			view: 'stacks',
			inspectStackId: stackId,
			sections: ['overview'],
		});
		await h.advance(59_000);
		expect(h.cli.count('stack stop')).toBe(0);
		await h.advance(2_000);
		expect(h.cli.count('stack stop')).toBe(1);
		expect(stateOf(h, stackId)?.state).toBe('stopped');
	});
});

describe('SupabaseEngine state', () => {
	it('bumps the revision only when the visible state changes', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		const pushed: number[] = [];
		h.engine.subscribe((state) => pushed.push(state.revision));
		const first = h.engine.getState().revision;
		await h.advance(15_000);
		expect(h.engine.getState().revision).toBe(first);
		await startStack(h, repo);
		const after = h.engine.getState().revision;
		expect(after).toBeGreaterThan(first);
		expect(new Set(pushed).size).toBe(pushed.length);
		expect(pushed.every((revision) => revision > first)).toBe(true);
	});

	it('keeps key material out of the state, receipts, stores and steering', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo', { lockfile: true });
		await h.engine.start();
		await h.settle();
		const stackId = await startStack(h, repo);
		const receipt = await h.engine.runOperation(
			op({ kind: 'copy', stackId, what: 'publishable-key' }),
			OPERATOR
		);
		expect(receipt.completed).toBe(true);
		expect(h.clipboard.text).toBe(h.cli.secrets.publishableKey);
		const serialized = [
			JSON.stringify(h.engine.getState()),
			JSON.stringify(receipt),
			JSON.stringify(h.engine.doctor()),
			await readFile(h.engine.steeringWriter.file, 'utf8'),
			await readFile(h.engine.stackStore.file, 'utf8'),
			await readFile(h.engine.jobStore.file, 'utf8'),
			await readFile(h.engine.policyStore.file, 'utf8'),
			h.logs.join('\n'),
		];
		for (const text of serialized) {
			expect(text).not.toMatch(SECRET_SHAPED);
			expect(text).not.toContain(h.cli.secrets.dbPassword);
			expect(text).not.toContain(h.cli.secrets.publishableKey);
		}
	});

	it('describes tracked worktrees for the lane start form', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const managed = await h.repository('repo');
		const pinned = await h.repository('pinned', {
			config: '[experimental]\nstack = true\n\n[api]\nport = 54321\n',
		});
		const observed = await h.repository('observed', {
			config: 'project_id = "example-app"\n',
		});
		await h.engine.start();
		await h.settle();
		expect(h.engine.describeWorktree(managed)).toEqual({ project: 'managed' });
		expect(h.engine.describeWorktree(pinned)).toEqual({
			project: 'managed',
			portsPinned: true,
		});
		expect(h.engine.describeWorktree(observed)).toEqual({
			project: 'observed',
			reasonText: expect.stringMatching(/stack flag/),
		});
		expect(
			h.engine.describeWorktree('/Users/example/code/untracked')
		).toBeUndefined();
		await h.engine.policyStore.setEnabled(false);
		expect(h.engine.describeWorktree(managed)).toBeUndefined();
	});

	it('publishes states that parse and never say demo', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const states: unknown[] = [];
		h.engine.subscribe((state) => states.push(state));
		await h.engine.start();
		await h.settle();
		await startStack(h, repo);
		expect(states.length).toBeGreaterThan(0);
		for (const state of states) {
			expect(supabaseStateSchema.parse(state).source).toBe('live');
		}
	});
});

describe('SupabaseEngine exposure', () => {
	it('stops a stack that listens beyond loopback and fails its start', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		const stackId = await startStack(h, repo);
		await h.engine.runOperation(
			op({ kind: 'stop', stackIds: [stackId] }),
			OPERATOR
		);
		await h.settle();
		const stack = h.cli.stacks.get(stackId);
		if (stack) stack.lanExposed = true;
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.settle();
		const job = receipt.jobId ? h.engine.job(receipt.jobId) : undefined;
		expect(job?.status).toBe('failed');
		expect(job?.error?.title).toBe('Stack listened on your network');
		expect(h.cli.count('stack stop')).toBe(2);
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
		expect(stateOf(h, stackId)?.exposure.verdict).toBe('lan-exposed');
	});

	it('stops a started stack whose exposure cannot be verified', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		h.discovery.exposureUnavailable = true;
		const stackId = await h.identity(repo);
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.settle();
		const job = receipt.jobId ? h.engine.job(receipt.jobId) : undefined;
		expect(job?.status).toBe('failed');
		expect(job?.error?.title).toBe('Exposure could not be verified');
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
		expect(stateOf(h, stackId)?.exposure.verdict).toBe('unknown');
	});

	it('fails closed when the owner of a started stack cannot be found', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		h.discovery.ownersUnavailable = true;
		const stackId = await h.identity(repo);
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.settle();
		const job = receipt.jobId ? h.engine.job(receipt.jobId) : undefined;
		expect(job?.status).toBe('failed');
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
	});

	it('re-checks running managed stacks with lsof every 5 min', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		const stackId = await startStack(h, repo);
		const lsof = () =>
			h.discovery.probes.filter((probe) => probe === 'lsof').length;
		const before = lsof();
		const stack = h.cli.stacks.get(stackId);
		if (stack) stack.lanExposed = true;
		await h.advance(5 * 60_000 + 15_000);
		expect(lsof()).toBeGreaterThan(before);
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
		expect(stateOf(h, stackId)?.exposure.verdict).toBe('lan-exposed');
	});
});

describe('SupabaseEngine container stacks', () => {
	it('stops a Docker stack on a managed identity once, and never attaches it', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const stackId = await h.identity(repo);
		h.cli.addStack({
			id: stackId,
			projectRoot: repo,
			runtime: 'docker',
			running: true,
		});
		await h.engine.start();
		await h.settle();
		expect(h.cli.count('stack stop')).toBe(1);
		expect(h.engine.stackStore.record(stackId)?.flags.containerStoppedAt).toBe(
			h.clock.now
		);
		// Someone starts it again: it is left alone.
		const stack = h.cli.stacks.get(stackId);
		if (stack) stack.running = true;
		await h.advance(6 * 60_000);
		expect(h.cli.count('stack stop')).toBe(1);
		const lane = await h.engine.ensureForLane({
			laneId: 'lane-11111111-2222-4333-8444-555555555555',
			worktreePath: repo,
			branch: 'main',
			environmentId: 'development',
			policy: 'auto',
		});
		expect(lane.summary.status).toBe('refused');
		expect(lane.laneEnv).toBeUndefined();
	});
});

describe('SupabaseEngine admission', () => {
	it('stops the least recently used unheld stack to make room', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.settle();
		await h.engine.policyStore.updatePolicy({ maxRunning: 1 });
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await agentUp(h, first);
		const firstId = await h.identity(first);
		await h.engine.runAgentOperation(
			{ operation: 'down', target: { worktreePath: first } },
			{ requestId: 'request-2', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		await h.settle();
		const secondId = await startStack(h, second);
		expect(h.cli.stacks.get(firstId)?.running).toBe(false);
		expect(h.cli.stacks.get(secondId)?.running).toBe(true);
		const room = h.engine
			.getState()
			.jobs.find((job) => job.kind === 'create' && job.stackIds[0] === secondId)
			?.steps?.find((step) => step.id === 'room');
		expect(room?.state).toBe('done');
	});

	it('refuses a start when nothing can make room, and files a request for an agent', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.settle();
		await h.engine.policyStore.updatePolicy({ maxRunning: 1 });
		await startStack(h, first);
		await expect(agentUp(h, second)).rejects.toMatchObject({
			code: 'supabase_capacity',
		});
		const requests = h.engine.getState().requests;
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ kind: 'start-capacity' });
	});

	it('refuses every start under critical memory pressure', async () => {
		const h = await createEngineHarness({
			enabled: true,
			start: false,
			memoryPressure: 'critical',
		});
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		const stackId = await h.identity(repo);
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		expect(receipt.completed).toBe(false);
		expect(receipt.error?.message).toMatch(/Memory pressure is critical/);
		await expect(agentUp(h, repo)).rejects.toMatchObject({
			code: 'supabase_capacity',
		});
		expect(h.cli.count('stack start')).toBe(0);
	});
});

describe('SupabaseEngine lifecycle', () => {
	it('creates a missing stack natively with the policy exclusions', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo', { migrations: 2 });
		await h.engine.start();
		await h.settle();
		const stackId = await startStack(h, repo);
		const [start] = h.cli.callsOf('stack start');
		expect(start?.argv).toEqual([
			'stack',
			'start',
			'--workdir',
			repo,
			'--runtime',
			'native',
			'--exclude',
			'studio,analytics',
			'--output-format',
			'json',
		]);
		expect(start?.detached).toBe(true);
		const record = h.engine.stackStore.record(stackId);
		expect(record).toMatchObject({
			origin: 'managed',
			binaryPath: start?.binaryPath,
			cliVersion: '2.121.0',
			exclusions: ['studio', 'analytics'],
			pinned: true,
		});
		expect(stateOf(h, stackId)?.state).toBe('running');
		expect(h.engine.getState().activity[0]).toMatchObject({
			kind: 'create',
			outcome: 'complete',
		});
	});

	it('resumes a stopped stack by id with its exclusions passed again', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		const stackId = await startStack(h, repo);
		await h.engine.runOperation(op({ kind: 'stop', stackIds: [stackId] }), {
			...OPERATOR,
		});
		await h.settle();
		expect(stateOf(h, stackId)?.state).toBe('stopped');
		await h.engine.runOperation(op({ kind: 'start', stackId }), OPERATOR);
		await h.settle();
		const starts = h.cli.callsOf('stack start');
		expect(starts[1]?.argv).toEqual([
			'stack',
			'start',
			'--stack-id',
			stackId,
			'--runtime',
			'native',
			'--exclude',
			'studio,analytics',
			'--output-format',
			'json',
		]);
		expect(stateOf(h, stackId)?.state).toBe('running');
	});

	it('creates again after a failed first start registered an empty stack', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		const stackId = await h.identity(repo);
		h.cli.replyNext('stack start', {
			exitCode: 1,
			stdout: `${JSON.stringify({ _tag: 'Error', error: { code: 'ExperimentalStackStartError', message: 'database: initdb failed' } })}\n`,
			stderr: ['[task] failed: database: initdb failed'],
		});
		const failed = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.settle();
		expect(h.engine.job(failed.jobId ?? '')?.status).toBe('failed');
		expect(h.engine.stackStore.record(stackId)?.flags.failedStart).toBe(true);
		// The CLI still registered the stack, with no members.
		h.cli.addStack({ id: stackId, projectRoot: repo, members: 0 });
		await h.engine.runOperation(op({ kind: 'refresh' }), OPERATOR);
		expect(stateOf(h, stackId)?.state).toBe('failed');
		await h.engine.runOperation(op({ kind: 'start', stackId }), OPERATOR);
		await h.settle();
		const starts = h.cli.callsOf('stack start');
		expect(starts).toHaveLength(2);
		expect(starts[1]?.argv).toContain('--workdir');
		expect(
			h.engine.stackStore.record(stackId)?.flags.failedStart
		).toBeUndefined();
		expect(stateOf(h, stackId)?.state).toBe('running');
	});

	it('creates one stack at a time and lets a queued creation be cancelled', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.settle();
		const release = h.cli.hold('stack start');
		const firstId = await h.identity(first);
		const secondId = await h.identity(second);
		const one = await h.engine.runOperation(
			op({ kind: 'start', stackId: firstId }),
			OPERATOR
		);
		await h.cli.waitForCall('stack start');
		const two = await h.engine.runOperation(
			op({ kind: 'start', stackId: secondId }),
			OPERATOR
		);
		expect(two.message).toBe('Queued · new stacks start one at a time.');
		expect(h.engine.job(two.jobId ?? '')?.status).toBe('queued');
		expect(h.cli.count('stack start')).toBe(1);
		const cancel = await h.engine.runOperation(
			op({ kind: 'cancel-job', jobId: two.jobId }),
			OPERATOR
		);
		expect(cancel.completed).toBe(true);
		await h.until(() => h.engine.job(two.jobId ?? '')?.status === 'cancelled');
		release();
		await h.settle();
		expect(h.engine.job(one.jobId ?? '')?.status).toBe('complete');
		expect(h.cli.count('stack start')).toBe(1);
	});

	it('interrupts a running creation on cancel and marks it interrupted', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		const release = h.cli.hold('stack start');
		const stackId = await h.identity(repo);
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.cli.waitForCall('stack start');
		await h.engine.runOperation(
			op({ kind: 'cancel-job', jobId: receipt.jobId }),
			OPERATOR
		);
		await h.until(() => h.cli.interrupts.length > 0);
		release();
		await h.settle();
		expect(h.cli.interrupts).toEqual(['stack start']);
		expect(h.engine.job(receipt.jobId ?? '')?.status).toBe('cancelled');
		expect(h.engine.stackStore.record(stackId)?.flags.interrupted).toBe(true);
	});

	it('lets callers that join an ensure learn its job', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		const release = h.cli.hold('stack start');
		const stackId = await h.identity(repo);
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.cli.waitForCall('stack start');
		const up = h.engine.runAgentOperation(
			{ operation: 'up', target: { worktreePath: repo }, waitMs: 0 },
			{ requestId: 'request-1', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		const answer = await up;
		expect(answer).toMatchObject({ operation: 'up', jobId: receipt.jobId });
		release();
		await h.settle();
		expect(h.cli.count('stack start')).toBe(1);
		// The joined agent still gets its own hold once the stack runs.
		expect(
			h.engine.stackStore
				.record(stackId)
				?.holds.some((hold) => hold.agent.sessionId === 'session-a')
		).toBe(true);
	});

	it('falls back to an argv-verified SIGTERM when stop fails', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		const stackId = await startStack(h, repo);
		h.cli.replyNext('stack stop', {
			exitCode: 1,
			stdout: `${JSON.stringify({ _tag: 'Error', error: { code: 'ExperimentalStackStopError', message: 'stop failed' } })}\n`,
			stderr: [],
		});
		const receipt = await h.engine.runOperation(
			op({ kind: 'stop', stackIds: [stackId] }),
			OPERATOR
		);
		await h.until(() => h.signals.length > 0);
		await h.advance(1_000);
		expect(h.signals).toEqual([
			{ pid: h.cli.stacks.get(stackId)?.pid, signal: 'SIGTERM' },
		]);
		expect(h.engine.job(receipt.jobId ?? '')?.status).toBe('complete');
	});
});

describe('SupabaseEngine branch follow', () => {
	it('follows a held worktree to its new branch once HEAD settles for 30 s', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.settle();
		await agentUp(h, repo);
		const oldId = await h.identity(repo);
		await h.checkout(repo, 'feat-x');
		const newId = await h.identity(repo);
		await h.advance(15_000);
		expect(h.cli.stacks.has(newId)).toBe(false);
		await h.advance(31_000);
		expect(h.cli.stacks.get(newId)?.running).toBe(true);
		expect(h.cli.stacks.get(oldId)?.running).toBe(false);
		expect(
			h.engine.stackStore
				.record(newId)
				?.holds.some((hold) => hold.agent.sessionId === 'session-a')
		).toBe(true);
		expect(h.engine.stackStore.record(oldId)?.holds).toEqual([]);
		expect(h.engine.stackStore.record(oldId)?.flags.supersededBy).toBe(newId);
		// The old stack's data is kept.
		expect(h.cli.stacks.has(oldId)).toBe(true);
	});

	it('reattaches the old stack when the worktree switches back', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.settle();
		await agentUp(h, repo);
		const mainId = await h.identity(repo);
		await h.checkout(repo, 'feat-x');
		const featureId = await h.identity(repo);
		await h.advance(46_000);
		expect(h.cli.stacks.get(featureId)?.running).toBe(true);
		await h.checkout(repo, 'main');
		await h.advance(46_000);
		expect(h.cli.stacks.get(mainId)?.running).toBe(true);
		expect(h.cli.stacks.get(featureId)?.running).toBe(false);
		expect(h.cli.callsOf('stack start').at(-1)?.argv).toEqual(
			expect.arrayContaining(['--stack-id', mainId])
		);
		const record = h.engine.stackStore.record(mainId);
		expect(record?.flags.supersededBy).toBeUndefined();
		expect(
			record?.holds.some((hold) => hold.agent.sessionId === 'session-a')
		).toBe(true);
	});

	it('does not follow while a merge is in progress', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.settle();
		await agentUp(h, repo);
		await h.checkout(repo, 'feat-x');
		await writeFile(path.join(repo, '.git', 'MERGE_HEAD'), 'abc\n');
		const newId = await h.identity(repo);
		await h.advance(2 * 60_000);
		expect(h.cli.stacks.has(newId)).toBe(false);
	});

	it('only flags the stack in warn mode', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.settle();
		await h.engine.policyStore.updatePolicy({ branchSwitch: 'warn' });
		await agentUp(h, repo);
		const oldId = await h.identity(repo);
		await h.checkout(repo, 'feat-x');
		await h.advance(2 * 60_000);
		expect(h.cli.stacks.get(oldId)?.running).toBe(true);
		expect(h.cli.count('stack start')).toBe(1);
	});
});

describe('SupabaseEngine CLI drift', () => {
	it('restarts a stack whose owner binary vanished with the worktree CLI, once', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		const stackId = await startStack(h, repo);
		// pnpm install replaced the binary the owner runs.
		const stack = h.cli.stacks.get(stackId);
		if (stack) stack.executable = '/opt/example/old/supabase';
		await h.advance(15_000);
		expect(stateOf(h, stackId)?.flags).toContain('cli-changed');
		await h.advance(45_000);
		expect(h.cli.count('stack stop')).toBe(1);
		expect(h.cli.callsOf('stack start').at(-1)?.argv).toContain('--stack-id');
		expect(h.cli.stacks.get(stackId)?.executable).not.toBe(
			'/opt/example/old/supabase'
		);
	});

	it('restarts a stack running another CLI release when an agent attaches', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.settle();
		const stackId = await startStack(h, repo);
		h.cli.replyNext(
			'stack status',
			h.cli.fixtureFor('status-release-mismatch', stackId)
		);
		h.cli.replyNext('stack status', h.cli.fixtureFor('status-awake', stackId));
		const result = await agentUp(h, repo);
		expect(result).toMatchObject({ operation: 'up' });
		expect(h.cli.count('stack stop')).toBe(1);
		expect(h.cli.callsOf('stack start').at(-1)?.argv).toEqual(
			expect.arrayContaining(['--stack-id', stackId])
		);
		expect(h.engine.getState().activity[0]).toMatchObject({
			kind: 'stop-and-start',
			outcome: 'complete',
		});
	});

	it('leaves a stack alone when the worktree CLI is not verified', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		const stackId = await startStack(h, repo);
		h.resolver.binaries.set('/opt/example/next/supabase', '2.130.0');
		h.resolver.worktreeBinaries.set(repo, '/opt/example/next/supabase');
		await h.engine.runOperation(
			op({
				kind: 'repository.recheck',
				repositoryId: stateOf(h, stackId)?.repositoryId,
			}),
			OPERATOR
		);
		await h.advance(2 * 60_000);
		expect(h.cli.count('stack stop')).toBe(0);
		expect(stateOf(h, stackId)?.mode.value).toBe('observed');
	});
});

describe('SupabaseEngine steering', () => {
	it('writes steering.json v1 for managed roots', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo', { lockfile: true });
		await h.engine.start();
		await h.settle();
		await startStack(h, repo);
		await h.advance(15_000);
		const file = h.engine.steeringWriter.file;
		expect(path.dirname(file)).toBe(h.agentDirectory);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const steering = JSON.parse(await readFile(file, 'utf8'));
		expect(steering).toEqual({
			version: 1,
			writtenAt: expect.any(Number),
			desktopPid: process.pid,
			supabase: {
				enabled: true,
				roots: [
					{
						worktreeRoot: repo,
						projectRoot: repo,
						mode: 'managed',
						branchContext: 'refs/heads/main',
						stackReady: true,
						runner: 'pnpm exec supabase',
					},
				],
			},
		});
	});
});

describe('SupabaseEngine releases', () => {
	it('releases a holder at once and leaves the stop to the linger', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.settle();
		await agentUp(h, repo);
		const stackId = await h.identity(repo);
		expect(h.engine.holderKeys()).toEqual([
			{ holder: CLAUDE, directory: repo },
		]);
		const released = await h.engine.releaseHolder({ holder: CLAUDE });
		expect(released).toEqual({
			releasedStackIds: [stackId],
			pendingStops: [stackId],
		});
		expect(h.cli.count('stack stop')).toBe(0);
		await h.advance(61_000);
		expect(h.cli.count('stack stop')).toBe(1);
	});

	it('releases nothing for a synthetic holder without a session directory', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		await h.engine.start();
		await expect(
			h.engine.releaseHolder({
				holder: { kind: 'codex', sessionId: 'mcp-1234' },
			})
		).resolves.toEqual({ releasedStackIds: [], pendingStops: [] });
	});
});

describe('SupabaseEngine hardening toggles', () => {
	const PINNED = '[experimental]\nstack = true\n[api]\nport = 54321\n';

	it('refuses a pinned port another stack holds, unless leases are on', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first', { config: PINNED });
		const second = await h.repository('second', { config: PINNED });
		await h.engine.start();
		await h.settle();
		const firstId = await startStack(h, first);
		const stack = h.cli.stacks.get(firstId);
		if (stack) stack.apiPort = 54_321;
		await h.engine.runOperation(op({ kind: 'refresh' }), OPERATOR);
		await expect(agentUp(h, second)).rejects.toMatchObject({
			code: 'ports_pinned',
		});
		await h.engine.policyStore.updatePolicy({ pinnedPortsCompat: true });
		await agentUp(h, second);
		const lease = h.cli.callsOf('stack start').at(-1);
		expect(lease?.leasedPorts).toEqual({ SUPABASE_API_PORT: '33000' });
		expect(h.cli.callsOf('stack start')[0]?.leasedPorts).toBeUndefined();
	});

	it('passes --eager only for lane-driven creates with eager lanes on', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const other = await h.repository('other');
		h.lanes.lanes = [
			fakeLane({
				id: 'lane-11111111-2222-4333-8444-555555555555',
				worktreePath: repo,
			}),
		];
		await h.engine.start();
		await h.settle();
		await h.engine.policyStore.updatePolicy({ eagerLanes: true });
		await h.engine.ensureForLane({
			laneId: 'lane-11111111-2222-4333-8444-555555555555',
			worktreePath: repo,
			branch: 'main',
			environmentId: 'development',
			policy: 'auto',
		});
		await h.settle();
		expect(h.cli.callsOf('stack start')[0]?.argv).toContain('--eager');
		await startStack(h, other);
		expect(h.cli.callsOf('stack start')[1]?.argv).not.toContain('--eager');
	});

	it('writes per-stack keys before a start once git confirms they are ignored', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		await h.engine.policyStore.updatePolicy({ perStackKeys: true });
		await startStack(h, repo);
		const env = await readFile(
			path.join(repo, 'supabase', '.env.local'),
			'utf8'
		);
		expect(env).toMatch(/^SUPABASE_AUTH_SECRET_KEY=sb_secret_/m);
		expect(h.checkIgnores.length).toBeGreaterThan(0);
		// The lane no longer warns about the shared default keys.
		const stackId = await h.identity(repo);
		expect(stateOf(h, stackId)?.state).toBe('running');
		expect(JSON.stringify(h.engine.getState())).not.toMatch(SECRET_SHAPED);
	});

	it('never writes keys into a file git would commit', async () => {
		const h = await createEngineHarness({
			enabled: true,
			start: false,
			gitIgnored: false,
		});
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		await h.engine.policyStore.updatePolicy({ perStackKeys: true });
		await startStack(h, repo);
		await expect(
			stat(path.join(repo, 'supabase', '.env.local'))
		).rejects.toThrow();
	});
});

describe('SupabaseEngine storage', () => {
	it('keeps its stores in a private <userData>/supabase', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.settle();
		await startStack(h, repo);
		const root = path.join(h.userData, 'supabase');
		expect((await stat(root)).mode & 0o777).toBe(0o700);
		for (const file of [
			h.engine.stackStore.file,
			h.engine.jobStore.file,
			h.engine.policyStore.file,
		]) {
			expect(path.dirname(file)).toBe(await realpath(root));
			expect((await stat(file)).mode & 0o777).toBe(0o600);
		}
		// Every CLI call ran from the neutral cwd, never a worktree.
		expect(h.engine.cwd).toBe(path.join(h.userData, 'supabase', 'cwd'));
	});

	it('runs no CLI while a supabase/config.toml sits above its working directory', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		await h.repository('repo');
		await writeFile(path.join(h.userData, 'supabase', 'config.toml'), '');
		await h.engine.start();
		await h.settle();
		expect(h.cli.count()).toBe(0);
		expect(h.engine.getState().discovery.listFailure?.message).toMatch(
			/Supabase CLI calls are blocked/
		);
		expect(h.logs.join('\n')).toMatch(
			/runs no Supabase CLI until it is removed/
		);
	});
});
