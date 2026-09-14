import { describe, expect, it } from 'vitest';
import {
	electronViteConfig,
	WS_OPTIONAL_NATIVE_PEERS,
} from './electron.vite.config';

describe('Electron Vite configuration', () => {
	it('preserves ws optional-native-peer fallbacks in the main bundle', () => {
		expect(WS_OPTIONAL_NATIVE_PEERS).toEqual(['bufferutil', 'utf-8-validate']);
		expect(electronViteConfig.main.build.rollupOptions.external).toEqual(
			WS_OPTIONAL_NATIVE_PEERS
		);
	});
});
