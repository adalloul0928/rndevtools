const fs = require('node:fs');
const path = require('node:path');

// Metro's own defaults, for a config that does not list its own.
const DEFAULT_SOURCE_EXTS = ['js', 'jsx', 'json', 'ts', 'tsx'];
const DEFAULT_PLATFORMS = ['ios', 'android'];

function isFile(candidate) {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/**
 * Real paths of the files a module path can resolve to: the path itself, the
 * path with a source or platform extension, or the index of that directory.
 */
function moduleFiles(base, sourceExts, platforms) {
	const extensions = sourceExts.flatMap((extension) => [
		`.${extension}`,
		...platforms.map((platform) => `.${platform}.${extension}`),
	]);
	const candidates = [
		base,
		...extensions.map((extension) => `${base}${extension}`),
		...extensions.map((extension) => path.join(base, `index${extension}`)),
	];
	return [
		...new Set(
			candidates
				.filter((candidate) => isFile(candidate))
				.map((candidate) => fs.realpathSync(candidate)),
		),
	];
}

/** The file Node resolves an installed package specifier to, if any. */
function packageFiles(specifier, projectRoot) {
	try {
		return [
			fs.realpathSync(require.resolve(specifier, { paths: [projectRoot] })),
		];
	} catch {
		return [];
	}
}

/**
 * Metro resolver that swaps devtools modules for inert stubs in release builds.
 *
 * Devtools code is only safe to ship because it never reaches a production
 * bundle. Tree shaking is not a strong enough guarantee for that: a single
 * retained import pulls in panels, adapters, and the diagnostics they reach.
 * This replaces the modules at resolution time instead, so the graph is cut
 * rather than trimmed, and pairs with `verifyPrunedBundle` to prove it.
 *
 * Each entry names a module the app imports, the file it resolves to, and the
 * stub to use instead. The stub must export the same shape as the real module
 * with no-op implementations.
 *
 * Imports are matched by the file they resolve to, not by how they are
 * written, so the alias, a relative path (babel-plugin-module-resolver
 * rewrites aliases to those before Metro sees them), an explicit extension
 * and an `/index` import of the file all get the stub. Every `path` and stub
 * must name an existing file: a stale entry throws here instead of silently
 * leaving the real module in the bundle.
 *
 * @example
 * const { withDevtoolsPruning } = require('@rndevtools/react-native/metro');
 *
 * module.exports = withDevtoolsPruning(config, {
 *   enabled: process.env.APP_VARIANT === 'production',
 *   projectRoot: __dirname,
 *   replace: [
 *     {
 *       module: '@/features/dev-menu/dev-menu-host',
 *       path: 'src/features/dev-menu/dev-menu-host',
 *       stub: 'src/lib/dev-menu-host-disabled.tsx',
 *     },
 *   ],
 * });
 *
 * @param {object} config Metro config to extend.
 * @param {object} options
 * @param {boolean} options.enabled Whether to prune. Pass `false` for dev builds.
 * @param {string} options.projectRoot Absolute root that relative paths resolve against.
 * @param {ReadonlyArray<{module: string, path?: string, stub: string}>} options.replace
 *   `path` is the file `module` resolves to, relative to `projectRoot`, with or
 *   without its extension. Leave it out only when `module` is itself such a
 *   path or an installed package.
 * @returns {object} The same config, with `resolver.resolveRequest` wrapped.
 */
function withDevtoolsPruning(config, options) {
	const { enabled, projectRoot, replace } = options ?? {};
	if (!enabled) return config;
	if (!projectRoot) throw new Error('withDevtoolsPruning requires projectRoot');
	if (!Array.isArray(replace) || replace.length === 0) {
		throw new Error('withDevtoolsPruning requires a non-empty replace list');
	}

	const resolver = config.resolver ?? {};
	const sourceExts = Array.isArray(resolver.sourceExts)
		? resolver.sourceExts
		: DEFAULT_SOURCE_EXTS;
	// Metro can also resolve `.native.*` files; they are the same module.
	const platforms = [
		...new Set([
			...(Array.isArray(resolver.platforms)
				? resolver.platforms
				: DEFAULT_PLATFORMS),
			'native',
		]),
	];

	const targets = new Map();
	const entries = replace.map((entry) => {
		if (!entry?.module || !entry.stub) {
			throw new Error('Each replace entry needs a `module` and a `stub` path.');
		}
		const stub = path.resolve(projectRoot, entry.stub);
		if (moduleFiles(stub, sourceExts, platforms).length === 0) {
			throw new Error(
				`withDevtoolsPruning: the stub for ${entry.module}, ${entry.stub}, is not a file under ${projectRoot}.`,
			);
		}
		const files =
			entry.path === undefined
				? [
						...moduleFiles(
							path.resolve(projectRoot, entry.module),
							sourceExts,
							platforms,
						),
						...packageFiles(entry.module, projectRoot),
					]
				: moduleFiles(
						path.resolve(projectRoot, entry.path),
						sourceExts,
						platforms,
					);
		if (files.length === 0) {
			throw new Error(
				entry.path === undefined
					? `withDevtoolsPruning: cannot find the file ${entry.module} resolves to. Set its \`path\` to that file, relative to ${projectRoot}.`
					: `withDevtoolsPruning: the path for ${entry.module}, ${entry.path}, is not a file under ${projectRoot}.`,
			);
		}
		const pruned = { module: entry.module, stub };
		for (const file of files) targets.set(file, pruned);
		return pruned;
	});

	// Metro hands back real paths, so a lookup by name settles almost every
	// resolution; only a file named like a target pays for a realpath.
	const targetNames = new Set(
		[...targets.keys()].map((file) => path.basename(file)),
	);
	const targetFor = (filePath) => {
		const direct = targets.get(filePath);
		if (direct || !targetNames.has(path.basename(filePath))) return direct;
		try {
			return targets.get(fs.realpathSync(filePath));
		} catch {
			return undefined;
		}
	};

	const previous = resolver.resolveRequest;
	resolver.resolveRequest = (context, moduleName, platform) => {
		// An alias may only be resolvable by Babel, so it is matched by name
		// before anything tries to resolve it.
		const aliased = entries.find((entry) => moduleName === entry.module);
		if (aliased) return context.resolveRequest(context, aliased.stub, platform);
		const resolution = previous
			? previous(context, moduleName, platform)
			: context.resolveRequest(context, moduleName, platform);
		const pruned =
			resolution?.type === 'sourceFile'
				? targetFor(resolution.filePath)
				: undefined;
		return pruned
			? context.resolveRequest(context, pruned.stub, platform)
			: resolution;
	};
	config.resolver = resolver;
	return config;
}

module.exports = { withDevtoolsPruning };
