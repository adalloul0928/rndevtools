# RN Devtools local CLI

`rndevtools` is a first-party, standard-library-only macOS CLI for local
agents and scripts. It never opens a TCP socket, discovers a network endpoint,
invokes a shell, accepts a socket override, or removes a stale socket.

The production binary resolves the current OS account and connects only to:

```text
~/Library/Application Support/RN Devtools/agent/rndevtools.sock
```

Before connecting it requires both a real private parent directory and a real
Unix socket owned by the current user, with no group or other permissions on
either. Each connection writes one UTF-8 JSON line no larger than 256 KiB and
reads one JSON line no larger than 512 KiB. Both sides use the exact protocol
string `rndevtools/1`.

## Envelope

```json
{"protocol":"rndevtools/1","id":"cli-0123456789abcdef0123456789abcdef","command":{"kind":"doctor"}}
```

The response is either:

```json
{"protocol":"rndevtools/1","id":"cli-0123456789abcdef0123456789abcdef","ok":true,"result":{}}
```

or:

```json
{"protocol":"rndevtools/1","id":"cli-0123456789abcdef0123456789abcdef","ok":false,"error":{"code":"desktop_unavailable","message":"...","retryable":true,"recovery":"..."}}
```

## Commands and input

Commands are `doctor`, `simulators`, `apps`, `screen`, `elements`, `act`,
`wait`, `capture`, `record`, `network`, `recipe`, `jobs`, `slimming`, `lane`,
`native`, `agents`, `claim`, `release`, and `input`. Run `rndevtools <command> --help` for structured flags. An optional JSON
command object may be piped on standard input; flags may add different fields,
but redefining a stdin field is rejected. `slimming` exposes only the read-only
`status`, `preview`, `doctor`, and `verify` operations. `act` is limited to the
desktop service's explicit unattended-action allowlist.

## MCP server

`rndevtools mcp` serves the same commands to coding agents as a Model Context
Protocol server over stdio (JSON-RPC 2.0, one message per line, protocol
revision 2025-06-18). It is the recommended way for Claude Code, Codex,
Cursor, and Kiro to reach RN Devtools: MCP tools are always in the model's
tool list with a typed schema, so the agent picks `lane` over raw `simctl` the
same way it picks `Read` over `cat`, without first deciding that a skill
applies. `rndevtools setup` registers it with each agent.

Every command is one tool of the same name. Input schemas are generated from
the CLI's own flag table (`command.Describe`), and every call is assembled and
validated by `command.Build`, the same code path the flag parser uses, then
sent on the same socket with the same agent attribution, so the desktop sees
one kind of peer. Tool descriptions carry the workflow guidance a skill would
(when to use `lane`, how `input` coordinates work, what to call first), and the
`initialize` response's `instructions` carry the rule against driving
Simulators with `xcrun simctl` directly. Argument errors come back as tool
errors (`isError: true`) with the desktop's recovery text so the model can
correct the call; only malformed JSON-RPC is a protocol error.

`capture` returns the screenshot as an image content block alongside the JSON,
so the model can look at the device. Read-only resources:
`rndevtools://simulators`, `rndevtools://lanes`, `rndevtools://agents` (JSON),
and the template `rndevtools://screen/{udid}` (a fresh JPEG). Attribution comes
from `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`, which both agents pass to
the servers they spawn, falling back to the MCP client's name.

## Lanes

`lane` runs one git worktree on one Simulator with its own leased Metro port,
so several branches and coding agents can work in parallel:

```bash
rndevtools lane --operation up --worktree "$PWD" --udid <UDID>   # boot, lease a port, start Metro, launch
rndevtools lane --operation ls                                   # lanes, environments, discovered worktrees
rndevtools lane --operation launch --worktree "$PWD" --url checkout
rndevtools lane --operation log --lane-id <lane-id>
rndevtools lane --operation down --worktree "$PWD"
```

`up` requires `--worktree` and `--udid`; `down`, `launch`, and `log` take
exactly one of `--lane-id` or `--worktree`. Lane creation fails rather than
stealing a worktree, Simulator, or port another lane owns. The CLI attaches
`CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` (or `RNDEVTOOLS_AGENT_SESSION_ID`)
to `up` and `launch` so the desktop can show which agent holds a lane. The
agent skill in [`skills/rndevtools-lanes`](skills/rndevtools-lanes/SKILL.md)
teaches Claude Code and Codex the workflow; copy it into `.claude/skills` or
`.codex/skills`.

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
