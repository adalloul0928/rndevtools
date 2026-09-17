# RN Devtools — Expo demo

A minimal Expo app wired to `@rndevtools/core` and
`@rndevtools/react-native`. It exists to prove the public contract: if this
app typechecks and exports cleanly, a consumer outside this repo can do the
same.

## What it shows

| File | Demonstrates |
| --- | --- |
| [`src/app.tsx`](src/app.tsx) | An app whose **only** devtools import is the host module |
| [`src/devtools/host.tsx`](src/devtools/host.tsx) | The single seam: mounts `InternalTools`, grants authorization, connects the desktop |
| [`src/devtools/plugins.ts`](src/devtools/plugins.ts) | Host-specific configuration: URL scheme, vendor correlation headers, environment values |
| [`src/devtools/desktop.ts`](src/devtools/desktop.ts) | Implementing `DesktopClientHost` to connect to the desktop app |
| [`src/lib/devtools-host-disabled.tsx`](src/lib/devtools-host-disabled.tsx) | The no-op stub a release build resolves to instead |
| [`metro.config.js`](metro.config.js) | `withDevtoolsPruning` cutting devtools out of the module graph |

## Run it

```sh
pnpm install
pnpm --dir examples/expo-demo start
```

Open the desktop app alongside it and the device appears automatically — the
client discovers a loopback broker on its own.

## Prove the pruning works

Two checks, at two speeds. The fast one walks the import graph with the same
replacement table Metro is given, and fails if anything from `@rndevtools/*`
is still reachable. It runs in the `quality` gate and names the offending
import:

```sh
pnpm --dir examples/expo-demo verify:seam
```

The rule it enforces is the whole trick: the app imports devtools from exactly
one module, and Metro replaces that module. A second import anywhere else
reconnects the graph. The slow check confirms it against a real export:

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
