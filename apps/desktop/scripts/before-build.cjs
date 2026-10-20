/**
 * electron-vite bundles every runtime dependency into dist, and the package
 * allowlist excludes node_modules. Mark dependency handling complete so
 * electron-builder does not traverse the entire monorepo dependency graph.
 */
module.exports = async function beforeBuild() {
	return false;
};
