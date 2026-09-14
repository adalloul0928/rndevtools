import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuildInsightsService } from './build-insights-service';
import { BuildInsightsStore } from './build-insights-store';

const temporaryRoots: string[] = [];

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

async function fixture() {
	const root = await mkdtemp(
		path.join(tmpdir(), 'pumpd-build-insights-service-')
	);
	temporaryRoots.push(root);
	const resultPath = path.join(root, 'Build-PUMPD.xcresult');
	await mkdir(resultPath);
	const now = Date.UTC(2026, 7, 30, 18, 0, 0);
	const runXcresult = vi.fn(async () => ({
		actionTitle: 'Build PUMPD',
		destination: {
			deviceName: 'iPhone 17 Pro',
			platform: 'iOS Simulator',
			osVersion: '20.0',
		},
		startTime: '2026-08-30T17:59:42.000Z',
		endTime: '2026-08-30T18:00:00.000Z',
		status: 'succeeded',
		warningCount: 3,
		errorCount: 0,
		analyzerWarningCount: 1,
	}));
	const service = new BuildInsightsService({
		store: new BuildInsightsStore(path.join(root, 'store'), { now: () => now }),
		runXcresult,
		watchFactory: () =>
			Object.assign(new EventEmitter(), {
				close: vi.fn(),
			}) as unknown as FSWatcher,
		now: () => now,
	});
	await service.start();
	return { root, resultPath, runXcresult, service };
}

async function exportCsvWithBuildName(
	service: BuildInsightsService,
	root: string,
	name: string
): Promise<{ buildId: string; exported: string }> {
	const state = service.getState();
	const build = state.builds[0];
	if (!build) throw new Error('Expected a build fixture before exporting CSV.');
	vi.spyOn(service, 'getState').mockReturnValue({
		...state,
		builds: [{ ...build, name }],
	});
	const exportPath = path.join(root, 'builds.csv');
	await service.export('csv', exportPath);
	return { buildId: build.id, exported: await readFile(exportPath, 'utf8') };
}

function quotedCsvCell(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

describe('BuildInsightsService', () => {
	it('imports an xcresult through a bounded projection without exposing its path', async () => {
		const { resultPath, runXcresult, service } = await fixture();
		const state = await service.importXcresult(resultPath);

		expect(runXcresult).toHaveBeenCalledWith(await realpath(resultPath));
		expect(state.builds).toHaveLength(1);
		expect(state.builds[0]).toMatchObject({
			name: 'Build PUMPD',
			durationMs: 18_000,
			status: 'succeeded',
			classification: 'unknown',
			classificationConfidence: 'unknown',
			warnings: 3,
			errors: 0,
		});
		expect(JSON.stringify(state)).not.toContain(resultPath);
		await service.stop();
	});

	it('discovers nested xcresults and exports only the renderer-safe projection', async () => {
		const { root, runXcresult, service } = await fixture();
		const derivedData = path.join(root, 'DerivedData');
		const nestedResult = path.join(
			derivedData,
			'PUMPD',
			'Logs',
			'Build',
			'Nested.xcresult'
		);
		await mkdir(nestedResult, { recursive: true });
		await service.addWatchRoot(derivedData);
		expect(runXcresult).toHaveBeenCalledWith(await realpath(nestedResult));

		const exportPath = path.join(root, 'builds.json');
		await service.export('json', exportPath);
		const exported = await readFile(exportPath, 'utf8');
		expect(exported).toContain('pumpd-build-insights');
		expect(exported).not.toContain(derivedData);
		await service.stop();
	});

	it.each([
		['equals', '=HYPERLINK("https://attacker.invalid")'],
		['plus', '+SUM(1,1)'],
		['minus', "-cmd|' /C calc'!A0"],
		['at sign', '@SUM(1,1)'],
		['tab', '\t=SUM(1,1)'],
		['carriage return', '\r=SUM(1,1)'],
		['line feed', '\n=SUM(1,1)'],
	])(
		'neutralizes a leading %s before RFC 4180 CSV quoting',
		async (_, value) => {
			const { resultPath, root, service } = await fixture();
			await service.importXcresult(resultPath);

			const { buildId, exported } = await exportCsvWithBuildName(
				service,
				root,
				value
			);

			expect(exported).toContain(
				`${quotedCsvCell(buildId)},${quotedCsvCell(`'${value}`)},`
			);
			await service.stop();
		}
	);

	it('exports negative numeric-looking text as neutralized text', async () => {
		const { resultPath, root, service } = await fixture();
		await service.importXcresult(resultPath);

		const { buildId, exported } = await exportCsvWithBuildName(
			service,
			root,
			'-42.5'
		);

		expect(exported).toContain(
			`${quotedCsvCell(buildId)},${quotedCsvCell("'-42.5")},`
		);
		await service.stop();
	});

	it.each([
		'Build PUMPD',
		'1-2',
		'build+test',
		'name@host',
		' leading equals =SUM(1,1)',
		'comma, and "quote"',
	])('preserves benign CSV text: %s', async (value) => {
		const { resultPath, root, service } = await fixture();
		await service.importXcresult(resultPath);

		const { buildId, exported } = await exportCsvWithBuildName(
			service,
			root,
			value
		);

		expect(exported).toContain(
			`${quotedCsvCell(buildId)},${quotedCsvCell(value)},`
		);
		await service.stop();
	});

	it('rejects non-xcresult import directories', async () => {
		const { root, service } = await fixture();
		await expect(service.importXcresult(root)).rejects.toThrow('.xcresult');
		await service.stop();
	});

	it('keeps a watcher setup failure visible after the initial scan', async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), 'pumpd-build-watch-failure-')
		);
		temporaryRoots.push(root);
		const derivedData = path.join(root, 'DerivedData');
		await mkdir(derivedData);
		const service = new BuildInsightsService({
			store: new BuildInsightsStore(path.join(root, 'store')),
			watchFactory: () => {
				throw new Error('watch setup failed');
			},
		});
		await service.start();
		const state = await service.addWatchRoot(derivedData);
		expect(state.sources[0]).toMatchObject({
			status: 'error',
			error: 'watch setup failed',
			lastScannedAt: expect.any(Number),
		});
		await service.stop();
	});

	it('removes a failed watcher so the source can be attached again', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'pumpd-build-watch-retry-'));
		temporaryRoots.push(root);
		const derivedData = path.join(root, 'DerivedData');
		await mkdir(derivedData);
		const created: Array<EventEmitter & { close: ReturnType<typeof vi.fn> }> =
			[];
		const watchFactory = vi.fn(() => {
			const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
			created.push(watcher);
			return watcher as unknown as FSWatcher;
		});
		const service = new BuildInsightsService({
			store: new BuildInsightsStore(path.join(root, 'store')),
			watchFactory,
		});
		await service.start();
		await service.addWatchRoot(derivedData);
		created[0]?.emit('error', new Error('watch stream failed'));
		expect(service.getState().sources[0]).toMatchObject({
			status: 'error',
			error: 'watch stream failed',
		});
		expect(created[0]?.close).toHaveBeenCalledOnce();

		const retried = await service.addWatchRoot(derivedData);
		expect(watchFactory).toHaveBeenCalledTimes(2);
		expect(retried.sources[0]?.status).toBe('ready');
		await service.stop();
	});

	it('keeps a scan visibly unhealthy when discovered build results cannot be parsed', async () => {
		const { root, runXcresult, service } = await fixture();
		const derivedData = path.join(root, 'DerivedData');
		await mkdir(path.join(derivedData, 'Unreadable.xcresult'), {
			recursive: true,
		});
		runXcresult.mockRejectedValueOnce(new Error('unsupported build result'));

		const state = await service.addWatchRoot(derivedData);
		expect(
			state.sources.find((source) => source.kind === 'derived-data-root')
		).toMatchObject({
			status: 'error',
			error: expect.stringContaining('0 of 1 build results imported'),
		});
		expect(state.builds).toEqual([]);
		await service.stop();
	});

	it('rejects an entire filesystem root as a watch source', async () => {
		const { root, service } = await fixture();
		await expect(service.addWatchRoot(path.parse(root).root)).rejects.toThrow(
			'entire filesystem root'
		);
		expect(service.getState().sources).toEqual([]);
		await service.stop();
	});

	it.each<{ name: string; override: Record<string, unknown> }>([
		{
			name: 'overlong title',
			override: { actionTitle: 'x'.repeat(129) },
		},
		{
			name: 'overlong combined destination',
			override: {
				destination: {
					deviceName: 'd'.repeat(128),
					platform: 'p'.repeat(64),
					osVersion: 'o'.repeat(64),
					architecture: 'a'.repeat(64),
				},
			},
		},
		{
			name: 'unbounded diagnostics count',
			override: { warningCount: 1_000_001 },
		},
		{
			name: 'negative timestamp',
			override: { startTime: -1, endTime: 0 },
		},
	])('rejects $name without poisoning renderer state', async ({ override }) => {
		const { resultPath, runXcresult, service } = await fixture();
		runXcresult.mockResolvedValueOnce({
			actionTitle: 'Build PUMPD',
			destination: {
				deviceName: 'iPhone 17 Pro',
				platform: 'iOS Simulator',
				osVersion: '20.0',
			},
			startTime: '2026-08-30T17:59:42.000Z',
			endTime: '2026-08-30T18:00:00.000Z',
			status: 'succeeded',
			warningCount: 3,
			errorCount: 0,
			analyzerWarningCount: 1,
			...override,
		});

		await expect(service.importXcresult(resultPath)).rejects.toThrow();
		expect(() => service.getState()).not.toThrow();
		expect(service.getState()).toMatchObject({
			builds: [],
			sources: [{ status: 'error' }],
		});
		await service.stop();
	});
});

import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
