# macOS desktop releases

The first supported public download is an Apple silicon DMG for macOS 14 or
later. Consumers open the DMG, drag **RN Devtools** into **Applications**, and
launch it. Node, pnpm, Go and the HeroUI Pro build license are not needed to
install that app. Simulator features still require Xcode and an installed iOS
Simulator runtime. Local Supabase uses the consuming repository's pinned CLI.

There is currently no published desktop release or Homebrew tap. The intended
download location is [GitHub Releases](https://github.com/adalloul0928/rndevtools/releases).
Do not advertise a download or a `brew install` command until that artifact or
tap actually exists. A Homebrew cask can follow a verified public DMG; it must
use the published versioned URL and its exact SHA-256, without Gatekeeper
exceptions.

## Public release prerequisites

- An Apple silicon Mac with Xcode, the repository's Node/pnpm versions, Go and
  the licensed HeroUI Pro dependency hydrated via `HEROUI_AUTH_TOKEN`.
- A **Developer ID Application** certificate and its private key. An **Apple
  Development** identity is only for a local candidate and cannot satisfy this
  release gate. Set `CSC_NAME` to the certificate's SHA-1 fingerprint from
  `security find-identity -v -p codesigning` to select an installed identity;
  `CSC_LINK` and
  `CSC_KEY_PASSWORD` provide a private P12 on CI. Keep these in the local
  Keychain or release secrets.
- `APPLE_TEAM_ID` set to the certificate's organizational unit (team ID).
  The same team must sign Electron and all three native executables. The Go
  simulator helper compiles that team into its parent-attestation requirement.
- Validated Apple notarization credentials stored with `notarytool`. Locally,
  run `xcrun notarytool store-credentials RNDevtools-notary` and follow its
  prompts, then set `APPLE_KEYCHAIN_PROFILE=RNDevtools-notary`. An optional
  `APPLE_KEYCHAIN` selects a nondefault Keychain. Never commit credentials.
- A clean committed checkout. A tag release must use `v` plus the desktop
  package version, for example `v0.2.0`. Keep npm package versions aligned
  before tagging.

Apple requires Developer ID, hardened runtime and secure timestamps for
[notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
This repository uses the signing keys under `mac` in
[electron-builder v26](https://www.electron.build/v26/docs/mac/), rather than
the different v27 configuration layout. Electron receives only the JIT
entitlement needed by the current runtime; library validation remains enabled.

## Build and verify

From the repository root, with the credentials above in the environment:

```sh
pnpm install --frozen-lockfile
pnpm check:public
pnpm --filter @rndevtools/desktop release:check
pnpm --filter @rndevtools/desktop quality
pnpm --filter @rndevtools/desktop release:mac
```

The release command rebuilds the native helpers and app, requires a Developer
ID identity before helper signing, and packages the app with hardened runtime.
It verifies the app and helper signatures, matching team IDs and compiled Go
team pin, native integrity manifest, minimum macOS version and Electron fuses.
The app is notarized and stapled before the DMG is created. The DMG is also
signed, submitted to Apple, required to receive **Accepted**, and stapled.
Both must pass ticket validation and Gatekeeper assessment. Any failed check
stops the command. No command publishes anything.

Output under ignored `apps/desktop/release/public/`:

- `RN-Devtools-<version>-arm64.dmg`
- `release-manifest.json` recording version, architecture, signing team,
  notarization state and native source identity
- `SHA256SUMS.txt`, computed after the final ticket is stapled
- `mac-arm64/RN Devtools.app`, the exact packaged app for verification

On a separate test Mac, or with every existing RN Devtools process already
closed, run the cold-start check:

```sh
pnpm --dir apps/desktop native:verify:cold-start 'release/public/mac-arm64/RN Devtools.app'
```

It launches the actual signed bundle and requires a stable renderer. It
refuses to run alongside an existing RN Devtools process. Do not stop a user's
active lanes to run it. Before publication, also test the downloaded DMG on a
clean Mac under normal Gatekeeper settings, complete first-run permissions,
and check Simulator, Metro, native input and per-worktree Supabase flows.

Consumers can verify a downloaded release in its download directory:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

## GitHub Actions and publication

The Release workflow requires `HEROUI_AUTH_TOKEN`, `APPLE_TEAM_ID`,
`MAC_CERTIFICATE_P12`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID` and
`APPLE_APP_SPECIFIC_PASSWORD` as repository secrets. The P12 must hold a
Developer ID Application identity, not an Apple Development identity. The
workflow validates and stores notarization credentials in its ephemeral
runner's Keychain, runs the checks, and retains the verified DMG, manifest and
checksums as Actions artifacts.

Manual dispatch builds review artifacts only. A matching version tag also
prepares a **draft** GitHub release. Review the actual artifacts and clean-Mac
installation before explicitly publishing that draft. Tag runs retain the
existing npm publication job, after the desktop gate succeeds; it additionally
requires `NPM_TOKEN`. Manual dispatch does not publish npm packages.

## Local development candidate

When only an Apple Development identity is available, set `CSC_NAME` to that
installed identity and `APPLE_TEAM_ID` to its team, then run:

```sh
pnpm --filter @rndevtools/desktop release:mac:local
```

This creates `release/local-development/RN-Devtools-<version>-local-development-arm64.dmg`
with a signed app, integrity/fuse verification, a manifest stating
`notarized: false`, and checksums. It does not replace an installed app, launch
the app, submit anything to Apple or publish anything. It is a local build
candidate, not the public installer. Public distribution remains blocked
until a Developer ID Application certificate and notarization credentials
are available. Never relabel this candidate as a public release or weaken
Gatekeeper to install it on another Mac.
