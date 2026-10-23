# Contributing

Thanks for looking at RN Devtools.

## Setup

```sh
pnpm install
pnpm quality
```

`packages/core` and `packages/react-native` build with no special access. The
Electron app in `apps/desktop` needs a HeroUI Pro license and a
`HEROUI_AUTH_TOKEN`. Without one `pnpm install` still succeeds, but the
licensed package is not hydrated, so the desktop typecheck and build fail on a
missing module. The native helpers need Go, Swift, and `govulncheck`, and no
license.

When `HEROUI_AUTH_TOKEN` is missing, including on pull requests from forks,
CI skips the licensed desktop gate (the renderer typecheck and tests, the
unused-devDependency check and the Electron build) and says so in a notice.
Everything else runs: both npm packages, the example app, the desktop app's
Biome, main-process, preload and shared typecheck and tests, knip without its
unused-devDependency check, the script tests, the full Go helper gate and a
Swift build. The Swift tests hang on GitHub's hosted runners, so they run
locally (`pnpm --filter @rndevtools/desktop native:check:swift`) or in the
manual "Swift tests" workflow. If your change touches the renderer, the build
or the dependencies of `apps/desktop`, say so in the PR and a maintainer will
run `pnpm --filter @rndevtools/desktop quality` locally before merging.

## Ground rules

- Nothing product-specific. This is installed by teams whose app you have never
  seen: schemes, bundle identifiers, vendor headers, and storage namespaces are
  options with neutral defaults, never literals.
- Add focused tests for behaviour changes and run the affected workspace's
  `quality` gate.
- Conventional Commit messages, small PRs.
- Do not touch `apps/desktop/native/rndevtools-sim-helper/vendor/**` or the
  SHA-256 manifests beside it. They are byte-anchored; see that directory's
  `PROVENANCE.md` for the update procedure.

## Reporting a security issue

Please do not open a public issue. Use GitHub's private vulnerability reporting
on this repository instead.
