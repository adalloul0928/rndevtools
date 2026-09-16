# `rndevtools` provenance

`rndevtools` is original first-party AVAD Technologies code written for the
RN Devtools desktop app. No source, generated code, protocol definitions, or
catalog data was copied from SimSlim, Buoy, RocketSim, or another third-party
project.

The wire contract was developed alongside PUMPD's TypeScript desktop service
and is intentionally fixed to `rndevtools/1`. The Go module has no external
module dependency: `go list -m all` must return only
`github.com/adalloul0928/rndevtools-cli`. Its only incorporated
third-party material is the Go runtime and standard library; the applicable BSD
notice is reproduced in `apps/devtools-desktop/THIRD_PARTY_NOTICES.md` and is packaged
with the application.

Release binaries are built from this directory with `CGO_ENABLED=0`,
`GOOS=darwin`, and an explicit `GOARCH` of `arm64` or `amd64`. The build script
embeds the desktop app version and a clean or dirty-aware source identity, then
records the unsigned development binary's SHA-256 digest and byte size in the
native-resource manifest. During packaging, the after-pack hook first verifies
that manifest, signs each packaged copy with the app's resolved identity,
atomically refreshes only the packaged manifest's sizes and hashes, and verifies
the signed bytes again before the outer app is sealed. Runtime downloads and
binary replacement are not supported.

When the contract changes, update the Go protocol, its tests, the matching
TypeScript service/schema tests, and this record in the same change. A breaking
wire change requires a new protocol string rather than silently widening
`rndevtools/1`.
