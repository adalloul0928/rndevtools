import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { UserConfig } from 'electron-vite';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export const WS_OPTIONAL_NATIVE_PEERS = ['bufferutil', 'utf-8-validate'] as const;

const sharedAlias = {
	'@shared': path.resolve(__dirname, 'src/shared'),
};

const nodeAliases = {
	'@main': path.resolve(__dirname, 'src/main'),
	...sharedAlias,
};

const rendererAliases = {
	'@': path.resolve(__dirname, 'src/renderer'),
	...sharedAlias,
};

export const electronViteConfig = {
	main: {
		plugins: [externalizeDepsPlugin({ exclude: ['@pumpd/devtools', 'ws', 'zod'] })],
		resolve: { alias: nodeAliases },
		build: {
			outDir: 'dist/main',
			sourcemap: true,
			// `ws` requires these native accelerators inside a try/catch and falls back to
			// its JS implementations. Bundling them makes Vite hoist an unresolved-import
			// `throw` to module scope, outside that try/catch, which crashes main on load.
			rollupOptions: { external: [...WS_OPTIONAL_NATIVE_PEERS] },
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin({ exclude: ['@pumpd/devtools', 'zod'] })],
		resolve: { alias: nodeAliases },
		build: { outDir: 'dist/preload', sourcemap: true },
	},
	renderer: {
		plugins: [react(), tailwindcss()],
		resolve: { alias: rendererAliases },
		build: { outDir: 'dist/renderer', sourcemap: true },
	},
} satisfies UserConfig;

export default defineConfig(electronViteConfig);
