import {
	createEmptyDesktopToolsSnapshot,
	type DesktopDeviceToolsSnapshot,
	RNDEVTOOLS_SNAPSHOT_EXTRA_LIMITS as EXTRA,
	fitDesktopSnapshot,
	RNDEVTOOLS_SNAPSHOT_LIMITS as LIMITS,
	RNDEVTOOLS_SNAPSHOT_NUMBER_LIMITS as NUMBERS,
	RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS as TEXT,
} from './desktop-protocol';

type Json = Record<string | number, unknown>;

/** The empty snapshot with some of its fields replaced by, usually partial, rows. */
function snapshot(fields: Record<string, unknown>): DesktopDeviceToolsSnapshot {
	return { ...createEmptyDesktopToolsSnapshot(), ...fields };
}

/** Frozen, so any write to what the fit was given throws. */
function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

/** `[]` stands for the first row of a list, as in what the fit reports. */
function segments(path: string): (string | number)[] {
	return path
		.split('.')
		.flatMap((part) => (part.endsWith('[]') ? [part.slice(0, -2), 0] : [part]));
}

function read(root: unknown, path: string): unknown {
	let value = root;
	for (const key of segments(path)) value = (value as Json)[key];
	return value;
}

function fit(tools: Record<string, unknown>) {
	return fitDesktopSnapshot(deepFreeze(snapshot(tools)));
}

const ids = (count: number, prefix = 'row'): { id: string }[] =>
	Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` }));

describe('fitDesktopSnapshot', () => {
	describe('a snapshot that fits', () => {
		it('comes back as it is, with nothing trimmed', () => {
			const empty = deepFreeze(createEmptyDesktopToolsSnapshot());
			expect(fitDesktopSnapshot(empty)).toEqual({ tools: empty, trimmed: [] });
			expect(fitDesktopSnapshot(empty).tools).toBe(empty);

			const populated = deepFreeze(
				snapshot({
					network: [
						{
							id: 'request-1',
							at: 1_700_000_000_000,
							method: 'GET',
							url: 'https://example.com/items',
							host: 'example.com',
							path: '/items',
							status: 200,
							state: 'success',
							requestHeaders: { accept: 'application/json' },
						},
					],
					components: [{ id: 'component-1', sourceFiles: ['App.tsx'] }],
				}),
			);
			const fitted = fitDesktopSnapshot(populated);
			expect(fitted.tools).toBe(populated);
			expect(fitted.trimmed).toEqual([]);
		});

		it('is at its limits when every list, text and number is at the most it may be', () => {
			const url = 'u'.repeat(TEXT.long);
			const tools = deepFreeze(
				snapshot({
					network: ids(LIMITS.network).map((row) => ({
						...row,
						url,
						status: NUMBERS.httpStatus,
					})),
					components: [
						{
							id: 'i'.repeat(TEXT.identifier),
							sourceFiles: Array.from(
								{ length: LIMITS.componentSourceFiles },
								() => 's',
							),
							depth: NUMBERS.componentDepth,
						},
					],
				}),
			);
			const fitted = fitDesktopSnapshot(tools);
			expect(fitted.tools).toBe(tools);
			expect(fitted.trimmed).toEqual([]);
		});

		it('fits again as it is once fitted', () => {
			const hostile = fit({
				network: ids(LIMITS.network + 5),
				components: [
					{
						id: 'component-1',
						name: 'n'.repeat(TEXT.short + 1),
						depth: -5,
						sourceFiles: ids(30).map((row) => row.id),
					},
				],
			});
			expect(hostile.trimmed).not.toEqual([]);
			const again = fitDesktopSnapshot(hostile.tools);
			expect(again.tools).toBe(hostile.tools);
			expect(again.trimmed).toEqual([]);
		});
	});

	describe('lists at the top level', () => {
		const names = [
			'network',
			'console',
			'storage',
			'storageEvents',
			'queries',
			'mutations',
			'routes',
			'routeEvents',
			'environment',
			'zustandStores',
			'zustandChanges',
			'zustandStateSnapshots',
			'zustandMutationReceipts',
			'restorePoints',
			'restoreReceipts',
			'scenarios',
			'scenarioReceipts',
			'components',
			'componentRenders',
			'diagnostics',
		] as const;

		it.each(names)('keep the newest rows of %s', (name) => {
			const limit = LIMITS[name];
			const rows = ids(limit + 3);
			const fitted = fit({ [name]: rows });

			const kept = read(fitted.tools, name) as { id: string }[];
			expect(kept).toHaveLength(limit);
			expect(kept[0]).toBe(rows[3]);
			expect(kept.at(-1)).toBe(rows.at(-1));
			expect(fitted.trimmed).toEqual([`${name} to ${limit} rows`]);
		});

		it('leave a list at its limit alone', () => {
			const rows = deepFreeze(ids(LIMITS.network));
			const tools = snapshot({ network: rows });
			expect(fitDesktopSnapshot(tools).tools.network).toBe(rows);
		});
	});

	describe('lists inside a row', () => {
		type NestedList = Readonly<{
			path: string;
			limit: number;
			keeps: 'first' | 'newest';
			/** Whether its rows are texts rather than objects. */
			texts: boolean;
		}>;

		const objects = (
			path: string,
			limit: number,
			keeps: 'first' | 'newest' = 'first',
		): NestedList => ({ path, limit, keeps, texts: false });
		const strings = (path: string, limit: number): NestedList => ({
			path,
			limit,
			keeps: 'first',
			texts: true,
		});

		const nested: readonly NestedList[] = [
			objects('storageEvents[].structuralDiff', EXTRA.storageStructuralDiff),
			objects('storageSummary.errors', EXTRA.storageSummaryErrors),
			objects('querySimulation.families', EXTRA.querySimulationFamilies),
			objects('querySimulation.families[].modes', EXTRA.querySimulationModes),
			strings('zustandStores[].keys', LIMITS.storageKeys),
			strings('zustandChanges[].changedKeys', LIMITS.zustandChangedKeys),
			strings(
				'zustandMutationReceipts[].changedKeys',
				LIMITS.zustandChangedKeys,
			),
			objects('restorePoints[].sources', LIMITS.restoreSources),
			objects('restoreReceipts[].sourceResults', LIMITS.restoreSources),
			objects('scenarios[].variables', LIMITS.scenarioVariables),
			strings('scenarios[].variables[].options', EXTRA.scenarioVariableOptions),
			objects('scenarios[].steps', LIMITS.scenarioSteps),
			strings('scenarioRuntime.active.warnings', EXTRA.scenarioWarnings),
			objects('scenarioReceipts[].stepResults', LIMITS.scenarioSteps),
			strings(
				'scenarioReceipts[].stepResults[].warnings',
				EXTRA.scenarioWarnings,
			),
			objects('identitySession.history', LIMITS.identityHistory, 'newest'),
			objects('identitySession.personas', LIMITS.identityPersonas),
			objects('performance.samples', LIMITS.performanceSamples, 'newest'),
			strings('components[].sourceFiles', LIMITS.componentSourceFiles),
			strings('components[].actions', EXTRA.componentActions),
			strings(
				'componentRenders[].changedKeys',
				EXTRA.componentRenderChangedKeys,
			),
			objects(
				'componentSummary.registrationDiagnostics',
				LIMITS.componentDiagnostics,
			),
			strings(
				'componentSummary.registrationDiagnostics[].instanceIds',
				LIMITS.components,
			),
		];

		/** The containers a list sits in, with the list itself left for the test to fill. */
		function containers(): Json {
			return {
				storageEvents: [{}],
				storageSummary: {},
				querySimulation: { families: [{}] },
				zustandStores: [{}],
				zustandChanges: [{}],
				zustandMutationReceipts: [{}],
				restorePoints: [{}],
				restoreReceipts: [{}],
				scenarios: [{ variables: [{}] }],
				scenarioRuntime: { active: {} },
				scenarioReceipts: [{ stepResults: [{}] }],
				identitySession: {},
				performance: {},
				components: [{}],
				componentRenders: [{}],
				componentSummary: { registrationDiagnostics: [{}] },
			};
		}

		function place(root: Json, path: string, rows: unknown[]): void {
			const keys = segments(path);
			const last = keys.pop() as string | number;
			let parent = root;
			for (const key of keys) parent = parent[key] as Json;
			parent[last] = rows;
		}

		it.each(nested)(
			'keep the $keeps rows of $path',
			({ path, limit, keeps, texts }) => {
				const rows: unknown[] = texts
					? Array.from({ length: limit + 2 }, (_, index) => `row-${index}`)
					: ids(limit + 2);
				const fields = containers();
				place(fields, path, rows);
				const fitted = fit(fields);

				const kept = read(fitted.tools, path) as unknown[];
				expect(kept).toHaveLength(limit);
				expect(kept[0]).toBe(keeps === 'newest' ? rows[2] : rows[0]);
				expect(kept.at(-1)).toBe(
					keeps === 'newest' ? rows.at(-1) : rows[limit - 1],
				);
				expect(fitted.trimmed).toEqual([`${path} to ${limit} rows`]);
			},
		);

		it.each(nested)(
			'leave $path at its limit alone',
			({ path, limit, texts }) => {
				const rows: unknown[] = texts
					? Array.from({ length: limit }, (_, index) => `row-${index}`)
					: ids(limit);
				const fields = containers();
				place(fields, path, rows);
				const tools = deepFreeze(snapshot(fields));
				const fitted = fitDesktopSnapshot(tools);
				expect(fitted.tools).toBe(tools);
				expect(fitted.trimmed).toEqual([]);
			},
		);

		it('are cut in every row of a list, not just the first', () => {
			const fitted = fit({
				components: Array.from({ length: 3 }, (_, index) => ({
					id: `component-${index}`,
					sourceFiles: Array.from(
						{ length: LIMITS.componentSourceFiles + 1 },
						(_, file) => `file-${file}`,
					),
				})),
			});
			const components = fitted.tools.components as unknown as {
				sourceFiles: string[];
			}[];
			expect(components.map((row) => row.sourceFiles.length)).toEqual([
				LIMITS.componentSourceFiles,
				LIMITS.componentSourceFiles,
				LIMITS.componentSourceFiles,
			]);
			expect(fitted.trimmed).toEqual([
				`components[].sourceFiles to ${LIMITS.componentSourceFiles} rows`,
			]);
		});
	});

	describe('the performance samples and scenario warnings of one device', () => {
		it('are cut to what the desktop takes, however many core kept', () => {
			// Core keeps up to 10,000 samples, the desktop takes 1,500, and a
			// scenario collects the warnings of each of its steps.
			const samples = Array.from({ length: 10_000 }, (_, index) => ({
				id: `sample-${index}`,
				at: 1_700_000_000_000 + index * 1_000,
				jsFps: 60,
				eventLoopLagMs: 1,
				longFrames: 0,
				maxFrameMs: 16,
			}));
			const warnings = Array.from(
				{ length: 1_000 },
				(_, index) => `Warning ${index}`,
			);
			const fitted = fit({
				performance: {
					...createEmptyDesktopToolsSnapshot().performance,
					samples,
				},
				scenarioRuntime: {
					running: true,
					active: {
						receiptId: 'receipt-1',
						scenarioId: 'scenario-1',
						scenarioVersion: 1,
						scenarioName: 'Scenario',
						activatedAt: 1,
						stepCount: 10,
						privileged: false,
						warnings,
						recoveryRequired: false,
					},
				},
			});

			const kept = fitted.tools.performance.samples;
			expect(kept).toHaveLength(1_500);
			expect(kept[0]).toBe(samples[8_500]);
			expect(kept.at(-1)).toBe(samples[9_999]);
			expect(fitted.tools.scenarioRuntime.active?.warnings).toEqual(
				warnings.slice(0, 100),
			);
			// The performance panel only says samples were dropped when this is
			// above zero.
			expect(fitted.tools.performance.droppedSampleCount).toBe(8_500);
			expect(fitted.trimmed).toEqual([
				'scenarioRuntime.active.warnings to 100 rows',
				'performance.samples to 1500 rows',
				'performance.droppedSampleCount raised for the samples cut',
			]);
		});

		it('add the samples it cut to the dropped count the host reported', () => {
			const samples = Array.from({ length: 1_600 }, (_, index) => ({
				id: `sample-${index}`,
				at: 1_700_000_000_000 + index,
				jsFps: 60,
				eventLoopLagMs: 1,
				longFrames: 0,
				maxFrameMs: 16,
			}));
			const performance = (droppedSampleCount: number) => ({
				...createEmptyDesktopToolsSnapshot().performance,
				droppedSampleCount,
				samples,
			});

			expect(
				fit({ performance: performance(3) }).tools.performance
					.droppedSampleCount,
			).toBe(103);
			// The client reports a trim only once while it stays the same, so the
			// description must not carry a number that grows with every snapshot.
			expect(fit({ performance: performance(0) }).trimmed).toEqual(
				fit({
					performance: {
						...performance(0),
						samples: [...samples, ...samples.slice(0, 100)],
					},
				}).trimmed,
			);
			// The schema takes a safe integer at most.
			expect(
				fit({ performance: performance(Number.MAX_SAFE_INTEGER) }).tools
					.performance.droppedSampleCount,
			).toBe(Number.MAX_SAFE_INTEGER);
		});

		it('leave the dropped count alone when no sample is cut', () => {
			const tools = deepFreeze(
				snapshot({
					performance: {
						...createEmptyDesktopToolsSnapshot().performance,
						droppedSampleCount: 4,
					},
				}),
			);
			expect(fitDesktopSnapshot(tools).tools).toBe(tools);
		});
	});

	describe('the identity history', () => {
		const session = (index: number) => ({
			id: `session-${index}`,
			startedAt: 1_700_000_000_000 + index * 1_000,
			actor: { kind: 'account' as const, label: 'Alex' },
			target: { kind: 'account' as const, label: 'Sam' },
			status: 'stopped' as const,
		});
		const sessions = (count: number) =>
			Array.from({ length: count }, (_, index) => session(index));
		const fitHistory = (history: unknown[]) =>
			fit({
				identitySession: { running: false, history, personas: [] },
			} as Partial<DesktopDeviceToolsSnapshot>);
		const idsOf = (fitted: ReturnType<typeof fit>) =>
			fitted.tools.identitySession.history.map((row) => row.id);

		it('keeps the sessions that started latest when the host lists the newest first', () => {
			// As the reference device does: a new session goes at the front.
			const rows = sessions(25).reverse();
			const fitted = fitHistory(rows);

			expect(idsOf(fitted)).toEqual(rows.slice(0, 20).map((row) => row.id));
			expect(fitted.trimmed).toEqual([
				`identitySession.history to ${LIMITS.identityHistory} rows`,
			]);
		});

		it('keeps them too when the host lists the oldest first', () => {
			const rows = sessions(25);
			expect(idsOf(fitHistory(rows))).toEqual(
				rows.slice(5).map((row) => row.id),
			);
		});

		it('ranks a session without a start time last', () => {
			const rows: unknown[] = [{ id: 'unstarted' }, ...sessions(20)];
			expect(idsOf(fitHistory(rows))).not.toContain('unstarted');
		});
	});

	describe('texts', () => {
		const IDENTIFIER = TEXT.identifier;

		it.each([
			['network[].host', TEXT.short, { network: [{ host: '' }] }],
			['network[].url', TEXT.long, { network: [{ url: '' }] }],
			['network[].id', IDENTIFIER, { network: [{ id: '' }] }],
			['network[].method', TEXT.httpMethod, { network: [{ method: '' }] }],
			[
				'scenarios[].description',
				TEXT.scenario,
				{ scenarios: [{ description: '' }] },
			],
		])('are cut to their limit: %s', (path, limit, fields) => {
			const over = structuredClone(fields) as Json;
			(read(over, path.replace(/\.[^.]*$/, '')) as Json)[
				path.slice(path.lastIndexOf('.') + 1)
			] = 'x'.repeat(limit + 1);
			const fitted = fit(over);
			expect(read(fitted.tools, path)).toBe('x'.repeat(limit));
			expect(fitted.trimmed).toEqual([`${path} to ${limit} characters`]);

			const at = structuredClone(fields) as Json;
			(read(at, path.replace(/\.[^.]*$/, '')) as Json)[
				path.slice(path.lastIndexOf('.') + 1)
			] = 'x'.repeat(limit);
			expect(fit(at).trimmed).toEqual([]);
		});

		const text = (value: unknown) => ({ diagnostics: [{ scope: value }] });
		const scopeOf = (tools: Record<string, unknown>) =>
			read(fit(tools).tools, 'diagnostics[].scope');

		it('never leave half of a surrogate pair at the cut', () => {
			const limit = TEXT.short;
			// The pair straddles the limit, so it goes whole.
			expect(scopeOf(text(`${'a'.repeat(limit - 1)}😀b`))).toBe(
				'a'.repeat(limit - 1),
			);
			// The pair ends at the limit, so it stays.
			expect(scopeOf(text(`${'a'.repeat(limit - 2)}😀b`))).toBe(
				`${'a'.repeat(limit - 2)}😀`,
			);
			// A lone high surrogate at the limit goes too.
			expect(scopeOf(text(`${'a'.repeat(limit - 1)}\ud83dz`))).toBe(
				'a'.repeat(limit - 1),
			);
			// Pairs the cut does not touch stay whole.
			expect(scopeOf(text('😀'.repeat(limit)))).toBe('😀'.repeat(limit / 2));
		});

		it('count an identifier or a method after trimming it, as the schema does', () => {
			const idOf = (id: string) =>
				read(fit({ network: [{ id }] }).tools, 'network[].id');

			// Longer than the limit before trimming, within it after: left alone.
			const padded = `  ${'x'.repeat(IDENTIFIER)}\n`;
			expect(idOf(padded)).toBe(padded);
			// Over it after trimming: trimmed, then cut.
			expect(idOf(`  ${'x'.repeat(IDENTIFIER + 1)}\n`)).toBe(
				'x'.repeat(IDENTIFIER),
			);
			expect(
				read(
					fit({ network: [{ method: `${' '.repeat(40)}GET` }] }).tools,
					'network[].method',
				),
			).toBe(`${' '.repeat(40)}GET`);
		});

		it('leave what is not a text for the schema to judge', () => {
			expect(scopeOf(text(42))).toBe(42);
			expect(scopeOf(text(null))).toBeNull();
			expect(scopeOf(text(undefined))).toBeUndefined();
			const object = { length: 1_000_000 };
			expect(scopeOf(text(object))).toBe(object);
		});
	});

	describe('numbers', () => {
		const NOW = 1_700_000_000_000;
		/** A field of one console row, which carries both required and optional numbers. */
		const consoleField = (name: string, value: unknown) =>
			read(
				fit({ console: [{ id: 'log-1', [name]: value }] }).tools,
				`console[].${name}`,
			);

		it('clamp a timestamp into 0..8.64e15 without changing its fraction', () => {
			expect(consoleField('at', NOW + 0.5)).toBe(NOW + 0.5);
			expect(consoleField('at', -1)).toBe(0);
			expect(consoleField('at', NUMBERS.timestamp + 1)).toBe(NUMBERS.timestamp);
			expect(consoleField('at', Number.MAX_VALUE)).toBe(NUMBERS.timestamp);
		});

		it('cut the fraction off an integer, then clamp it', () => {
			const fitted = (value: number) =>
				read(
					fit({ network: [{ id: 'request-1', requestBytes: value }] }).tools,
					'network[].requestBytes',
				);
			expect(fitted(1.9)).toBe(1);
			expect(fitted(-0.5)).toBe(0);
			expect(fitted(-3)).toBe(0);
			expect(fitted(2 ** 60)).toBe(Number.MAX_SAFE_INTEGER);
			expect(fitted(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
			expect(Object.is(fitted(-0), -0)).toBe(true);
		});

		it('lift a positive integer to 1', () => {
			expect(consoleField('repeatCount', 0)).toBe(1);
			expect(consoleField('repeatCount', 0.9)).toBe(1);
			expect(consoleField('repeatCount', 7.5)).toBe(7);
		});

		it('keep a range of its own', () => {
			const fitted = (field: string, value: number) =>
				read(
					fit({
						performance: {
							samples: [{ id: 'sample-1', [field]: value }],
						},
					}).tools,
					`performance.samples[].${field}`,
				);
			expect(fitted('jsFps', 241)).toBe(NUMBERS.fps);
			expect(fitted('jsFps', -1)).toBe(0);
			expect(fitted('jsFps', 59.97)).toBe(59.97);
			expect(fitted('cpuPercent', 100.5)).toBe(NUMBERS.cpuPercent);
			expect(fitted('eventLoopLagMs', -0.1)).toBe(0);
			expect(fitted('eventLoopLagMs', 1e300)).toBe(1e300);

			const component = (field: string, value: number) =>
				read(
					fit({ components: [{ id: 'component-1', [field]: value }] }).tools,
					`components[].${field}`,
				);
			expect(component('zIndex', -200_000)).toBe(-NUMBERS.componentZIndex);
			expect(component('zIndex', 0.25)).toBe(0.25);
			expect(component('depth', 101)).toBe(NUMBERS.componentDepth);
			expect(component('depth', 2.9)).toBe(2);
		});

		it('make a required number that is not finite its lower bound', () => {
			for (const value of [
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.NEGATIVE_INFINITY,
			]) {
				expect(consoleField('at', value)).toBe(0);
				const fitted = fit({
					componentRenders: [{ id: 'render-1', renderCount: value }],
				});
				expect(read(fitted.tools, 'componentRenders[].renderCount')).toBe(1);
			}
		});

		it('make one that has no lower bound 0', () => {
			const bounds = (x: number) =>
				read(
					fit({
						components: [
							{ id: 'component-1', bounds: { x, y: x, width: 1, height: 1 } },
						],
					}).tools,
					'components[].bounds',
				);
			expect(bounds(Number.NaN)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
			expect(bounds(Number.NEGATIVE_INFINITY)).toEqual({
				x: 0,
				y: 0,
				width: 1,
				height: 1,
			});
			expect(bounds(-1e300)).toEqual({
				x: -1e300,
				y: -1e300,
				width: 1,
				height: 1,
			});
		});

		it('drop an optional number that is not finite', () => {
			for (const value of [
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.NEGATIVE_INFINITY,
			]) {
				const fitted = fit({ console: [{ id: 'log-1', repeatCount: value }] });
				const [row] = fitted.tools.console;
				expect(row).toEqual({ id: 'log-1' });
				expect(row).not.toHaveProperty('repeatCount');
				expect(fitted.trimmed).toEqual([
					'console[].repeatCount dropped (not a finite number)',
				]);
			}
		});

		it('write a nullable number that is not finite as null, as JSON does', () => {
			const started = (value: number | null) =>
				read(
					fit({
						performance: {
							...createEmptyDesktopToolsSnapshot().performance,
							startedAt: value,
						},
					}).tools,
					'performance.startedAt',
				);
			expect(started(null)).toBeNull();
			expect(started(NOW)).toBe(NOW);
			expect(started(Number.NaN)).toBeNull();
			expect(started(Number.POSITIVE_INFINITY)).toBeNull();
			expect(started(-5)).toBe(0);
		});

		it('leave what is not a number for the schema to judge', () => {
			expect(consoleField('at', '1')).toBe('1');
			expect(consoleField('at', null)).toBeNull();
			expect(consoleField('repeatCount', undefined)).toBeUndefined();
		});

		it('report each range once, however many rows were out of it', () => {
			const fitted = fit({
				console: Array.from({ length: 200 }, (_, index) => ({
					id: `log-${index}`,
					at: -index - 1,
				})),
			});
			expect(fitted.trimmed).toEqual(['console[].at to 0..8640000000000000']);
		});
	});

	describe('maps', () => {
		const withHeaders = (requestHeaders: unknown) =>
			fit({ network: [{ id: 'request-1', requestHeaders }] });
		const headersOf = (fitted: ReturnType<typeof fit>) =>
			read(fitted.tools, 'network[].requestHeaders') as Record<string, string>;

		const fields = (count: number) =>
			Object.fromEntries(
				Array.from({ length: count }, (_, index) => [`h${index}`, 'v']),
			);

		it('keep their first fields when there are too many', () => {
			const fitted = withHeaders(fields(EXTRA.headerFields + 5));
			expect(Object.keys(headersOf(fitted))).toEqual(
				Object.keys(fields(EXTRA.headerFields)),
			);
			expect(fitted.trimmed).toEqual([
				`network[].requestHeaders to ${EXTRA.headerFields} fields`,
			]);
		});

		it('drop a field whose name is too long instead of cutting it', () => {
			const fitted = withHeaders({
				first: 'a',
				[`${'n'.repeat(TEXT.headerName)}1`]: 'b',
				[`${'n'.repeat(TEXT.headerName)}2`]: 'c',
				last: 'd',
			});
			expect(headersOf(fitted)).toEqual({ first: 'a', last: 'd' });
			expect(fitted.trimmed).toEqual([
				`network[].requestHeaders names over ${TEXT.headerName} characters dropped`,
			]);
		});

		it('keep a name of exactly the longest length', () => {
			const name = 'n'.repeat(TEXT.headerName);
			const headers = deepFreeze({ [name]: 'v' });
			expect(headersOf(withHeaders(headers))).toBe(headers);
		});

		it('cut the value of a field', () => {
			const fitted = withHeaders({
				first: 'x'.repeat(TEXT.long + 1),
				second: 'y',
			});
			expect(headersOf(fitted)).toEqual({
				first: 'x'.repeat(TEXT.long),
				second: 'y',
			});
			expect(fitted.trimmed).toEqual([
				`network[].requestHeaders[] to ${TEXT.long} characters`,
			]);
		});

		it('are the same object when nothing in them changed', () => {
			const headers = deepFreeze({ accept: 'application/json' });
			expect(headersOf(withHeaders(headers))).toBe(headers);
		});

		it('keep a field named __proto__ as data', () => {
			const headers = JSON.parse(
				`{"__proto__":"${'v'.repeat(TEXT.long + 1)}","kept":"k"}`,
			) as Record<string, string>;
			const fitted = headersOf(withHeaders(headers));
			expect(Object.getPrototypeOf(fitted)).toBeNull();
			expect(Object.keys(fitted)).toEqual(['__proto__', 'kept']);
			expect(JSON.parse(JSON.stringify(fitted))).toEqual({
				['__proto__']: 'v'.repeat(TEXT.long),
				kept: 'k',
			});
		});

		it('cut the accessibility state of a component by its own bounds', () => {
			const state = {
				...Object.fromEntries(
					Array.from(
						{ length: EXTRA.accessibilityStateFields + 1 },
						(_, index) => [`state-${index}`, index % 2 === 0],
					),
				),
			};
			state['n'.repeat(TEXT.short + 1)] = true;
			const fitted = fit({
				components: [
					{
						id: 'component-1',
						accessibilityState: { ...state, label: 'x'.repeat(TEXT.short + 1) },
					},
				],
			});
			const kept = read(
				fitted.tools,
				'components[].accessibilityState',
			) as Json;
			expect(Object.keys(kept)).toHaveLength(EXTRA.accessibilityStateFields);
			expect(kept['state-0']).toBe(true);
			expect(kept['state-1']).toBe(false);
			expect(fitted.trimmed).toEqual(
				expect.arrayContaining([
					`components[].accessibilityState to ${EXTRA.accessibilityStateFields} fields`,
					`components[].accessibilityState names over ${TEXT.short} characters dropped`,
				]),
			);
		});

		it('leave what is not a map for the schema to judge', () => {
			expect(headersOf(withHeaders('accept: */*'))).toBe('accept: */*');
			expect(headersOf(withHeaders(null))).toBeNull();
		});
	});

	describe('what a bound can break', () => {
		const family = (id: string, supported: boolean) => ({
			id,
			label: id.toUpperCase(),
			modes: [
				{ mode: 'loading', supported },
				{ mode: 'error', supported: false, reason: 'Never' },
				{ mode: 'paused', supported: false, reason: 'Never' },
				{ mode: 'offline', supported: false, reason: 'Never' },
			],
		});
		const active = (familyId: string, familyLabel: string, mode: string) => ({
			familyId,
			familyLabel,
			mode,
			receiptId: 'receipt',
			startedAt: 1,
		});
		const simulation = (families: unknown[], entry?: unknown) =>
			fit({
				querySimulation: { families, ...(entry ? { active: entry } : {}) },
			});

		it('keeps the active query simulation that names a supported mode of a listed family', () => {
			const tools = deepFreeze(
				snapshot({
					querySimulation: {
						families: [family('a', true), family('b', true)],
						active: active(' b ', 'B', 'loading'),
					},
				}),
			);
			const fitted = fitDesktopSnapshot(tools);
			expect(fitted.tools).toBe(tools);
			expect(fitted.trimmed).toEqual([]);
		});

		it.each([
			['a family that is not listed', active('c', 'C', 'loading')],
			['a different label', active('a', 'Other', 'loading')],
			['a mode the family does not support', active('a', 'A', 'error')],
			['a mode the family does not offer', active('a', 'A', 'nowhere')],
		])('drops the active query simulation that names %s', (_case, entry) => {
			const fitted = simulation([family('a', true)], entry);
			expect(fitted.tools.querySimulation).toEqual({
				families: [family('a', true)],
			});
			expect(fitted.trimmed).toEqual([
				'querySimulation.active dropped (it names no supported family mode)',
			]);
		});

		it('drops the active query simulation whose family the cap cut away', () => {
			const families = Array.from(
				{ length: EXTRA.querySimulationFamilies + 1 },
				(_, index) => family(`family-${index}`, true),
			);
			const last = families.at(-1);
			const fitted = simulation(
				families,
				active(last?.id ?? '', last?.label ?? '', 'loading'),
			);
			expect(fitted.tools.querySimulation?.families).toHaveLength(
				EXTRA.querySimulationFamilies,
			);
			expect(fitted.tools.querySimulation?.active).toBeUndefined();
			expect(fitted.trimmed).toEqual([
				`querySimulation.families to ${EXTRA.querySimulationFamilies} rows`,
				'querySimulation.active dropped (it names no supported family mode)',
			]);
		});

		it('keeps the active entry whose family and own text are cut alike', () => {
			// Both go through the same cut, so they still name one another.
			const id = 'i'.repeat(TEXT.identifier + 10);
			const label = 'l'.repeat(TEXT.short + 10);
			const fitted = simulation(
				[{ id, label, modes: family('a', true).modes }],
				active(id, label, 'loading'),
			);
			expect(fitted.tools.querySimulation?.active?.familyId).toBe(
				'i'.repeat(TEXT.identifier),
			);
			expect(fitted.tools.querySimulation?.active?.familyLabel).toBe(
				'l'.repeat(TEXT.short),
			);
			expect(fitted.tools.querySimulation?.families[0]?.label).toBe(
				'l'.repeat(TEXT.short),
			);
		});

		describe('a camera fixture', () => {
			const fixtureOf = (fixture: unknown) => fit({ cameraFixture: fixture });

			it.each([
				['inactive', { active: false }],
				[
					'a still',
					{
						active: true,
						kind: 'still',
						mimeType: 'image/png',
						bytes: 5,
						width: 2,
						height: 2,
					},
				],
				[
					'a QR code',
					{
						active: true,
						kind: 'qr',
						mimeType: 'image/jpeg',
						bytes: 5,
						width: 2,
						height: 2,
						label: 'QR',
					},
				],
				[
					'a video',
					{
						active: true,
						kind: 'video',
						mimeType: 'video/mp4',
						bytes: 5,
						width: 2,
						height: 2,
						durationMs: 1_000,
					},
				],
				[
					'unavailable',
					{ active: true, kind: 'unavailable', label: 'No camera' },
				],
				['failed', { active: true, kind: 'error', label: 'Broken' }],
			])('is left alone when it is %s', (_case, fixture) => {
				const tools = deepFreeze(snapshot({ cameraFixture: fixture }));
				const fitted = fitDesktopSnapshot(tools);
				expect(fitted.tools).toBe(tools);
				expect(fitted.trimmed).toEqual([]);
			});

			it.each([
				['an active one with no kind', { active: true }],
				['an inactive one with a kind', { active: false, kind: 'still' }],
				[
					'a still with a video type',
					{
						active: true,
						kind: 'still',
						mimeType: 'video/mp4',
						bytes: 5,
						width: 2,
						height: 2,
					},
				],
				[
					'a still with a duration',
					{
						active: true,
						kind: 'still',
						mimeType: 'image/png',
						bytes: 5,
						width: 2,
						height: 2,
						durationMs: 5,
					},
				],
				[
					'a video with no duration',
					{
						active: true,
						kind: 'video',
						mimeType: 'video/mp4',
						bytes: 5,
						width: 2,
						height: 2,
					},
				],
				[
					'a still with no bytes',
					{
						active: true,
						kind: 'still',
						mimeType: 'image/png',
						bytes: 0,
						width: 2,
						height: 2,
					},
				],
				[
					'an unavailable one with a size',
					{ active: true, kind: 'unavailable', width: 2 },
				],
			])('is reset when it is %s', (_case, fixture) => {
				const fitted = fixtureOf(fixture);
				expect(fitted.tools.cameraFixture).toEqual({ active: false });
				expect(fitted.trimmed).toEqual([
					'cameraFixture reset (its metadata is inconsistent)',
				]);
			});

			it('is reset when the fit has to drop a number it needs', () => {
				const video = {
					active: true,
					kind: 'video',
					mimeType: 'video/mp4',
					bytes: 5,
					width: 2,
					height: 2,
					durationMs: 1_000,
				};
				for (const field of ['bytes', 'width', 'height', 'durationMs']) {
					const fitted = fixtureOf({ ...video, [field]: Number.NaN });
					expect(fitted.tools.cameraFixture).toEqual({ active: false });
					expect(fitted.trimmed).toContain(
						'cameraFixture reset (its metadata is inconsistent)',
					);
				}
			});

			it('keeps its numbers within their own ranges', () => {
				const fitted = fixtureOf({
					active: true,
					kind: 'video',
					mimeType: 'video/mp4',
					bytes: NUMBERS.cameraFixtureBytes + 1,
					width: NUMBERS.cameraFixtureDimension + 1,
					height: 0,
					durationMs: NUMBERS.cameraFixtureDurationMs + 0.5,
				});
				expect(fitted.tools.cameraFixture).toEqual({
					active: true,
					kind: 'video',
					mimeType: 'video/mp4',
					bytes: NUMBERS.cameraFixtureBytes,
					width: NUMBERS.cameraFixtureDimension,
					height: 1,
					durationMs: NUMBERS.cameraFixtureDurationMs,
				});
			});
		});

		describe('a scenario variable default', () => {
			const variable = (fields: Record<string, unknown>) => ({
				id: 'plan',
				label: 'Plan',
				required: false,
				...fields,
			});
			const variableOf = (fields: Record<string, unknown>) =>
				read(
					fit({
						scenarios: [{ id: 'scenario-1', variables: [variable(fields)] }],
					}).tools,
					'scenarios[].variables[]',
				) as Json;

			it.each([
				['string', 'pro'],
				['number', 3],
				['boolean', false],
			])('stays when it is a %s of that type', (type, defaultValue) => {
				const tools = deepFreeze(
					snapshot({
						scenarios: [
							{
								id: 'scenario-1',
								variables: [variable({ type, defaultValue })],
							},
						],
					}),
				);
				expect(fitDesktopSnapshot(tools).tools).toBe(tools);
			});

			it.each([
				['string', 3],
				['number', 'three'],
				['boolean', null],
				['string', null],
				['number', Number.NaN],
				['number', Number.POSITIVE_INFINITY],
			])('goes when a %s defaults to %p', (type, defaultValue) => {
				const fitted = variableOf({ type, defaultValue });
				expect(fitted).not.toHaveProperty('defaultValue');
				expect(fitted).toEqual({
					id: 'plan',
					label: 'Plan',
					required: false,
					type,
				});
			});

			it('is cut to the scenario text limit, and stays a string', () => {
				const fitted = variableOf({
					type: 'string',
					defaultValue: 'd'.repeat(TEXT.scenario + 1),
					options: ['o'.repeat(TEXT.scenario + 1), 'short', 4, null, false],
				});
				expect(fitted.defaultValue).toBe('d'.repeat(TEXT.scenario));
				expect(fitted.options).toEqual([
					'o'.repeat(TEXT.scenario),
					'short',
					4,
					null,
					false,
				]);
			});

			it('writes an option or a default that is not finite as null', () => {
				const fitted = variableOf({
					type: 'number',
					options: [1, Number.NaN, Number.NEGATIVE_INFINITY],
				});
				expect(fitted.options).toEqual([1, null, null]);
			});
		});

		describe('an identity', () => {
			const actorOf = (actor: unknown) =>
				fit({
					identitySession: {
						running: true,
						active: { historyId: 'history-1', actor },
						history: [],
						personas: [],
					},
				});

			it('keeps a persona identifier on a persona', () => {
				const actor = {
					kind: 'persona',
					label: 'Alex',
					personaId: 'persona-1',
				};
				const fitted = actorOf(actor);
				expect(read(fitted.tools, 'identitySession.active.actor')).toEqual(
					actor,
				);
				expect(fitted.trimmed).toEqual([]);
			});

			it.each(['signed-out', 'account'])(
				'drops a persona identifier from an identity that is %s',
				(kind) => {
					const fitted = actorOf({
						kind,
						label: 'Alex',
						personaId: 'persona-1',
					});
					expect(read(fitted.tools, 'identitySession.active.actor')).toEqual({
						kind,
						label: 'Alex',
					});
					expect(fitted.trimmed).toEqual([
						'identitySession.active.actor.personaId dropped (only a persona has one)',
					]);
				},
			);

			it('leaves a persona with no identifier to the schema', () => {
				const actor = deepFreeze({ kind: 'persona', label: 'Alex' });
				const tools = snapshot({
					identitySession: {
						running: true,
						active: { historyId: 'history-1', actor },
						history: [],
						personas: [],
					},
				});
				expect(fitDesktopSnapshot(tools).tools).toBe(tools);
			});

			it('checks the target and each row of the history as well', () => {
				const stray = {
					kind: 'account',
					label: 'Alex',
					personaId: 'persona-1',
				};
				const fitted = fit({
					identitySession: {
						running: false,
						active: { historyId: 'history-1', actor: stray, target: stray },
						history: [{ id: 'history-1', actor: stray, target: stray }],
						personas: [],
					},
				});
				const clean = { kind: 'account', label: 'Alex' };
				expect(read(fitted.tools, 'identitySession.active.actor')).toEqual(
					clean,
				);
				expect(read(fitted.tools, 'identitySession.active.target')).toEqual(
					clean,
				);
				expect(read(fitted.tools, 'identitySession.history[].actor')).toEqual(
					clean,
				);
				expect(read(fitted.tools, 'identitySession.history[].target')).toEqual(
					clean,
				);
			});
		});
	});

	describe('what it shares with what it was given', () => {
		it('replaces only the rows, lists and snapshot that changed', () => {
			const rows = deepFreeze([
				{ id: 'request-1', url: '/a' },
				{ id: 'request-2', url: 'u'.repeat(TEXT.long + 1) },
				{ id: 'request-3', url: '/c' },
			]);
			const untouched = deepFreeze([{ id: 'log-1' }]);
			const tools = deepFreeze(snapshot({ network: rows, console: untouched }));
			const fitted = fitDesktopSnapshot(tools);

			expect(fitted.tools).not.toBe(tools);
			const network = fitted.tools.network as unknown as typeof rows;
			expect(network).not.toBe(rows);
			expect(network[0]).toBe(rows[0]);
			expect(network[1]).not.toBe(rows[1]);
			expect(network[1]?.url).toHaveLength(TEXT.long);
			expect(network[2]).toBe(rows[2]);
			expect(fitted.tools.console).toBe(untouched);
			expect(fitted.tools.storage).toBe(tools.storage);
			// What it was given is as it was.
			expect(rows[1]?.url).toHaveLength(TEXT.long + 1);
		});

		it('keeps the rows of a list it cut as they were', () => {
			const rows = deepFreeze(ids(LIMITS.network + 1));
			const fitted = fit({ network: rows });
			const network = fitted.tools.network as unknown as typeof rows;
			expect(network[0]).toBe(rows[1]);
			expect(network[LIMITS.network - 1]).toBe(rows[LIMITS.network]);
		});

		it('replaces only the part of a row that changed', () => {
			const component = deepFreeze({
				id: 'component-1',
				bounds: { x: 0, y: 0, width: 1, height: 1 },
				accessibilityState: { selected: true },
				sourceFiles: ['App.tsx'],
				name: 'n'.repeat(TEXT.short + 1),
			});
			const tools = deepFreeze(snapshot({ components: [component] }));
			const fitted = fitDesktopSnapshot(tools);
			const [row] = fitted.tools.components as unknown as (typeof component)[];
			expect(row).not.toBe(component);
			expect(row?.bounds).toBe(component.bounds);
			expect(row?.accessibilityState).toBe(component.accessibilityState);
			expect(row?.sourceFiles).toBe(component.sourceFiles);
			expect(row?.name).toHaveLength(TEXT.short);
		});

		it('reports a change once however many rows it was made in', () => {
			const url = 'u'.repeat(TEXT.long + 1);
			const fitted = fit({
				network: Array.from({ length: LIMITS.network }, (_, index) => ({
					id: `request-${index}`,
					url,
				})),
			});
			expect(fitted.trimmed).toEqual([
				`network[].url to ${TEXT.long} characters`,
			]);
		});

		it('reports what it changed in the order it met it', () => {
			const fitted = fit({
				network: ids(LIMITS.network + 1),
				console: [{ id: 'log-1', message: 'm'.repeat(TEXT.long + 1) }],
				diagnostics: ids(LIMITS.diagnostics + 1),
			});
			expect(fitted.trimmed).toEqual([
				`network to ${LIMITS.network} rows`,
				`console[].message to ${TEXT.long} characters`,
				`diagnostics to ${LIMITS.diagnostics} rows`,
			]);
		});
	});

	describe('a snapshot that is not what the contract says', () => {
		it('does not throw, and leaves whatever it cannot bound alone', () => {
			const malformed = [
				{},
				{ network: 'not a list' },
				{ network: null, console: undefined },
				{ network: [null, 1, 'row', [], undefined] },
				{ components: [{ id: 'component-1', sourceFiles: 5, bounds: 'wide' }] },
				{ performance: null },
				{ performance: { samples: 'many' } },
				{ querySimulation: { active: { familyId: 'a' } } },
				{ querySimulation: { families: [{}], active: null } },
				{ querySimulation: { families: 'a', active: {} } },
				{ cameraFixture: null },
				{ cameraFixture: [] },
				{
					scenarios: [
						{ variables: [null, { type: 'string', defaultValue: 1 }] },
					],
				},
				{ identitySession: { active: { actor: 'Alex' } } },
			] as Record<string, unknown>[];
			for (const fields of malformed) {
				const tools = deepFreeze(
					fields,
				) as unknown as DesktopDeviceToolsSnapshot;
				expect(() => fitDesktopSnapshot(tools)).not.toThrow();
			}
			const tools = deepFreeze({
				network: [null, 1, 'row'],
				performance: { samples: 'many' },
			}) as unknown as DesktopDeviceToolsSnapshot;
			expect(fitDesktopSnapshot(tools).tools).toBe(tools);
		});

		it('fits what it can in a snapshot that lacks some fields', () => {
			const partial = {
				network: ids(LIMITS.network + 1),
			} as unknown as DesktopDeviceToolsSnapshot;
			const fitted = fitDesktopSnapshot(partial);
			expect(fitted.tools.network).toHaveLength(LIMITS.network);
			expect(Object.keys(fitted.tools)).toEqual(['network']);
		});

		it('hands back what is not a snapshot at all', () => {
			for (const value of [undefined, null, 'tools', 5]) {
				const fitted = fitDesktopSnapshot(
					value as unknown as DesktopDeviceToolsSnapshot,
				);
				expect(fitted.tools).toBe(value);
				expect(fitted.trimmed).toEqual([]);
			}
		});
	});
});
