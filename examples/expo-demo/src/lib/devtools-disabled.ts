import type { DesktopClientHandle } from '@rndevtools/react-native/desktop';

/**
 * Production stub for `@/devtools/desktop`.
 *
 * `metro.config.js` resolves the real module to this file in release builds.
 * Its only import is a type, which compiles away, so nothing from
 * `@rndevtools/*` can enter the bundle. The exported shape must stay identical
 * to the real module: a mismatch breaks at runtime in production, which is the
 * worst place to find it.
 */
export function connectToDesktop(): DesktopClientHandle | undefined {
	return undefined;
}
