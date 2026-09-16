# Contributing

Thanks for looking at RN Devtools.

## Setup

```sh
pnpm install
pnpm quality
```

`packages/core` and `packages/react-native` build with no special access. The
Electron app in `apps/desktop` needs a HeroUI Pro license and a
`HEROUI_AUTH_TOKEN` to install its renderer dependencies, plus Go, Swift, and
`govulncheck` for the native helpers.

CI cannot run the desktop job for pull requests from forks, because forked PRs
cannot read repository secrets. If your change touches `apps/desktop`, say so in
the PR and a maintainer will run that job.

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
