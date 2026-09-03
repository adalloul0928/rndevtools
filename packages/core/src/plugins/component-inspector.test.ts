import {
	createComponentInspectorPlugin,
	normalizeComponentTargets,
} from './component-inspector';

describe('normalizeComponentTargets', () => {
	it('bounds target count, metadata, measurements, and instance previews', () => {
		const targets = normalizeComponentTargets(
			[
				{
					id: 'target-1',
					name: 'Exercise card',
					bounds: { x: Number.NaN, y: 10.25, width: -2, height: 30.75 },
					instance: { state: 'x'.repeat(100) },
					sourceFiles: ['one.tsx', 'two.tsx'],
				},
				{ id: 'target-2', name: 'Hidden by cap' },
			],
			{ maxTargets: 1, maxInstanceBytes: 32, maxTextBytes: 32 },
		);

		expect(targets).toHaveLength(1);
		expect(targets[0]).toEqual(
			expect.objectContaining({
				id: 'target-1',
				kind: 'component',
				instanceTruncated: true,
				bounds: null,
			}),
		);
		expect(
			normalizeComponentTargets([{ id: 'target', name: 'Target' }], {
				maxTargets: 10,
				maxInstanceBytes: 32,
				maxTextBytes: 32,
				maxSnapshotBytes: 1,
			}),
		).toEqual([]);
	});

	it('skips invalid, duplicate, and oversized targets without hiding later entries', () => {
		const targets = normalizeComponentTargets(
			[
				{ id: '', name: 'Missing id' },
				{ id: 'one', name: 'x'.repeat(200) },
				{ id: 'two', name: 'Two' },
				{ id: 'two', name: 'Duplicate' },
			],
			{
				maxTargets: 1,
				maxInstanceBytes: 32,
				maxTextBytes: 64,
				maxSnapshotBytes: 150,
			},
		);

		expect(targets).toEqual([
			expect.objectContaining({ id: 'two', name: 'Two' }),
		]);
	});

	it('contains malformed runtime metadata from a host source', () => {
		const targets = normalizeComponentTargets(
			[
				{ id: 'valid', name: 'Valid', kind: 42, isFocused: 'yes' },
				{ id: 10, name: 'Invalid' },
			] as unknown as Parameters<typeof normalizeComponentTargets>[0],
			{ maxTargets: 5, maxInstanceBytes: 32, maxTextBytes: 32 },
		);

		expect(targets).toEqual([
			expect.objectContaining({
				id: 'valid',
				kind: 'component',
				isFocused: false,
			}),
		]);
	});

	it('redacts instance metadata before serialization', () => {
		const targets = normalizeComponentTargets(
			[
				{
					id: 'private-target',
					name: 'Private target',
					instance: {
						accessToken: 'opaque-private-token',
						status: 'ready',
					},
				},
			],
			{ maxTargets: 5, maxInstanceBytes: 1_024, maxTextBytes: 64 },
		);

		expect(targets[0]?.instanceText).toContain('[REDACTED]');
		expect(targets[0]?.instanceText).not.toContain('opaque-private-token');
	});

	it('skips accessor-backed target fields without invoking them', () => {
		const target = { id: 'safe', name: 'Safe target' } as Record<
			string,
			unknown
		>;
		Object.defineProperty(target, 'route', {
			enumerable: true,
			get() {
				throw new Error('route getter must not run');
			},
		});

		const targets = normalizeComponentTargets(
			[target] as unknown as Parameters<typeof normalizeComponentTargets>[0],
			{ maxTargets: 5, maxInstanceBytes: 1_024, maxTextBytes: 64 },
		);

		expect(targets).toEqual([
			expect.objectContaining({ id: 'safe', route: undefined }),
		]);
	});

	it('does not invoke accessors in the target list', () => {
		const getter = jest.fn(() => ({ id: 'unsafe', name: 'Unsafe' }));
		const targets: unknown[] = [];
		Object.defineProperty(targets, '0', {
			enumerable: true,
			get: getter,
		});
		targets.length = 1;

		expect(
			normalizeComponentTargets(
				targets as Parameters<typeof normalizeComponentTargets>[0],
				{ maxTargets: 5, maxInstanceBytes: 1_024, maxTextBytes: 64 },
			),
		).toEqual([]);
		expect(getter).not.toHaveBeenCalled();
	});

	it('rejects a revoked target-list proxy without throwing', () => {
		const revoked = Proxy.revocable([], {});
		revoked.revoke();

		expect(
			normalizeComponentTargets(
				revoked.proxy as Parameters<typeof normalizeComponentTargets>[0],
				{ maxTargets: 5, maxInstanceBytes: 1_024, maxTextBytes: 64 },
			),
		).toEqual([]);
	});
});

describe('createComponentInspectorPlugin', () => {
	it('rejects unsafe retention limits', () => {
		const source = { getSnapshot: () => [], subscribe: () => () => {} };
		expect(() =>
			createComponentInspectorPlugin({ source, maxTargets: 5_001 }),
		).toThrow('maxTargets cannot exceed');
		expect(() =>
			createComponentInspectorPlugin({
				source,
				maxSnapshotBytes: 16 * 1024 * 1024 + 1,
			}),
		).toThrow('maxSnapshotBytes cannot exceed');
	});

	it('subscribes to an explicit target source only while installed', () => {
		let targets = [{ id: 'one', name: 'One' }];
		let listener: (() => void) | undefined;
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => targets,
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {
						listener = undefined;
					};
				},
			},
		});

		expect(diagnostics.getTargets()).toEqual([]);
		const dispose = diagnostics.plugin.install?.();
		expect(diagnostics.getTargets().map((target) => target.id)).toEqual([
			'one',
		]);
		targets = [{ id: 'two', name: 'Two' }];
		listener?.();
		expect(diagnostics.getTargets().map((target) => target.id)).toEqual([
			'two',
		]);

		dispose?.();
		expect(listener).toBeUndefined();
	});

	it('contains faulty host sources during install and capture', () => {
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => {
					throw new Error('snapshot failed');
				},
				subscribe: () => {
					throw new Error('subscribe failed');
				},
			},
		});

		let dispose: (() => void) | undefined;
		expect(() => {
			dispose = diagnostics.plugin.install?.();
		}).not.toThrow();
		expect(diagnostics.getTargets()).toEqual([]);
		expect(diagnostics.getSnapshot().error).toContain('Subscription failed');
		expect(() => dispose?.()).not.toThrow();
	});

	it('ignores a pending refresh after the collector is disposed', async () => {
		let targets = [{ id: 'before', name: 'Before' }];
		let resolveRefresh: (() => void) | undefined;
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => targets,
				subscribe: () => () => {},
				refresh: () =>
					new Promise<void>((resolve) => {
						resolveRefresh = resolve;
					}),
			},
		});
		const dispose = diagnostics.plugin.install?.();
		targets = [{ id: 'after', name: 'After' }];
		dispose?.();
		resolveRefresh?.();
		await Promise.resolve();

		expect(diagnostics.getTargets().map((target) => target.id)).toEqual([
			'before',
		]);
	});

	it('ignores callbacks fired by a faulty disposer', () => {
		let targets = [{ id: 'before', name: 'Before' }];
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => targets,
				subscribe: (listener) => () => listener(),
			},
		});
		const dispose = diagnostics.plugin.install?.();
		targets = [{ id: 'during-dispose', name: 'During dispose' }];

		dispose?.();

		expect(diagnostics.getTargets().map((target) => target.id)).toEqual([
			'before',
		]);
	});

	it('delegates explicit target highlighting only while installed', async () => {
		const highlight = jest.fn();
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => [{ id: 'one', name: 'One' }],
				subscribe: () => () => {},
				highlight,
			},
		});
		await expect(diagnostics.highlight('one')).rejects.toThrow('disabled');
		const dispose = diagnostics.plugin.install?.();
		await diagnostics.highlight('one');
		expect(highlight).toHaveBeenCalledWith('one');
		dispose?.();
	});
});
