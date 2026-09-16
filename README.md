# RN Devtools

Extensible on-device diagnostics for React Native, with a local-first desktop
inspector.

Two halves that version together:

- **On device** — a panel runtime with built-in plugins for network, console,
  storage, React Query, navigation, Zustand, performance, environment, images,
  component inspection, and scriptable scenarios. iOS-first, with native
  SwiftUI chrome and matching React Native panels on Android.
- **On your Mac** — an Electron app that connects over a loopback WebSocket and
  gives the same diagnostics a real desktop UI, plus Simulator fleet
  management, deep links and permissions, screenshot and recording capture,
  build insights, and experimental Simulator slimming.

## Packages

| Package | What it is |
| --- | --- |
| [`@rndevtools/core`](packages/core) | Panel runtime and diagnostic plugins |
| [`@rndevtools/react-native`](packages/react-native) | Host runtime: desktop client, authorization, adapters, Metro pruning |
| [`apps/desktop`](apps/desktop) | The Electron inspector (distributed as a signed app, not on npm) |

## Quick start

```sh
pnpm add -D @rndevtools/core @rndevtools/react-native
```

```tsx
import { InternalTools } from '@rndevtools/core';
import { createNetworkPlugin, createQueryPlugin } from '@rndevtools/core/plugins';

const network = createNetworkPlugin({ captureBody: true });

<InternalTools
  enabled={__DEV__}
  plugins={[network.plugin, createQueryPlugin({ queryClient })]}
/>;
```

Each package README covers the rest: [core](packages/core/README.md) for
plugins and panel contracts, [react-native](packages/react-native/README.md)
for the desktop connection and production pruning.

## Two things to know before you adopt it

**Devtools must not reach your release builds.** Tree shaking is not a strong
enough guarantee — one retained import pulls in the panels and every adapter
they reach. `@rndevtools/react-native` ships the mechanism: a Metro resolver
that swaps devtools modules for typed no-op shims so the graph is cut rather
than trimmed, and `rndevtools-verify-bundle` to assert over a real export that
nothing survived. Wire up both.

**Both packages ship TypeScript source, not build output.** Three components
use Reanimated worklets, which have to be workletized by your app's own Babel
pipeline; a prebuilt bundle would silently lose that. Metro needs no
configuration. Jest needs the packages in `transformIgnorePatterns`.

## Building the desktop app

> [!IMPORTANT]
> The desktop app depends on **HeroUI Pro**, a commercial component library.
> 16 renderer modules import `@heroui-pro/react`, so building from source
> requires your own HeroUI Pro license and a `HEROUI_AUTH_TOKEN`. The two npm
> packages have no such dependency and build freely.

```sh
pnpm install
pnpm --filter @rndevtools/desktop native:build   # Go + Swift helpers
pnpm --filter @rndevtools/desktop dev
```

Native helper builds need Go, Swift, and `govulncheck`
(`go install golang.org/x/vuln/cmd/govulncheck@latest`).

Simulator mutation is gated on code signing: the helper verifies that its
parent process is signed by a pinned Apple Team ID, injected at build time from
`APPLE_TEAM_ID`. Without it the helper fails closed and refuses every mutation,
which is correct for an unsigned local build — everything else still works.

## Development

```sh
pnpm install
pnpm quality          # lint + typecheck + test across all workspaces
```

Per workspace: `pnpm --dir packages/core quality`,
`pnpm --dir packages/react-native quality`,
`pnpm --filter @rndevtools/desktop quality`.

## Credits

The Simulator slimming helper vendors a reviewed fork of
[SimSlim](https://github.com/MobAI-App/simslim) (MIT). Provenance, the exact
patch set, and SHA-256 manifests are recorded under
[`apps/desktop/native/rndevtools-sim-helper`](apps/desktop/native/rndevtools-sim-helper),
and notices in
[`THIRD_PARTY_NOTICES.md`](apps/desktop/THIRD_PARTY_NOTICES.md).

This project was extracted from a production app's internal tooling. The
patch-set identifier `pumpd.1` is retained because SHA-256 manifests anchor it.

## License

MIT
