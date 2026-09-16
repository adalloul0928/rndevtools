const { getDefaultConfig } = require('expo/metro-config');
const { withDevtoolsPruning } = require('@rndevtools/react-native/metro');

const config = getDefaultConfig(__dirname);

// Cut devtools out of the module graph for release builds. Resolution-time
// replacement, not tree shaking: one retained import would otherwise pull in
// the panels and every adapter they reach.
module.exports = withDevtoolsPruning(config, {
	enabled: process.env.APP_VARIANT === 'production',
	projectRoot: __dirname,
	replace: [
		{
			module: '@/devtools/desktop',
			path: 'src/devtools/desktop',
			stub: 'src/lib/devtools-disabled.ts',
		},
	],
});
