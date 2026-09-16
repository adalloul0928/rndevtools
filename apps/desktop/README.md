# RN Devtools Desktop

An isolated Electron app for inspecting a running PUMPD development build. The renderer uses React, HeroUI, HeroUI Pro, Tailwind CSS, and a restrained Vercel-inspired visual system. Electron owns the local device broker and exposes only a narrow, typed preload API to the renderer.

## Tools

Connected PUMPD app diagnostics:

- Network request history and request/response details
- Logger-backed, redacted console events
- Explicit storage adapters with protected values hidden
- TanStack Query queries, bounded sanitized payload previews, mutations, invalidate, and refetch actions
- Expo Router map, history, and allowlisted navigation
- Environment validation and health scoring
- Explicit, read-only Zustand store projections and change history
- Guarded restore points for declared safe state sources, with rollback attempts
- JS responsiveness reviews with optional native UI/CPU/memory channels
- Targeted component registry with source, test ID, safe instance projection, measured bounds, and on-device highlight
- Broker, transport, runtime, privacy, and internal diagnostics

Local iOS Simulator tooling on macOS:

- Multi-Simulator fleet discovery, creation, cloning, boot/shutdown, erase/delete,
  installed-app inventory, process drill-down, disk inventory, and host/device metrics
- Experimental SimSlim profiles with compatibility gating, exact previews, checkpoints,
  verification, rollback, drift repair, capability doctor, and sequential batches
- Bundle-aware app install/launch/terminate, deep links, APNs payloads, permissions,
  location/routes, locale/time zone, appearance, Dynamic Type, status bar, keychain,
  pasteboard, and main-owned directory reveal actions
- Screenshots and H.264 recordings with crash recovery, private media URLs, retention,
  export/reveal/delete, and concurrent exact-UDID capture jobs
- Capture Design Studio with native PNG/JPEG composition, device treatment, canvas and
  background presets, metadata, rotation, fit/fill, shadows, and screenshot comparisons
- Versioned Automation recipes with exact targets, bounded concurrency, teardown,
  privileged-step approval, correlated local evidence, import/export, and cancellation
- Local Build Insights from user-selected `.xcresult` and DerivedData sources with
  12-month SQLite retention, full-history p50/p75/p95, seven-day averages, activity,
  and local JSON/CSV export. This initial foundation uses a local Node filesystem
  watcher and the supported public `xcresulttool build-results` view. That view
  does not report scheme, configuration, Xcode version, or reliable clean/incremental
  evidence, so those values remain explicitly unreported instead of being inferred.
  The Swift FSEvents adapter and versioned richer-metadata adapters remain deferred.
- A signed `rndevtools` local-agent CLI over a current-user `0600` Unix socket

PUMPD protocol v2 adds Simulator identity, explicit semantic elements and safe actions,
app-scoped network conditions, request/recipe correlation, and development camera
fixtures. Protocol v1 diagnostics remain accepted.

The app starts in a connection-ready state and shows real development devices as they connect. Set `RNDEVTOOLS_DEMO=true` when you deliberately want a simulated device for UI exploration. Multiple connected and recently disconnected devices are retained in the device picker.

## Run locally

From the monorepo root:

```bash
pnpm --filter @rndevtools/desktop dev
```

`dev` keeps the cross-platform connected-app diagnostics loop fast and does not
generate ignored native binaries. On macOS, a clean checkout should use the
Simulator-capable command at least once (and again after native changes):

```bash
pnpm --filter @rndevtools/desktop dev:simulator
```

That command verifies the pinned vendored SimSlim source, builds the Go and
Swift helpers for the current architecture, then starts Electron.

Electron 43 has no install hook, so `pnpm install` deliberately does not fetch
the runtime. The first `dev`, `package`, or `make` prints
`Downloading Electron binary...` and pulls roughly 110 MB from GitHub releases;
every later run reuses it. On an offline machine or behind a proxy, set
`ELECTRON_MIRROR` before that first run.

The mobile diagnostics client is mounted only alongside the internal dev-menu
host, and only in `development` builds — preview and production never dial the
broker.

The broker listens on `ws://127.0.0.1:47931/device` by default. Expo simulators discover loopback and the Expo development host automatically. If that port is occupied, both sides try the next nine ports.

Useful commands:

```bash
pnpm --filter @rndevtools/desktop quality
pnpm --filter @rndevtools/desktop check:dead-code
pnpm --filter @rndevtools/desktop build
pnpm --filter @rndevtools/desktop package
pnpm --filter @rndevtools/desktop make
```

`package` creates an unpacked, locally runnable app in `apps/devtools-desktop/release`. `make` creates the configured platform artifacts: DMG and ZIP on macOS, NSIS on Windows, or AppImage and DEB on Linux. Distribution releases still require the normal platform signing and notarization credentials.

Simulator mutations and native helpers are macOS-only. On Windows and Linux, the
connected-app diagnostics continue to work and Simulator workspaces present a bounded
unsupported state rather than attempting to execute bundled macOS tools.
The main process validates and atomically persists an explicitly selected Xcode
developer directory, restores it before helper discovery on restart, clears stale
selections safely, and forces capability rediscovery after a selection changes.

Native source gates and both-architecture builds:

```bash
pnpm --filter @rndevtools/desktop native:check
pnpm --filter @rndevtools/desktop native:build:all
pnpm --filter @rndevtools/desktop native:verify
pnpm --filter @rndevtools/desktop native:verify:capabilities
```

`native:check` requires Go 1.27, `govulncheck`, and the Xcode Swift toolchain. Generated
native binaries are ignored by Git and are rebuilt, hashed, signed, and verified by the
macOS package job.

## Connect a physical device

Loopback is the safe default. The broker itself speaks plaintext WebSocket, while the mobile client requires TLS for every non-loopback address. To connect a physical device, bind the broker to the computer's specific development-network address, put an authenticated TLS terminator or secure tunnel in front of it, and give the mobile development build the resulting `wss://` URL with a token of at least 16 characters:

```bash
RNDEVTOOLS_BIND_ADDRESS=<computer-lan-ip> RNDEVTOOLS_TOKEN=<long-random-token> pnpm --filter @rndevtools/desktop dev
EXPO_PUBLIC_DESKTOP_DEVTOOLS_URL='wss://<tls-endpoint>/device?token=<long-random-token>' pnpm --dir apps/mobile start
```

The desktop Diagnostics panel lists the broker endpoints. Treat a tokenized URL as a development credential and do not paste it into tickets or logs. `RNDEVTOOLS_PORT` changes the initial port; if it is occupied, the broker tries the next nine ports. An explicit mobile URL should include the selected port when the TLS endpoint does not use its protocol default. Set `EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED=true` to disable the development client.

Wildcard binding is intentionally a second opt-in. If a local setup truly requires `0.0.0.0` or `::`, also set `RNDEVTOOLS_ALLOW_WILDCARD=true`; prefer an exact interface address because wildcard binding can include VPN and other unintended adapters. Never expose the plaintext broker directly to an untrusted network.

Diagnostic payloads are metadata-only by default. For a local Metro development session that deliberately needs sanitized query values and HTTP bodies, set `EXPO_PUBLIC_DEVTOOLS_CAPTURE_PAYLOADS=true`. The flag is ignored outside `__DEV__`; assume any opted-in payload can contain application data and keep the connection local and temporary.

## Security and privacy boundaries

- The Electron renderer runs sandboxed with context isolation, no Node integration, a Content Security Policy, denied popups/navigation, and a frozen preload bridge.
- Packaged binaries disable Electron's Node and inspect escape hatches, require ASAR loading, and enable embedded ASAR integrity validation.
- The broker binds only to loopback unless LAN access is explicitly enabled with a sufficiently long token.
- Connection count, pre-parse message rate, 16 MiB mobile snapshot envelopes at the broker (the mobile client additionally caps its own outgoing snapshot at 8 MiB), aggregate retained snapshot bytes, diagnostic history, and renderer state broadcasts are bounded.
- Incoming messages and renderer actions are schema-validated. Mobile actions are additionally constrained to per-tool command allowlists.
- Console and network payloads use bounded, redacted collectors; query data and HTTP bodies are opt-in even in development. Secure storage values never cross the bridge.
- Zustand and component inspection use explicit registries; there is no global store or React-tree crawl.
- Restore points contain only sources declared safe to restore. A restore attempts rollback from a safety copy if a source fails, but independent state adapters cannot provide true atomic transactions.
- Recently disconnected sessions are retained for 24 hours for comparison, in memory only.
- Simulator commands always resolve a fresh canonical UDID and use fixed executables,
  argument arrays, minimal child environments, bounded output/timeouts, and per-target
  mutation serialization. They never traverse the mobile WebSocket.
- Simulator media is stored under the app data directory and served only through opaque
  `rndevtools-capture://` IDs. Renderer APIs never accept or return filesystem paths.
- SimSlim mutations are off by default. Destructive actions and experimental mutations
  use short-lived confirmations bound to the exact sender, target, and normalized payload.
  The signed Swift host additionally authenticates the packaged Electron parent and gives
  the signed Go helper a one-shot operation/UDID/exact-request authorization on inherited
  FD 3. A private marked FD 4 control pipe handles graceful cleanup and rollback without
  relying on process-signal delivery. Direct, unsigned-development, and ad-hoc helper mutation attempts fail closed;
  read-only inspection remains available.
- Build artifacts, captures, process data, recipes, and evidence remain local. Build source
  paths stay in Electron main and never cross the preload boundary.

This remains an internal development tool. Do not enable its mobile client in release builds or expose the LAN broker on an untrusted network.

## HeroUI Pro installation

HeroUI core and HeroUI Pro are intentionally used together. Pro supplies the dense data-grid, native select, and empty-state primitives; core supplies the remaining controls. A clean install must be authenticated for the licensed Pro package. Developer machines can use the HeroUI CLI login, while CI should provide its HeroUI auth token through the secret environment rather than committing credentials.

## Architecture

```text
PUMPD mobile dev build ── WebSocket protocol v1/v2 ── DesktopBroker
                                                        │
HeroUI renderer ── frozen, typed preload bridges ── Electron main
                                                        ├── fixed xcrun simctl adapter
                                                        ├── signed Go SimSlim helper
                                                        ├── signed Swift native host
                                                        ├── capture / recipe / build stores
                                                        └── private local-agent socket
```

The wire contract is versioned and its device/snapshot DTO is shared by the mobile
projector and desktop Zod boundary. Protocol v2 features are capability-gated; v1 remains
available for the original diagnostics. Tool snapshots are complete, atomic replacements;
a client that omits a projection is rejected so stale and fresh state cannot be mixed.

ScreenCaptureKit live mirroring/audio, the whole-Simulator Network Extension, and
arbitrary-app XCTest accessibility are shown as capability-gated advanced providers. They
are not silently approximated: raw `simctl io` capture, PUMPD app-scoped network profiles,
and PUMPD semantic actions remain the supported fallbacks until those separately signed,
permissioned providers are available.
