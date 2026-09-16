# RN Devtools Desktop

This workspace is the isolated Electron desktop diagnostics app. It uses electron-vite, React, HeroUI and HeroUI Pro, Tailwind CSS, a local WebSocket broker, and electron-builder.

## Commands

```bash
pnpm --filter @rndevtools/desktop dev
pnpm --filter @rndevtools/desktop lint
pnpm --filter @rndevtools/desktop typecheck
pnpm --filter @rndevtools/desktop test:run
pnpm --filter @rndevtools/desktop build
pnpm --filter @rndevtools/desktop quality
pnpm --filter @rndevtools/desktop package
```

## Desktop Rules

- Keep Electron concerns separated under `src/main`, `src/preload`, `src/shared`, and `src/renderer`. The renderer must not import Node or Electron APIs.
- Preserve the sandboxed BrowserWindow, context isolation, disabled Node integration, Content Security Policy, denied navigation/popups, single-instance behavior, and frozen preload bridge.
- Add privileged operations through the shared typed protocol, validate untrusted data at IPC and WebSocket boundaries, and expose the narrowest possible preload method.
- Keep the broker on loopback by default. LAN binding must remain an explicit development opt-in and must never be silently enabled.
- Diagnostics must use bounded, redacted, explicit projections. Never crawl global Zustand/React state, transmit secure storage values, or add an unrestricted remote-evaluation path.
- Remote actions require explicit per-tool command handling on the mobile client. Destructive or state-changing controls need clear confirmation and recoverable behavior where practical.
- Use HeroUI core and HeroUI Pro together where each fits. Preserve the compact Vercel-inspired black, gray, white, and blue visual system, keyboard accessibility, and the 1040×700 responsive minimum.
- Keep heavy tool panels lazy-loaded. Add focused tests for protocol, broker, action, and demo-state behavior.
- Run `quality` for source changes. For packaging changes, also create an unpacked package, validate its fuses/signature, and launch the packaged app before completion.
- The Apple Team ID trusted by the simulator helper is injected at build time from `APPLE_TEAM_ID` via Go `-ldflags`, and the helper fails closed without it. Never hardcode a team identifier back into `parent_attestor.go`.
- App-specific placeholder values live in `src/renderer/simulator/target-config.ts`. Do not scatter product names, URL schemes, or bundle identifiers through the panels.
- The vendored SimSlim tree and its SHA-256 manifests are byte-anchored, including the `pumpd.1` patch-set identifier inherited from the project this repo was extracted from. Renaming any of it invalidates `native:check:packaging`.
- Building from source requires a HeroUI Pro license and `HEROUI_AUTH_TOKEN`; 16 renderer modules import `@heroui-pro/react`.
- Keep generated `dist` and `release` output untracked. Distribution signing and notarization credentials belong in the release environment, never in the repository.
