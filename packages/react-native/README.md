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

## Adapters

`createAsyncStorageDevtoolsAdapter` and `createSecureStoreDevtoolsAdapter`
wire your storage into the storage panel. The secure-store adapter takes an
explicit key manifest: it never enumerates the keychain, so only keys you list
are ever readable. `devtoolsCameraProvider` serves desktop-pushed image
fixtures to an instrumented development camera.

## License

MIT
