# @rndevtools/core

Reusable React Native diagnostics. The root export owns the runtime and shared UI; `@rndevtools/core/plugins` owns built-in diagnostic and plugin factories.

## Commands

```bash
pnpm --dir packages/core lint
pnpm --dir packages/core typecheck
pnpm --dir packages/core test:run
pnpm --dir packages/core quality
```

## Package Rules

- Keep this package host-agnostic. Never import host-app code, and never hardcode a product name, URL scheme, bundle identifier, or vendor header — take them as options with neutral defaults.
- This package ships TypeScript source, not build output, because three components use Reanimated worklets that the consuming app's Babel pipeline must compile. Do not add a bundler without solving workletization first.
- Keep the root and `/plugins` entry points separate so hosts that only need the shell do not traverse optional diagnostics.
- Collectors follow `enabled`, not panel visibility. Reconcile them by plugin ID and installer without restarting unrelated collectors.
- Bound captured events by count and estimated bytes. Redact sensitive URLs, headers, and bodies before data enters a store; omit binary, oversized, and unknown-length bodies unless explicitly opted in.
- Do not patch global `fetch` by default, and only restore a patched global when the plugin still owns that wrapper.
- Reuse the existing Expo UI/SwiftUI presentation system and public plugin contracts. A host must provide gesture-handler and safe-area providers.
- Preserve typed no-op compatibility for production consumers. Add focused tests for lifecycle, disposal, redaction, storage limits, and public-contract changes.
- Persisted storage keys are host-overridable options; document-format `namespace` values are not, since they discriminate serialized documents on read.
- Run `quality` before completing package changes, and verify `@rndevtools/react-native` and `apps/desktop` when changing an exported contract.
