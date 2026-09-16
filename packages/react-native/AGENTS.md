# @rndevtools/react-native

React Native host runtime: desktop broker client, authorization mirror, storage and camera adapters, and the Metro production-pruning helper.

## Commands

```bash
pnpm --dir packages/react-native lint
pnpm --dir packages/react-native typecheck
pnpm --dir packages/react-native test:run
pnpm --dir packages/react-native quality
```

## Package Rules

- Keep this package host-agnostic. The desktop client takes a `DesktopClientHost` adapter; add a callback to that interface rather than importing app state or reaching for a global.
- Import from `@rndevtools/core`'s narrow subpaths (`/redact`, `/serialize`, `/desktop-protocol`), never the root barrel. The barrel pulls in the panel UI and Reanimated, which headless host modules must not depend on.
- Ships TypeScript source for the same reason as `@rndevtools/core`. Do not add a bundler.
- The broker socket is unauthenticated loopback. Keep `shouldStartDesktopClient` conservative: development builds only, inert under test, and honouring the kill switch.
- Authorization is a revocation boundary. A failed or changed owner read must revoke synchronously; re-granting is the host's explicit decision.
- The secure-store adapter reads only keys in its caller-supplied manifest. Never enumerate a keychain.
- `withDevtoolsPruning` and `rndevtools-verify-bundle` are a pair. Changing either without the other silently weakens the production guarantee.
- `expo-file-system` and `expo-image-picker` are optional peers reached only through the `./camera` subpath, and are listed in the root `knip.json` `ignoreDependencies` for that reason.
