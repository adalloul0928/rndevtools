const { getDefaultConfig } = require('expo/metro-config');
const { withDevtoolsPruning } = require('@rndevtools/react-native/metro');

const config = getDefaultConfig(__dirname);

// Cut devtools out of the module graph of every release bundle: whatever Metro
// builds with `dev: false`, as `expo export`, Xcode and Gradle release builds
// and EAS do, with no variable to set and nothing to forget. Resolution-time
// replacement, not tree shaking: one retained import would otherwise pull in
// the panels and every adapter they reach, so an import that would still
// reach `@rndevtools/*` fails the build instead. Development bundles keep
// everything. An internal build that deliberately ships the panels would
// pass `keepInReleaseBundles: true`, and `pnpm verify:bundle` fails on it.
// That script exports once with this variable set, to show that the verifier
// can fail; nothing else reads it.
module.exports = withDevtoolsPruning(config, {
	projectRoot: __dirname,
	keepInReleaseBundles: process.env.RNDEVTOOLS_DEMO_KEEP_DEVTOOLS === '1',
	replace: [
		{
			module: '@/devtools/host',
			path: 'src/devtools/host',
			stub: 'src/lib/devtools-host-disabled.tsx',
		},
	],
});
