# RN Devtools

Private, reusable React Native diagnostics. The root export owns runtime and shared UI; `@rndevtools/core/plugins` owns built-in diagnostic and plugin factories.

## Commands

```bash
pnpm --dir packages/devtools lint
pnpm --dir packages/devtools typecheck
pnpm --dir packages/devtools test:run
```

## Package Rules

- Keep this package host-agnostic. Do not import mobile-app code; PUMPD-specific flags, adapters, actions, fixtures, and panels belong in `apps/mobile`.
- Keep the root and `/plugins` entry points separate so hosts that only need the shell do not traverse optional diagnostics.
- Collectors follow `enabled`, not panel visibility. Reconcile them by plugin ID and installer without restarting unrelated collectors.
- Bound captured events by count and estimated bytes. Redact sensitive URLs, headers, and bodies before data enters a store; omit binary, oversized, and unknown-length bodies unless explicitly opted in.
- Do not patch global `fetch` by default, and only restore a patched global when the plugin still owns that wrapper.
- Reuse the existing Expo UI/SwiftUI presentation system and public plugin contracts. A host must provide gesture-handler and safe-area providers.
- Preserve typed no-op compatibility for production consumers. Add focused tests for lifecycle, disposal, redaction, storage limits, and public-contract changes.
- Run all three checks before completing package changes and verify the mobile host when changing an exported contract.
