# Changelog

## 0.2.0 (unreleased)

### `@rndevtools/core`, `@rndevtools/react-native`

- Support Expo SDK 56 / React Native 0.85 hosts alongside SDK 57 / 0.86.
  Peer ranges are now `expo >=56 <58`, `react-native >=0.85 <0.87`,
  `react-native-worklets >=0.8 <1`, and `@expo/ui >=56 <58`.
- `withDevtoolsPruning` now also matches the relative specifiers that
  `babel-plugin-module-resolver` emits for aliased imports. Previously an app
  using that plugin kept devtools reachable in release bundles.
- `rndevtools-verify-bundle` runs when invoked through a package manager's
  `node_modules/.bin` symlink. Previously the main-module guard never matched
  and the command exited 0 without scanning.

### Desktop app

- Restyled every panel and the shell to a Vercel/Supabase-inspired system:
  one brand accent for active/positive states, blue reserved for information,
  hairline borders, dense typography.
- Disabled actions now explain why (missing device capability, invalid input).
- Playwright end-to-end harness and per-panel specs against the demo device,
  plus a spec that verifies a real connected device.
