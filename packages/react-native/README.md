# @rndevtools/react-native

The React Native host runtime for [RN Devtools](https://github.com/adalloul0928/rndevtools).

`@rndevtools/core` owns the on-device panels and diagnostic plugins. This
package owns the glue an app needs to drive them: the desktop broker client,
the authorization mirror that gates privileged actions, adapters for storage
and camera fixtures, and the Metro mechanism that keeps all of it out of
release builds.

## Install

```sh
pnpm add -D @rndevtools/core @rndevtools/react-native
```

Both packages ship TypeScript source so your Babel pipeline compiles them —
Reanimated worklets in the panel UI have to be workletized by your app, not by
a prebuilt bundle. Metro handles this with no configuration. For Jest, add them
to `transformIgnorePatterns`:

```js
transformIgnorePatterns: [
  'node_modules/(?!((jest-)?react-native|@rndevtools/.*|expo(nent)?|@expo(nent)?/.*)/)',
],
```

## Connecting to the desktop app

The client discovers a loopback broker, publishes bounded snapshots, and
applies actions the desktop sends back. It knows nothing about your app: you
supply a host adapter, which is what makes it reusable.

```ts
import {
  getDevtoolsAuthorization,
  shouldStartDesktopClient,
  startDesktopClient,
} from '@rndevtools/react-native';

if (shouldStartDesktopClient({ isDevelopmentBuild: __DEV__ })) {
  startDesktopClient({
    host: {
      // Project your registered diagnostics into a snapshot payload.
      captureTools: (diagnostics) => buildToolsSnapshot(diagnostics),
      // Identify this device and build.
      createDeviceInfo: () => buildDeviceInfo(),
      // Apply one desktop-issued action. Throw to reject it.
      runAction: async (action) => applyAction(action),
      // The client refuses actions while this reports disabled.
      getAuthorization: getDevtoolsAuthorization,
    },
  });
}
```

`shouldStartDesktopClient` stays false under Jest and honours the
`EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED` kill switch. Pass
`isDevelopmentBuild: false` for anything that reaches a tester's device:
the broker socket is unauthenticated and belongs only on a machine the
developer controls.

## Authorization

Privileged actions are gated by a single mirror the app owns. Bind it to your
auth source so a user change revokes synchronously:

```ts
import {
  bindDevtoolsAuthorizationOwnerSource,
  setDevtoolsAuthorization,
} from '@rndevtools/react-native';

bindDevtoolsAuthorizationOwnerSource({
  getOwnerId: () => session.userId,
  subscribe: (listener) => session.subscribe(listener),
});

setDevtoolsAuthorization({ enabled: isStaff, ownerId: session.userId });
```

## Keeping devtools out of production

Two pieces, both required. `withDevtoolsPruning` cuts the module graph at
resolution time so devtools code is never reachable:

```js
// metro.config.js
const { withDevtoolsPruning } = require('@rndevtools/react-native/metro');

module.exports = withDevtoolsPruning(config, {
  enabled: process.env.APP_VARIANT === 'production',
  projectRoot: __dirname,
  replace: [
    {
      module: '@/features/dev-menu/dev-menu-host',
      path: 'src/features/dev-menu/dev-menu-host',
      stub: 'src/lib/dev-menu-host-disabled.tsx',
    },
  ],
});
```

Each stub must export the same shape as the real module with no-op bodies.
Then prove it over a real export, in CI:

```sh
npx expo export --platform ios --output-dir ./build
npx rndevtools-verify-bundle ./build --marker "My Debug Panel"
```

The verifier greps for devtools markers in the emitted JavaScript and fails the
build if any survive. The `--marker` flag adds strings specific to your own
panels.

Two opt-in checks catch a release bundle that was built against a developer's
machine, for example after a local backend's URL and keys were copied into a
`.env` file that the export also reads:

```sh
npx rndevtools-verify-bundle ./build --forbid-loopback-urls --preset supabase-local
```

- `--forbid-loopback-urls` fails on literal `http(s)://` and `ws(s)://` URLs
  whose host is `localhost`, `*.localhost`, `127.x.x.x` or `[::1]`.
- `--preset supabase-local` fails on Supabase secret keys (`sb_secret_…`), on
  JWTs whose payload carries `role: service_role`, and on JWTs issued by a
  local Supabase stack (`iss: supabase-demo`), whose default keys every local
  stack shares. A hosted project's URL and publishable or anon key pass.

A failure names each file and what was found, never the key itself. An
unknown flag or preset fails the run instead of skipping its check.

## Sharing native builds across worktrees

Running several git worktrees of one app side by side (the desktop app's
*lanes*) means several `expo run:ios` builds of the same native shell. The
build cache provider stores a finished Simulator or emulator binary once,
keyed by Expo's native fingerprint, and hands it to any worktree whose
fingerprint matches. A JavaScript-only branch installs in seconds instead of
rebuilding for twenty minutes, and two worktrees that miss at the same time
produce one build: the second waits for the first.

Expo loads providers from a dynamic config, so add an `app.config.js` next to
your `app.json`:

```js
// app.config.js
module.exports = ({ config }) => ({
  ...config,
  experiments: {
    ...config.experiments,
    buildCacheProvider: {
      plugin: '@rndevtools/react-native/build-cache',
      // options: { cacheDirectory: '~/Library/Caches/my-app/native' },
    },
  },
});
```

Then build as usual: `npx expo run:ios --device <udid> --no-bundler`. The
first worktree builds and uploads; later ones with the same fingerprint are
installed from
`~/Library/Caches/rndevtools/native/<platform>/<configuration>/<toolchain>/<hash>/`
(`RNDEVTOOLS_BUILD_CACHE_DIR` or the `cacheDirectory` option relocates it).
Entries are split by platform, build configuration, and toolchain (CPU
architecture plus, for iOS, the `xcodebuild -version` output), so a Release
binary is never installed for a Debug run and an Xcode upgrade never serves a
build from the old SDK. Delete the directory to start clean; there is no
eviction.

`@expo/fingerprint` decides what counts as a native change. If your project
has native inputs outside the usual places, configure them in
[`.fingerprintignore` / `fingerprint.config.js`](https://docs.expo.dev/versions/latest/sdk/fingerprint/)
rather than here; this provider only stores what Expo hands it.

## Adapters

`createAsyncStorageDevtoolsAdapter` and `createSecureStoreDevtoolsAdapter`
wire your storage into the storage panel. The secure-store adapter takes an
explicit key manifest: it never enumerates the keychain, so only keys you list
are ever readable. `devtoolsCameraProvider` serves desktop-pushed image
fixtures to an instrumented development camera.

## Image overlays

`imageOverlay` holds a reference image, such as a design export, for your app
to draw over its own screens. Local files and clipboard images need no setup.
Remote images are downloaded only from hosts you allow, and none are allowed
by default:

```ts
import { configureImageOverlay } from '@rndevtools/react-native';

configureImageOverlay({
  // Hostnames or HTTPS URLs; unset, blank and non-HTTPS entries are ignored.
  allowedRemoteHosts: ['designs.example.com', process.env.EXPO_PUBLIC_ASSET_URL],
});
```

Each call replaces the previous list. Earlier versions also trusted the hosts
in `EXPO_PUBLIC_IMAGE_OVERLAY_ORIGIN` and `EXPO_PUBLIC_SUPABASE_URL` without
being asked; pass those variables here to keep that behaviour.

## License

MIT
