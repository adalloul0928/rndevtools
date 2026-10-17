import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	supabaseDesktopError,
	supabaseJobSchema,
} from '../../shared/supabase-protocol';
import {
	loadSupabaseCliFixture,
	realisticSecrets,
	SECRET_SHAPED,
} from './cli-fixtures.test-support';
import {
	advanceSupabaseJobProgress,
	initialSupabaseJobSteps,
	markSupabaseJobStep,
	parseSupabaseProgressLine,
	type SupabaseJobProgress,
	SupabaseJobStore,
	supabaseArgvDigest,
} from './job-store';

const NOW = 1_792_245_785_000;
const STACK =
	'b2e7a5393a8054d7b4658b68c7c7bb12092465347f6e3fbb7afb6864534dd9e8';
const directories: string[] = [];

async function root(): Promise<string> {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'rndevtools-supabase-jobs-')
	);
	directories.push(directory);
	return path.join(directory, 'supabase');
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

function ids() {
	let next = 0;
	return () => {
		next += 1;
		return `00000000-0000-4000-8000-${next.toString(16).padStart(12, '0')}`;
	};
}

function jobStore(directory: string, clock = { now: NOW }) {
	return new SupabaseJobStore({
		directory,
		now: () => clock.now,
		newId: ids(),
	});
}

function replay(
	progress: SupabaseJobProgress,
	lines: readonly string[]
): SupabaseJobProgress {
	return lines.reduce(advanceSupabaseJobProgress, progress);
}

function states(progress: SupabaseJobProgress): Record<string, string> {
	return Object.fromEntries(
		progress.steps.map((step) => [step.id, step.state])
	);
}

describe('job steps', () => {
	it('lists the steps each job kind shows', () => {
		expect(
			initialSupabaseJobSteps('create', {
				migrationTotal: 2,
				lanePort: 8_106,
			}).map((step) => [step.id, step.label, step.state])
		).toEqual([
			['room', 'Check room', 'pending'],
			['database', 'Start the database', 'pending'],
			['migrations', 'Apply 2 migrations', 'pending'],
			['seed', 'Seed data', 'pending'],
			['verify', 'Verify it listens only on 127.0.0.1', 'pending'],
			['attach', 'Attach to lane :8106', 'pending'],
		]);
		expect(initialSupabaseJobSteps('resume').map((step) => step.id)).toEqual([
			'room',
			'database',
			'verify',
		]);
		expect(
			initialSupabaseJobSteps('reset', { migrationTotal: 1, seed: false }).map(
				(step) => step.id
			)
		).toEqual(['reset', 'migrations']);
		expect(initialSupabaseJobSteps('prepare').map((step) => step.id)).toEqual([
			'download',
			'stop',
		]);
		for (const kind of [
			'create',
			'resume',
			'stop',
			'restart',
			'stop-and-start',
			'destroy',
			'recreate',
			'reset',
			'migrate',
			'seed-buckets',
			'export',
			'prepare',
			'follow',
			'studio',
			'disable',
		] as const) {
			const steps = initialSupabaseJobSteps(kind, {
				migrationTotal: 3,
				lanePort: 8_100,
			});
			expect(steps.length).toBeGreaterThan(0);
			expect(steps.length).toBeLessThanOrEqual(16);
		}
	});

	it('classifies the CLI progress lines the fixtures recorded', () => {
		const lines = [
			...loadSupabaseCliFixture('start-fresh').stderr,
			...loadSupabaseCliFixture('db-reset').stderr,
			...loadSupabaseCliFixture('destroy-single').stderr,
			...loadSupabaseCliFixture('restart').stderr,
			...loadSupabaseCliFixture('prepare').stderr,
			...loadSupabaseCliFixture('db-dump').stderr,
			...loadSupabaseCliFixture('start-needs-recreate').stderr,
		];
		expect(lines.map((line) => parseSupabaseProgressLine(line)?.kind)).toEqual([
			'task-start',
			'roles',
			'migration',
			'seed',
			'task-done',
			'reset',
			'roles',
			'migration',
			'migration',
			'seed',
			'finished',
			'destroy',
			'task-start',
			'task-start',
			'task-start',
			'export',
			'note',
			'task-start',
			'task-failed',
		]);
		expect(
			parseSupabaseProgressLine(
				'Applying migration 20261016000000_notes.sql...'
			)
		).toEqual({ kind: 'migration', file: '20261016000000_notes.sql' });
		expect(
			parseSupabaseProgressLine(
				'[task] start: Destroying stack 0000000000000000000000000000000000000000000000000000000000000001...'
			)
		).toEqual({ kind: 'task-start', step: 'destroy' });
		expect(parseSupabaseProgressLine('Creating bucket avatars...')).toEqual({
			kind: 'buckets',
		});
		expect(parseSupabaseProgressLine('   ')).toBeUndefined();
	});

	it('follows a first start from its stderr', () => {
		const start = {
			steps: markSupabaseJobStep(
				initialSupabaseJobSteps('create', { migrationTotal: 1 }),
				'room',
				'done'
			),
			migration: { done: 0, total: 1 },
		};
		const lines = loadSupabaseCliFixture('start-fresh').stderr;
		const midway = replay(start, lines.slice(0, 3));
		expect(states(midway)).toMatchObject({
			room: 'done',
			database: 'done',
			migrations: 'current',
			seed: 'pending',
		});
		expect(midway.migration).toEqual({ done: 1, total: 1 });
		expect(midway.steps.find((step) => step.id === 'migrations')?.detail).toBe(
			'1 of 1'
		);
		expect(midway.latestLine).toBe(
			'Applying migration 20261016000000_notes.sql...'
		);
		const done = replay(midway, lines.slice(3));
		expect(states(done)).toEqual({
			room: 'done',
			database: 'done',
			migrations: 'done',
			seed: 'done',
			verify: 'pending',
		});
		expect(done.outcome).toBe('done');
		expect(done.latestLine).toBe('[task] done: Stack is ready.');
	});

	it('marks the current step failed and skips untouched start steps', () => {
		const failed = replay(
			{ steps: initialSupabaseJobSteps('create', { migrationTotal: 2 }) },
			loadSupabaseCliFixture('start-needs-recreate').stderr
		);
		expect(states(failed)).toMatchObject({
			room: 'pending',
			database: 'failed',
			migrations: 'pending',
		});
		expect(failed.outcome).toBe('failed');
		expect(failed.steps.find((step) => step.id === 'database')?.detail).toMatch(
			/cannot adopt these changes/
		);
		// A resume never applies migrations or seeds: those stay skipped.
		const resumed = replay(
			{ steps: initialSupabaseJobSteps('create', { migrationTotal: 2 }) },
			['[task] start: Starting local Supabase stack...', '[task] done: ok']
		);
		expect(states(resumed)).toMatchObject({
			database: 'done',
			migrations: 'skipped',
			seed: 'skipped',
		});
	});

	it('adds a migrations step it did not expect and counts against the total', () => {
		const progress = replay({ steps: initialSupabaseJobSteps('resume') }, [
			'[task] start: Starting local Supabase stack...',
			'Applying migration a.sql...',
			'Applying migration b.sql...',
		]);
		expect(progress.steps.map((step) => step.id)).toEqual([
			'room',
			'database',
			'migrations',
			'verify',
		]);
		expect(progress.migration).toEqual({ done: 2, total: 2 });
	});

	it('redacts what a progress line or failure carries', () => {
		const secrets = realisticSecrets();
		const progress = replay({ steps: initialSupabaseJobSteps('resume') }, [
			'[task] start: Starting local Supabase stack...',
			`[task] failed: could not connect ${secrets.dbUrl} with ${secrets.secretKey}\u001b[31m`,
		]);
		const text = JSON.stringify(progress);
		expect(text).not.toMatch(SECRET_SHAPED);
		expect(text).not.toContain(secrets.dbPassword);
		expect(progress.latestLine).not.toContain('\u001b');
		expect(progress.latestLine).not.toContain('[31m');
		expect(progress.latestLine?.length).toBeLessThanOrEqual(512);
	});
});

describe('SupabaseJobStore', () => {
	it('runs a job from queued to complete and keeps it in the ring', async () => {
		const directory = await root();
		const clock = { now: NOW };
		const jobs = jobStore(directory, clock);
		expect((await jobs.load()).health).toBe('ok');
		const job = await jobs.create({
			kind: 'create',
			stackIds: [STACK],
			requestedBy: { kind: 'operator' },
			cancellable: true,
			expectedMs: 5_000,
			steps: initialSupabaseJobSteps('create', { migrationTotal: 1 }),
			migrationTotal: 1,
		});
		expect(job.id).toBe('supabase-job-00000000-0000-4000-8000-000000000001');
		expect(job).toMatchObject({
			status: 'queued',
			migration: { done: 0, total: 1 },
		});
		expect(jobs.activeJobs().map((entry) => entry.id)).toEqual([job.id]);

		clock.now += 100;
		expect(jobs.start(job.id)?.steps?.[0]?.state).toBe('current');
		jobs.markStep(job.id, 'room', 'done', '3 of 12 running');
		for (const line of loadSupabaseCliFixture('start-fresh').stderr) {
			jobs.progress(job.id, line);
		}
		jobs.markStep(job.id, 'verify', 'current');
		expect(jobs.requestCancel(job.id)?.cancelRequested).toBe(true);
		clock.now += 4_000;
		const finished = await jobs.finish(job.id, { status: 'complete' });
		expect(finished).toMatchObject({
			status: 'complete',
			cancellable: false,
			updatedAt: NOW + 4_100,
		});
		expect(finished?.cancelRequested).toBeUndefined();
		expect(finished?.steps?.map((step) => step.state)).toEqual([
			'done',
			'done',
			'done',
			'done',
			'done',
		]);
		expect(supabaseJobSchema.parse(finished)).toEqual(finished);
		// Progress after the end is ignored.
		expect(jobs.progress(job.id, 'Applying migration x.sql...')).toEqual(
			finished
		);

		const file = path.join(directory, 'jobs.json');
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const reloaded = jobStore(directory, clock);
		const loaded = await reloaded.load();
		expect(loaded.lost).toEqual([]);
		expect(reloaded.job(job.id)?.status).toBe('complete');
	});

	it('reports jobs in flight at a restart as lost', async () => {
		const directory = await root();
		const clock = { now: NOW };
		const jobs = jobStore(directory, clock);
		await jobs.load();
		const job = await jobs.create({
			kind: 'resume',
			stackIds: [STACK],
			requestedBy: {
				kind: 'lane',
				laneId: 'lane-c69dc564-b12e-45d5-b0d5-3e9d034a072d',
			},
			cancellable: true,
			steps: initialSupabaseJobSteps('resume'),
		});
		jobs.start(job.id);
		await jobs.recordChild({
			jobId: job.id,
			pid: 4_242,
			startedAt: NOW,
			argvDigest: supabaseArgvDigest(['stack', 'start']),
			progressFile:
				'/Users/example/Library/Application Support/RN Devtools/supabase/progress/start.log',
			stackIds: [STACK],
		});

		clock.now += 60_000;
		const restarted = jobStore(directory, clock);
		const loaded = await restarted.load();
		expect(loaded.lost).toEqual([job.id]);
		expect(loaded.children.map((child) => child.pid)).toEqual([4_242]);
		const lost = restarted.job(job.id);
		expect(lost).toMatchObject({ status: 'lost', cancellable: false });
		expect(await restarted.waitFor(job.id, 5_000)).toEqual(lost);
		// The loss is persisted: a second restart still answers lost.
		const again = jobStore(directory, clock);
		expect((await again.load()).lost).toEqual([]);
		expect(again.job(job.id)?.status).toBe('lost');

		// A child the service adopted brings the job back.
		expect(again.adopt(job.id)?.status).toBe('running');
		expect(again.activeJobs().map((entry) => entry.id)).toEqual([job.id]);
		await again.releaseChild(job.id);
		expect(again.children()).toEqual([]);
		expect(
			again.adopt('supabase-job-00000000-0000-4000-8000-0000000000ff')
		).toBeUndefined();
	});

	it('refuses child bookkeeping that could signal the wrong process', async () => {
		const directory = await root();
		const jobs = jobStore(directory);
		await jobs.load();
		const base = {
			jobId: 'supabase-job-00000000-0000-4000-8000-000000000001',
			startedAt: NOW,
			argvDigest: supabaseArgvDigest(['stack']),
			progressFile: '/tmp/progress.log',
			stackIds: [STACK],
		};
		await expect(jobs.recordChild({ ...base, pid: 1 })).rejects.toThrow();
		await expect(jobs.recordChild({ ...base, pid: 0 })).rejects.toThrow();
		await expect(
			jobs.recordChild({ ...base, pid: 99, progressFile: 'relative.log' })
		).rejects.toThrow();
		expect(jobs.children()).toEqual([]);
		expect(supabaseArgvDigest(['a', 'b'])).toMatch(/^[0-9a-f]{64}$/);
		expect(supabaseArgvDigest(['a', 'b'])).not.toBe(supabaseArgvDigest(['ab']));
	});

	it('waits for a job to end, or answers at the timeout or abort', async () => {
		const directory = await root();
		const jobs = jobStore(directory);
		await jobs.load();
		const job = await jobs.create({
			kind: 'stop',
			stackIds: [STACK],
			requestedBy: { kind: 'automatic', reason: 'idle' },
			cancellable: false,
		});
		jobs.start(job.id);
		const waiting = jobs.waitFor(job.id, 5_000);
		await jobs.finish(job.id, { status: 'complete' });
		expect((await waiting)?.status).toBe('complete');

		const other = await jobs.create({
			kind: 'stop',
			stackIds: [STACK],
			requestedBy: { kind: 'operator' },
			cancellable: false,
		});
		expect((await jobs.waitFor(other.id, 10))?.status).toBe('queued');
		const controller = new AbortController();
		const aborted = jobs.waitFor(other.id, 5_000, controller.signal);
		controller.abort();
		expect((await aborted)?.status).toBe('queued');
		expect(
			await jobs.waitFor(
				'supabase-job-00000000-0000-4000-8000-0000000000aa',
				10
			)
		).toBeUndefined();
	});

	it('records failures with a renderer-safe error and lists recent jobs', async () => {
		const directory = await root();
		const clock = { now: NOW };
		const jobs = jobStore(directory, clock);
		await jobs.load();
		const failing = await jobs.create({
			kind: 'resume',
			stackIds: [STACK],
			requestedBy: { kind: 'operator' },
			cancellable: true,
			steps: initialSupabaseJobSteps('resume'),
		});
		jobs.start(failing.id);
		jobs.progress(failing.id, '[task] start: Starting local Supabase stack...');
		const error = supabaseDesktopError('refused', 'No Postgres slot is free.');
		const failed = await jobs.finish(failing.id, { status: 'failed', error });
		expect(failed?.error).toEqual(error);
		expect(failed?.steps?.map((step) => step.state)).toEqual([
			'done',
			'failed',
			'pending',
		]);
		const running = await jobs.create({
			kind: 'stop',
			stackIds: [STACK],
			requestedBy: { kind: 'operator' },
			cancellable: false,
		});
		expect(jobs.jobs().map((job) => job.id)).toEqual([running.id, failing.id]);
		clock.now += 11 * 60_000;
		expect(jobs.jobs().map((job) => job.id)).toEqual([running.id]);
		// The ring still answers for it.
		expect(jobs.job(failing.id)?.status).toBe('failed');
		// A cancel request needs a cancellable job.
		expect(jobs.requestCancel(running.id)?.cancelRequested).toBeUndefined();
	});

	it('writes no secret to jobs.json, whatever a line or error carried', async () => {
		const directory = await root();
		const jobs = jobStore(directory);
		await jobs.load();
		const secrets = realisticSecrets();
		const job = await jobs.create({
			kind: 'resume',
			stackIds: [STACK],
			requestedBy: { kind: 'operator' },
			cancellable: true,
			steps: initialSupabaseJobSteps('resume'),
		});
		jobs.start(job.id);
		jobs.progress(
			job.id,
			`[task] failed: ${secrets.dbUrl} ${secrets.secretKey}`
		);
		await jobs.finish(job.id, {
			status: 'failed',
			error: {
				...supabaseDesktopError('internal', 'failed'),
				message: `${secrets.anonKey} at ${secrets.dbUrl}`,
			},
		});
		const file = await readFile(path.join(directory, 'jobs.json'), 'utf8');
		expect(file).not.toMatch(SECRET_SHAPED);
		for (const secret of [
			secrets.dbPassword,
			secrets.secretKey,
			secrets.anonKey,
		]) {
			expect(file).not.toContain(secret);
		}
	});

	// 70 jobs, each persisted durably (fsync) when created and when finished.
	it('keeps the newest 64 terminal jobs in its ring', async () => {
		const directory = await root();
		const jobs = jobStore(directory);
		await jobs.load();
		const created: string[] = [];
		for (let index = 0; index < 70; index += 1) {
			const job = await jobs.create({
				kind: 'stop',
				stackIds: [STACK],
				requestedBy: { kind: 'operator' },
				cancellable: false,
			});
			created.push(job.id);
			await jobs.finish(job.id, { status: 'complete' });
		}
		const stored = JSON.parse(
			await readFile(path.join(directory, 'jobs.json'), 'utf8')
		);
		expect(stored.ring).toHaveLength(64);
		expect(stored.ring[0].id).toBe(created[69]);
		const reloaded = jobStore(directory);
		await reloaded.load();
		expect(reloaded.job(created[0] as string)).toBeUndefined();
		expect(reloaded.job(created[69] as string)?.status).toBe('complete');
	}, 30_000);

	it('quarantines an unreadable history and starts empty', async () => {
		const directory = await root();
		await mkdir(directory, { recursive: true });
		await writeFile(
			path.join(directory, 'jobs.json'),
			'{"version":1,"ring":7}'
		);
		const jobs = jobStore(directory);
		const loaded = await jobs.load();
		expect(loaded).toEqual({ health: 'quarantined', lost: [], children: [] });
		expect(
			await readFile(path.join(directory, `jobs.json.corrupt-${NOW}`), 'utf8')
		).toBe('{"version":1,"ring":7}');
	});

	it('keeps working when its history cannot be written', async () => {
		const directory = await root();
		const lines: string[] = [];
		const jobs = new SupabaseJobStore({
			directory,
			now: () => NOW,
			newId: ids(),
			log: (line) => lines.push(line),
		});
		await jobs.load();
		await mkdir(path.join(directory, 'jobs.json'));
		const job = await jobs.create({
			kind: 'stop',
			stackIds: [STACK],
			requestedBy: { kind: 'operator' },
			cancellable: false,
		});
		expect(jobs.job(job.id)?.status).toBe('queued');
		expect(lines.some((line) => line.includes('could not be saved'))).toBe(
			true
		);
	});

	it('notifies subscribers of in-memory progress', async () => {
		const directory = await root();
		const jobs = jobStore(directory);
		await jobs.load();
		let calls = 0;
		jobs.subscribe(() => {
			calls += 1;
		});
		const job = await jobs.create({
			kind: 'restart',
			stackIds: [STACK],
			requestedBy: { kind: 'operator' },
			cancellable: false,
			steps: initialSupabaseJobSteps('restart'),
		});
		jobs.start(job.id);
		jobs.progress(
			job.id,
			'[task] start: Restarting the saved stack composition...'
		);
		expect(calls).toBe(3);
		jobs.setDetails(job.id, { expectedMs: 1_000, coldCache: false });
		expect(jobs.job(job.id)).toMatchObject({
			expectedMs: 1_000,
			coldCache: false,
		});
	});
});
