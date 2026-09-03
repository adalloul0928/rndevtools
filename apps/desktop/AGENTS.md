# PUMPD Devtools Desktop

This workspace is the isolated Electron desktop diagnostics app. It uses electron-vite, React, HeroUI and HeroUI Pro, Tailwind CSS, a local WebSocket broker, and electron-builder.

## Commands

```bash
pnpm --filter @pumpd/devtools-desktop dev
pnpm --filter @pumpd/devtools-desktop lint
pnpm --filter @pumpd/devtools-desktop typecheck
pnpm --filter @pumpd/devtools-desktop test:run
pnpm --filter @pumpd/devtools-desktop build
pnpm --filter @pumpd/devtools-desktop quality
pnpm --filter @pumpd/devtools-desktop package
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
- Keep generated `dist` and `release` output untracked. Distribution signing and notarization credentials belong in the release environment, never in the repository.
