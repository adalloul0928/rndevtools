# PUMPD Devtools Desktop

An isolated Electron app for inspecting a running PUMPD development build. The renderer uses React, HeroUI, HeroUI Pro, Tailwind CSS, and a restrained Vercel-inspired visual system. Electron owns the local device broker and exposes only a narrow, typed preload API to the renderer.

## Tools

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

The app starts in a connection-ready state and shows real development devices as they connect. Set `PUMPD_DEVTOOLS_DEMO=true` when you deliberately want a simulated device for UI exploration. Multiple connected and recently disconnected devices are retained in the device picker.

## Run locally

From the monorepo root:

```bash
pnpm --filter @pumpd/devtools-desktop dev
```

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
pnpm --filter @pumpd/devtools-desktop quality
pnpm --filter @pumpd/devtools-desktop check:dead-code
pnpm --filter @pumpd/devtools-desktop build
pnpm --filter @pumpd/devtools-desktop package
pnpm --filter @pumpd/devtools-desktop make
```

`package` creates an unpacked, locally runnable app in `apps/devtools-desktop/release`. `make` creates the configured platform artifacts: DMG and ZIP on macOS, NSIS on Windows, or AppImage and DEB on Linux. Distribution releases still require the normal platform signing and notarization credentials.

## Connect a physical device

Loopback is the safe default. The broker itself speaks plaintext WebSocket, while the mobile client requires TLS for every non-loopback address. To connect a physical device, bind the broker to the computer's specific development-network address, put an authenticated TLS terminator or secure tunnel in front of it, and give the mobile development build the resulting `wss://` URL with a token of at least 16 characters:

```bash
PUMPD_DEVTOOLS_BIND_ADDRESS=<computer-lan-ip> PUMPD_DEVTOOLS_TOKEN=<long-random-token> pnpm --filter @pumpd/devtools-desktop dev
EXPO_PUBLIC_DESKTOP_DEVTOOLS_URL='wss://<tls-endpoint>/device?token=<long-random-token>' pnpm --dir apps/mobile start
```

The desktop Diagnostics panel lists the broker endpoints. Treat a tokenized URL as a development credential and do not paste it into tickets or logs. `PUMPD_DEVTOOLS_PORT` changes the initial port; if it is occupied, the broker tries the next nine ports. An explicit mobile URL should include the selected port when the TLS endpoint does not use its protocol default. Set `EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED=true` to disable the development client.

Wildcard binding is intentionally a second opt-in. If a local setup truly requires `0.0.0.0` or `::`, also set `PUMPD_DEVTOOLS_ALLOW_WILDCARD=true`; prefer an exact interface address because wildcard binding can include VPN and other unintended adapters. Never expose the plaintext broker directly to an untrusted network.

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

This remains an internal development tool. Do not enable its mobile client in release builds or expose the LAN broker on an untrusted network.

## HeroUI Pro installation

HeroUI core and HeroUI Pro are intentionally used together. Pro supplies the dense data-grid, native select, and empty-state primitives; core supplies the remaining controls. A clean install must be authenticated for the licensed Pro package. Developer machines can use the HeroUI CLI login, while CI should provide its HeroUI auth token through the secret environment rather than committing credentials.

## Architecture

```text
PUMPD mobile dev build
  explicit diagnostic adapters + allowlisted actions
                    │ WebSocket protocol v1
                    ▼
Electron main process ─ local HTTP/WebSocket broker
                    │ validated IPC
                    ▼
Sandboxed preload ─ frozen typed bridge ─ React renderer
```

The wire contract is versioned and its device/snapshot DTO is shared by the mobile projector and desktop Zod boundary. A device with a different protocol version is rejected rather than partially interpreted. Tool snapshots are complete, atomic replacements; a client that omits any tool projection is rejected so stale and fresh diagnostic state can never be mixed.
