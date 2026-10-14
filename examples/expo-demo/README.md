# RN Devtools — Expo demo

A minimal Expo app wired to `@rndevtools/core` and
`@rndevtools/react-native`. It exists to prove the public contract: if this
app typechecks and exports cleanly, a consumer outside this repo can do the
same.

## What it shows

| File | Demonstrates |
| --- | --- |
| [`src/app.tsx`](src/app.tsx) | Mounting `InternalTools` behind the required providers |
| [`src/devtools/plugins.ts`](src/devtools/plugins.ts) | Host-specific configuration: URL scheme, vendor correlation headers, environment values |
| [`src/devtools/desktop.ts`](src/devtools/desktop.ts) | Implementing `DesktopClientHost` to connect to the desktop app |
| [`src/lib/devtools-disabled.ts`](src/lib/devtools-disabled.ts) | The no-op stub a release build resolves to instead |
| [`metro.config.js`](metro.config.js) | `withDevtoolsPruning` cutting devtools out of the module graph |
| [`app.config.js`](app.config.js) | The build cache provider that shares native builds between git worktrees (lanes) |

## Run it

```sh
pnpm install
pnpm --dir examples/expo-demo start
```

Open the desktop app alongside it and the device appears automatically — the
client discovers a loopback broker on its own.

## Run several branches at once

Lanes in the desktop app (or `rndevtools lane --operation up`) run one worktree
per Simulator with its own Metro port. The dev client has to exist on that
Simulator first; build it once and the cache provider in `app.config.js`
shares the binary with every other worktree whose native fingerprint matches:

```sh
npx expo run:ios --device <udid> --no-bundler    # first worktree builds and caches
git worktree add ../demo-feature feature/x        # same native shell, new JS
cd ../demo-feature && npx expo run:ios --device <other-udid> --no-bundler   # installs from cache
```

## Prove the pruning works

```sh
APP_VARIANT=production pnpm --dir examples/expo-demo verify:bundle
```

Exports a production bundle and asserts no devtools markers survived. This is
the check worth copying into your own CI; without it, an import added months
from now silently reconnects the graph.

## Notes

The app declares no action capabilities in `createDeviceInfo`, so every
privileged desktop control stays inert. A real host opts in one capability at a
time, and `runAction` here rejects everything by design — rejecting is how a
host refuses a desktop-issued action.
