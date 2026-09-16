'use strict';

const path = require('node:path');

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
 * @returns {object} The same config, with `resolver.resolveRequest` wrapped.
 */
function withDevtoolsPruning(config, options) {
	const { enabled, projectRoot, replace } = options ?? {};
	if (!enabled) return config;
	if (!projectRoot) throw new Error('withDevtoolsPruning requires projectRoot');
	if (!Array.isArray(replace) || replace.length === 0) {
		throw new Error('withDevtoolsPruning requires a non-empty replace list');
	}

	const entries = replace.map((entry) => {
		if (!entry || !entry.module || !entry.stub) {
			throw new Error(
				'Each replace entry needs a `module` and a `stub` path.'
			);
		}
		return {
			module: entry.module,
			resolved: path.resolve(projectRoot, entry.path ?? entry.module),
			stub: path.resolve(projectRoot, entry.stub),
		};
	});

	// An import of the same file can arrive as the alias, the extensionless
	// absolute path, or the path with its extension, depending on the importer.
	const matches = (moduleName, entry) =>
		moduleName === entry.module ||
		moduleName === entry.resolved ||
		moduleName === `${entry.resolved}.ts` ||
		moduleName === `${entry.resolved}.tsx`;

	const resolver = config.resolver ?? {};
	const previous = resolver.resolveRequest;
	resolver.resolveRequest = (context, moduleName, platform) => {
		for (const entry of entries) {
			if (matches(moduleName, entry)) {
				return context.resolveRequest(context, entry.stub, platform);
			}
		}
		return previous
			? previous(context, moduleName, platform)
			: context.resolveRequest(context, moduleName, platform);
	};
	config.resolver = resolver;
	return config;
}

module.exports = { withDevtoolsPruning };
