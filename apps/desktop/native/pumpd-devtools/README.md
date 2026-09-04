# PUMPD Devtools local CLI

`pumpd-devtools` is a first-party, standard-library-only macOS CLI for local
agents and scripts. It never opens a TCP socket, discovers a network endpoint,
invokes a shell, accepts a socket override, or removes a stale socket.

The production binary resolves the current OS account and connects only to:

```text
~/Library/Application Support/PUMPD Devtools/agent/pumpd-devtools.sock
```

Before connecting it requires both a real private parent directory and a real
Unix socket owned by the current user, with no group or other permissions on
either. Each connection writes one UTF-8 JSON line no larger than 256 KiB and
reads one JSON line no larger than 512 KiB. Both sides use the exact protocol
string `pumpd-devtools/1`.

## Envelope

```json
{"protocol":"pumpd-devtools/1","id":"cli-0123456789abcdef0123456789abcdef","command":{"kind":"doctor"}}
```

The response is either:

```json
{"protocol":"pumpd-devtools/1","id":"cli-0123456789abcdef0123456789abcdef","ok":true,"result":{}}
```

or:

```json
{"protocol":"pumpd-devtools/1","id":"cli-0123456789abcdef0123456789abcdef","ok":false,"error":{"code":"desktop_unavailable","message":"...","retryable":true,"recovery":"..."}}
```

## Commands and input

Commands are `doctor`, `simulators`, `apps`, `screen`, `elements`, `act`,
`wait`, `capture`, `record`, `network`, `recipe`, `jobs`, and `slimming`.
Run `pumpd-devtools <command> --help` for structured flags. An optional JSON
command object may be piped on standard input; flags may add different fields,
but redefining a stdin field is rejected. `slimming` exposes only the read-only
`status`, `preview`, `doctor`, and `verify` operations. `act` is limited to the
desktop service's explicit unattended-action allowlist.

`doctor` returns a bounded `connectedSessions` list. Use a returned `deviceId`
with `screen`, `elements`, `act`, `wait`, or `network` when an older mobile
protocol has not reported its Simulator UDID.

The CLI prints one compact JSON response. Exit codes are stable:

- `0`: success
- `2`: invalid arguments
- `3`: desktop app unavailable or stale/unsafe socket
- `4`: deadline exceeded
- `5`: transport or response-protocol failure
- `6`: typed server rejection
- `7`: internal CLI failure

## Provenance

The implementation is original AVAD Technologies code. It uses only the Go
1.27 standard library and contains no SimSlim source or catalog data. Go runtime
and standard-library attribution is reproduced in
`apps/devtools-desktop/THIRD_PARTY_NOTICES.md`. See `PROVENANCE.md` for the full source,
dependency, build, and release record.
