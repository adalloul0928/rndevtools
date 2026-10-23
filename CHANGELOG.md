# Changelog

## 0.2.0 (unreleased)

### `@rndevtools/core`, `@rndevtools/react-native`

- **Breaking:** query simulation modes now register `{ apply, release }` instead
  of returning cleanup after applying. Failed applies are undone immediately;
  failed cleanup stays available for an explicit retry. See the core README's
  migration example.

- Scenario preflight results are normalized, validated and detached before any
  mutation, so durable recovery checkpoints can be loaded after restart.

- Offline now blocks instrumented requests with untrusted init dictionaries
  without inspecting them. Other profiles report unsupported request boundaries
  instead of silently bypassing the selected conditions.
- Clearing captured requests removes the confirmed set while preserving new
  requests and their body readers that arrived during the dialog.

- Preserve app writes made during asynchronous Zustand patch validation.
  A stale or rejected edit no longer restores an old state before its own
  mutation has started. Validators must not mutate the store.
- Network capture labels uninspected request methods `UNKNOWN` and unread or
  opaque response statuses with a neutral dash instead of inventing GET / OK.
- Align odd-offset UTF-16 bytecode before decoding to avoid a Linux Node 24.21
  native-memory abort without dropping odd-offset marker or secret checks.

- Redact common credential aliases, Unicode-escaped JSON keys, provider/cloud
  tokens, and complete or truncated private-key blocks in diagnostic capture.
  Runtime token patterns now share one source with the public-content check.

- **Breaking:** the image overlay no longer reads
  `EXPO_PUBLIC_IMAGE_OVERLAY_ORIGIN` or `EXPO_PUBLIC_SUPABASE_URL`. Pass the
  hosts it may download from to `configureImageOverlay({ allowedRemoteHosts })`
  instead; with none, remote images are refused.
- **Breaking:** the storage adapters' default ids are now `async-storage` and
  `secure-store`, not `example-async-storage` and `example-secure-store`.
  `createAsyncStorageDevtoolsAdapter` and `createSecureStoreDevtoolsAdapter`
  take `{ id, title, description }` options; pass `id` to keep an old one.
- **Breaking:** `withDevtoolsPruning` matches imports by the file they resolve
  to, so the alias, the relative path `babel-plugin-module-resolver` rewrites
  it to, an explicit extension and an `/index` import all get the stub.
  Previously an app using that plugin kept devtools reachable in release
  bundles. A `path` or stub that names no file, or an alias entry without
  `path`, now fails the config load, so configs that relied on alias-only
  matching must add `path`.
- **Breaking:** `withDevtoolsPruning` prunes every release bundle, meaning
  every bundle Metro builds with `dev: false`, by default. It reads Metro's own
  `dev` flag rather than an app variable, so a release build that never sets
  one, such as `expo run:ios --configuration Release` or an EAS profile
  without it, no longer ships devtools. `enabled: false` no longer turns
  pruning off, `enabled: true` still prunes development bundles too, and
  `keepInReleaseBundles: true` is the only way to keep devtools in a release
  bundle. Both options must be booleans, and `projectRoot` and `replace` are
  validated on every config load, development included.
- While pruning, an import that resolves into an `@rndevtools/*` package
  without going through a `replace` entry fails the build, naming the import
  and the module that made it, instead of adding the package to the bundle.
- **Breaking:** `verifyPrunedBundle(root, markers)` checks `markers` in
  addition to the default markers instead of replacing them, so a caller that
  passed its own shorter list now also fails on any default marker.
- Support Expo SDK 56 / React Native 0.85 hosts alongside SDK 57 / 0.86.
  Peer ranges are now `expo >=56 <58`, `react-native >=0.85 <0.87`,
  `react-native-worklets >=0.8 <1`, and `@expo/ui >=56 <58`.
- `@rndevtools/react-native/build-cache` is an Expo build cache provider that
  shares native builds between git worktrees, keyed by Expo's native
  fingerprint and the host toolchain (CPU architecture and, for iOS, the Xcode
  version). It claims its lock atomically, lets only one waiter take over an
  abandoned lock, and never replaces a stored binary with a later upload.
- `simulatorUdidFromPath` reads the Simulator's UDID from a path inside the
  app's container, so a host can report `simulatorUdid` and the desktop can
  link the session to its Simulator and lane. It returns `undefined` outside
  an iOS Simulator.
- The desktop client connects from an Android emulator. React Native's Android
  transport sent `Origin: http://10.0.2.2:<port>` to the emulator's host alias,
  and the broker refuses a non-loopback origin without a token, so every
  emulator was refused with a 403. The client now names `http://127.0.0.1:<port>`
  as the origin when it dials that alias.
- The desktop client runs only the actions the device advertises, addressed to
  its own `deviceId`. It paces its frames under the broker's limit, trims a
  collection over the desktop's row limit to its newest rows, and backs off
  after repeated broker policy closes. Each host action is bounded by its
  command's limit, `desktopActionTimeoutMs`, which the desktop outwaits by a
  short grace; an optional `actionTimeoutMs` can only shorten that.
  `runAction` receives an `AbortSignal` that aborts when the client stops
  waiting.
- While an owner source is bound, an authorization grant applies only when it
  names that source's live owner. A source that cannot be subscribed to
  revokes authorization and refuses grants until a working one is bound.
- The desktop client checks authorization again while an action runs, not only
  before it starts. A host that passes the new optional
  `subscribeToAuthorization` (the mirror's `subscribeToDevtoolsAuthorization`)
  has the action's `signal` aborted when authorization is revoked or changes
  owner, and the desktop is told the action failed with an unknown outcome.
  Without it, the client compares the grant when the action settles and gives
  the same answer if it changed, where a `storage.set` or `scenarios.execute`
  that finished after sign-out was reported `ok`. Signing out and back in as
  the same user during an action is only noticed with the subscription.
- `rndevtools-verify-bundle` fails when it finds no bundle file, instead of
  passing an empty or mistyped directory. It also scans `.bundle`,
  `.jsbundle`, `.mjs` and `.cjs` files, accepts a single bundle file, and
  prints how many files it checked.
- The verifier's default markers now detect the desktop client
  (`@rndevtools/react-native/desktop`), `@rndevtools/react-native/authorization`,
  `@rndevtools/react-native/adapters/storage`, the desktop protocol, the images
  panel, the image overlay, and `@rndevtools/core/redact`, `/serialize` and
  `/plugins/network-presentation` in production bundles.
  `@rndevtools/core/format` is not detected when imported alone: its formatters
  hold no string specific enough to look for.
- New `@rndevtools/core/plugins/image-overlay` entry point (the plugins barrel
  still re-exports it). `@rndevtools/react-native`'s image overlay, and so its
  package root, no longer loads the core plugins barrel.
- `setDevtoolsAuthorization` called with `undefined` or `null` now revokes
  before it throws a `TypeError`; it used to throw and leave the previous grant
  in force.
- `createAsyncStorageDevtoolsAdapter` and `createSecureStoreDevtoolsAdapter`
  throw a `TypeError` when given no store, instead of returning an adapter
  whose every read fails.
- The restore-point and scenario repositories refuse to write while their
  stored document could not be loaded. A failed `getItem` used to leave the
  repository empty, and the next capture or save then replaced everything that
  was stored with a document of one entry. Writes now reject with the load
  error. `ScenarioRepository` reports it as `loadError` on its snapshot and
  through `subscribeToLoadError()`, which fires with every change to the
  repository, and `getLoadError()`. `reload()` reads the document again behind
  any queued write. `discardStoredData()` deletes it on purpose, and only while
  the load error still stands, so a confirmation given before a successful
  retry cannot destroy what that retry loaded. The restore-points panel shows
  the error with Retry and Discard controls, and the plugin exposes
  `getLoadError()`, `reload()` and `discardStoredData()`.
- `rndevtools-verify-bundle --forbid-loopback-urls` and
  `--preset supabase-local` fail a release bundle that still carries a
  loopback URL or a local Supabase key.
- `rndevtools-verify-bundle` runs when invoked through a package manager's
  `node_modules/.bin` symlink, including under `--preserve-symlinks-main`.
  Previously the main-module guard never matched and the command exited 0
  without scanning.
- `rndevtools-verify-bundle` reads Hermes bytecode (`.hbc`, `.bundle` and
  `.jsbundle`) as bytes and searches a marker as UTF-8 and as UTF-16LE, and
  decodes the file as UTF-8 and as UTF-16LE from either byte alignment for
  `--forbid-loopback-urls` and `--preset supabase-local`. Hermes stores a
  string literal with any non-ASCII character as UTF-16, so a non-ASCII
  `--marker`, or an ASCII one inside such a literal, passed as clean before.
  The preset also finds a service-role token that Hermes stores right after
  another token; it read the first token's signature into the second token's
  header and missed it. The example app's `verify:bundle` also exports an
  unpruned bundle and fails unless the verifier fails on it.
- The storage plugin redacts a value stored under a key whose name marks it
  sensitive (`refreshToken`, `session`, `email`…) as `[REDACTED]`; set
  `revealValues: true` on the adapter to show such values.
- Diagnostic redaction masks Supabase `sb_secret_` keys, passwords in
  connection URLs and compound secret names such as `SERVICE_ROLE_KEY`.
- Diagnostic sanitization summarizes typed arrays and DataViews as
  `{ type, byteLength }` instead of index-keyed objects, and reads only the
  entries it keeps, of a Map or a Set too. Of an error it reads only `name`,
  `message` and `stack`, and a String object counts as its text, where it
  listed a key per index. A symbol's description is redacted.
- Diagnostic sanitization hides the value of a Map entry whose key is a
  credential name, as it hides the value of such an object field; 0.1.x kept
  `new Map([['password', 'hunter2']])` in clear.
- Diagnostic sanitization bounds its work. It charges one projection for
  every value it visits, holes, accessors and values without text such as
  `undefined` included, for every key it lists, for every code unit it tests
  or redacts, and for every code unit of a key it copies again. Once 4 Mi code
  units are charged, each later string, object, symbol or bigint is stored as
  `[Value omitted: input limit]`, and each later key longer than 1 Ki code
  units as `[Key omitted: input limit]`. A string longer than 1 MiB and
  64 KiB is redacted through a bounded window, at most 2.32 Mi code units,
  and cut to that size, and a bigint of more than 1,024 digits is omitted
  instead of converted. 0.1.x visited an object that many paths share once
  per path, and redacted every string and converted every bigint whole, so
  its work grew with the value without limit. Listing the keys of one object
  still costs time in proportion to its size.
- `diagnosticErrorText` redacts the text of a thrown value through the same
  bounded window and keeps up to 1 MiB and 64 KiB of it, and gives
  `[Value omitted: input limit]` for a bigint of more than 1,024 digits.
  0.1.x redacted the whole text and converted every bigint, so its work grew
  with the value without limit.
- Diagnostic sanitization and the Console plugin redact the keys of a logged
  object with the rules they apply to its values, through the same bounded
  window, and cut them to 1 KiB. 0.1.x stored keys verbatim, so a map keyed by
  email addresses or connection URLs kept them in clear. Keys that redaction
  or the cut makes equal are numbered, as `[REDACTED EMAIL]` and
  `(2) [REDACTED EMAIL]`; the number leads, so that a second redaction does
  not read it as the value of a key that ends in `token:`. Whether a value is
  hidden still depends on its key as logged, so such a map keeps its values;
  a key longer than 64 Ki code units hides its value.
- `DevtoolsEventStore` normalizes the attributes of an event the same way. It
  keeps the first 64 attributes in the order it lists them, stores them in key
  order, and reads only their descriptors, where 0.1.x read every descriptor
  and sorted every key to keep the 64 that sorted first. It redacts each key
  through the bounded window and cuts it to 512 bytes, numbers keys that
  trimming, redaction or the cut makes equal, which 0.1.x dropped, and tests
  whether a value is hidden on its key as logged, where 0.1.x tested the
  redacted key and so hid the value of an attribute keyed by an email
  address. A key numbered without being redacted, as when trimming makes two
  keys equal, marks the event truncated, as dropping it did. Every text of an
  event is redacted through a bounded window, and the attributes of one event
  share a work budget of 2 Mi code units, after which strings are stored as
  `[Value omitted: input limit]` and keys longer than 512 code units as
  `[Key omitted: input limit]`.
- Email and JWT redaction run in linear time; on a long base64url or dotted
  run they took time quadratic in its length.
- Diagnostic redaction masks a quoted credential that ends right after a
  backslash or holds a backslash before a line break; both used to stay in
  clear.
- Diagnostic redaction matches a quoted value in steps of at most 1,024
  escapes, so its regexp stack stays bounded however long the value is;
  0.1.x threw a `RangeError` on a quoted value of 8 Mi code units.
- Redacting redacted text changes nothing: a value that is only a marker, an
  ellipsis that a cut appended, or both, is left as it is. So the `…` with
  which the Console plugin's windows end an attribute survives the
  serializer's second redaction, where `token=[REDACTED]…` became
  `token=[REDACTED]`. A `Bearer` value in an assignment is redacted as far as
  any other value; its tail after the token's characters used to be kept.
- Diagnostic redaction masks the password of a URL whose user is an email
  address, and a URL password that only starts like a marker, such as
  `[REDACTEDhunter2` or `[REDACTED]@hunter2` before the address; only a
  password that is exactly a marker is left as it is.
- Diagnostic redaction masks the credentials after any scheme word of an
  `Authorization` value in free text. They are one token with its `=`
  padding, as in `authorization: Basic …` or `Authorization: Token …`, or a
  list of parameters that runs to the end of the line, as Digest's and
  AWS4-HMAC-SHA256's do, when a comma, an `&` or the end of the line follows
  the value of a first `name=value`, after any spaces or tabs. That value is
  a token that starts with an ASCII letter, a digit or one of `_+/%.~-` and
  holds no white space, comma, `&`, `"` or `'`, a quoted string, raw or
  JSON-escaped, that holds at most 1,024 escapes, or a raw one that ends at
  its first quote, whatever backslashes it holds; after a JSON-escaped one,
  the quote that closes the JSON string ends the line too. 0.1.x masked only
  the scheme word of any scheme but `Bearer`, so the base64 of
  `user:password` stayed in clear.
- The Console plugin redacts a bounded window of each message, stack and
  attribute string instead of the whole value, so a multi-megabyte log no
  longer drops its event, and each text of an event outside its attributes
  costs at most 1.9 Mi code units of redaction however long it is, where
  0.1.x redacted every text whole. A secret of up to 64 Ki code units that a
  window edge cuts is never stored unredacted. A longer secret that both
  edges of a window pair cut can be stored in part, where 0.1.x redacted it.
  When redaction shortens the text so much that the largest window cannot
  fill the field's byte limit, the stored text stops early and is marked
  truncated.
- The attributes of one console event share a work budget of 2 Mi code
  units, charged for every value, hole and accessor read, values without text
  such as `undefined` included, for every key listed, for every code unit of
  a string or key tested or redacted, and for every code unit of a key copied
  again. Strings and objects past it are stored as
  `[Value omitted: input limit]`, and keys longer than 1 Ki code units past
  it as `[Key omitted: input limit]`. An object of more than 100 keys or an
  array of more than 50 entries now marks the attributes truncated; 0.1.x
  left the entries past those caps out silently. A long quoted attribute,
  nested or passed as the attributes, no longer drops the event. The plugin
  reads a String object as its text, and only the fields of an event, error
  and source location that it uses, where it read every descriptor.
- `createConsoleMethodSource` prints, but does not capture, a log made while
  one of its listeners is handling a log, instead of recursing until the
  stack overflows.
- The desktop client fits every snapshot to every size and range bound the
  desktop validates before it sends it, with the new `fitDesktopSnapshot` of
  `@rndevtools/core/desktop-protocol`. It used to trim only the top-level
  lists of `RNDEVTOOLS_SNAPSHOT_LIMITS`, so a nested list (10 of its 30 limits
  are nested, such as a component's `sourceFiles`), a text or a number over
  its bound made the broker close the socket and the device reconnect in a
  loop. Core keeps up to 10,000 performance samples where the desktop takes
  1,500, and does not cap a scenario's warnings where it takes 100. A
  top-level list over its cap keeps its last rows, and a list inside a row
  keeps its newest rows if it is chronological and its first if it is
  ordered. A text is cut without splitting a surrogate pair, a number is
  clamped into its range, and a map keeps its first fields. A query
  simulation's active entry, a camera fixture, a scenario variable default or
  a persona identifier that disagrees with the rest, which the schema would
  reject, is dropped or reset. The identity history keeps the sessions that
  started latest, whichever end of the list a host puts them at, and a cut of
  performance samples raises `droppedSampleCount` by the samples removed, so
  the performance panel says that samples were dropped. A value of the wrong
  shape, such as an empty identifier, is still left to the schema. One text
  over its limit no longer keeps a snapshot from being sent. The client's
  warning names the first six changes and counts the rest. The bounds the schema applies beyond
  `RNDEVTOOLS_SNAPSHOT_LIMITS` are exported as
  `RNDEVTOOLS_SNAPSHOT_EXTRA_LIMITS`, `RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS` and
  `RNDEVTOOLS_SNAPSHOT_NUMBER_LIMITS`.

### Desktop app

- Recreate rechecks the selected Supabase branch after acquiring its lock and
  before each start attempt; a checkout cannot redirect a queued recreation.

- Fit Network, Storage, and React Query grids to narrow panes. Secondary
  columns hide while their values remain available in the detail pane.
- Show the selected Simulator state in the sidebar dot; a shutdown device no
  longer appears green just because the helper is available.
- Command deadlines settle even when an exited child's descendants retain its output pipes or a killed child never reports close.

- Added light and dark themes plus a persistent System / Light / Dark appearance
  setting. Main applies the stored theme before creating the window, and failed
  preference writes restore the previous selection.
- Added guided first-run setup and Get started progress that remembers completed
  tasks. Setup waits for repository discovery, reports action results in place,
  announces step changes, and confirms coding-agent configuration changes.
- Refined the sidebar, titlebar, Simulator lists and dialogs at the 1040x700
  minimum: scrollable tool navigation, visible grid selections, full names on
  hover, readable disabled actions, opaque notices, and consistent corner radii.
- Fixed Simulator crash-journal reconciliation and lane-start races so background
  work cannot steal a device or overwrite a completed mutation. Failed lane
  starts clean up their owned Metro process through PID verification.
- Generate the native-host version from the desktop package version and check
  it for drift. Rebuild local helpers after updating the desktop sources.
- End-to-end coverage uses the current demo names and explicitly checks both
  themes. Electron launch and graceful shutdown have bounded timeouts suitable
  for a busy development machine.
- Restyled every panel and the shell to a Vercel/Supabase-inspired system:
  one brand accent for active/positive states, blue reserved for information,
  hairline borders, dense typography.
- Disabled actions now explain why (missing device capability, invalid input).
- The broker waits for a device's answer to an action as long as the device may
  spend on that command, plus five seconds, from one table in
  `@rndevtools/core/desktop-protocol`. It used to give up after 8 seconds (30
  for restores and refetches) while the device client allowed 45, so a long
  scenario was reported as unacknowledged while the device finished it.
- Playwright end-to-end harness and per-panel specs against the demo device.
- The device snapshot schema reads its text, number and item bounds from
  `@rndevtools/core/desktop-protocol` instead of repeating them, and a test
  holds it to the client's `fitDesktopSnapshot`: it pushes every bounded field
  of a snapshot past its bound, then requires the schema to reject the
  snapshot as it stands and accept it fitted. No bound changed.
- Agent requests over the local socket now prove which process sent them. The
  CLI, its MCP server and its session-end hook send their own pid, the desktop
  checks that the process owns the connection, and it follows the process's
  parents to the Claude Code session that spawned it. A request that names
  another live session is refused with `agent_identity_mismatch`. Before, the
  session was whatever the request said it was, and a request that named none
  counted as the person at the desktop: `rndevtools lane up --udid` on a
  Simulator another agent had claimed took the claim over, and setting another
  session's id let `release --all` stop its lanes. Requests with no identity,
  may now use free Simulators only and cannot claim, release or take over a
  hold. Unverifiable claims (`agent_identity_unverified`), including shared-process
  Codex threads, synthetic MCP identities and ended sessions, cannot perform
  ownership-changing operations. Lane commands no longer accept an `agent` field.
- Background SimSlim status checks now take a Simulator's lease and skip one
  with a running job, never boot a shut-down Simulator (it shows as not
  inspected, not as clean), and update each Simulator's status on its own. A
  check could previously restart a Simulator that an apply, an erase or a lane
  had just shut down, and one that finished after an apply replaced the status
  the apply recorded, so disabling slimming soon afterwards could skip the
  restore.
- CI checks the desktop app on every pull request, forks included. A job that
  needs no HeroUI Pro license runs Biome, the main, preload and shared
  typecheck and tests, knip without its unused-devDependency check, and the
  script tests. The job that runs the full `quality` gate with HeroUI Pro
  (renderer typecheck and tests, the unused-devDependency check and the build)
  runs when `HEROUI_AUTH_TOKEN` is available and otherwise reports the
  missing verification in a notice and job summary. Desktop changes must
  pass the full local quality gate before merging when it skips.
- Forget restore point now works for a restore point whose Simulator has been
  deleted or whose helper is unavailable, so an interrupted SimSlim mutation
  can no longer leave a Simulator permanently marked "Check required". The
  SimSlim panel lists such restore points, each with its own Forget restore
  point button, and the app no longer requires the helper or the Simulator
  inventory for that one action; it still asks before running. Before, the
  action was refused as long as the helper was unavailable or the Simulator
  was missing from the inventory, and a restore point behind an unavailable
  helper was not shown at all.
- A local Supabase stack whose first start is still running when RN Devtools
  quits is now recorded before the CLI is spawned. When the restarted app
  adopts that start, it checks that the stack listens on 127.0.0.1 only and
  stops it if not, and stops it after the usual linger once nothing holds it,
  as for any other stack; a first start that failed meanwhile is marked
  interrupted, like a cancelled one. Before, the stack ran with no record, no
  loopback check and no automatic stop.
- An unheld local Supabase stack now gets its stop linger from the end of the
  job that started it, not from the moment its owner came up, so a long first
  start is no longer stopped as it ends. A start that RN Devtools adopts after
  a restart is still checked for 127.0.0.1 only when its record cannot be
  saved, and its job then fails with that error instead of passing as verified.
