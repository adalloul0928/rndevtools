import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Vitest does not read electron.vite.config.ts, so without this file tests run
// with no path aliases at all. The suites happen to use relative imports today,
// so the first test importing `@shared/...` would fail for a confusing reason.
export default defineConfig({
	resolve: {
		alias: {
			'@': path.resolve(__dirname, 'src/renderer'),
			'@main': path.resolve(__dirname, 'src/main'),
			'@shared': path.resolve(__dirname, 'src/shared'),
		},
	},
	test: {
		include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
	},
});
