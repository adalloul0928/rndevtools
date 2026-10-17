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
`supabase`, `native`, `agents`, `claim`, `release`, and `input`. Run `rndevtools <command> --help` for structured flags. An optional JSON
command object may be piped on standard input; flags may add different fields,
but redefining a stdin field is rejected. `slimming` exposes the read-only
`status`, `preview`, `doctor`, and `verify` operations and the mutating `apply`,
`undo`, and `restore`; mutations run only while SimSlim is enabled in RN
Devtools, only on Simulators the calling session holds or that nobody holds
(`device_held` otherwise), and only on runtime/profile combinations SimSlim has
verified or the user approved once in the app. `lane --operation up --slim
<profile>` applies a profile in the lane's own boot→slim→Metro→launch sequence
under the same gates. `lane --operation up` needs only `--worktree`: without
`--udid` the desktop picks a free iPhone, and when none is free it returns a
`deviceRequest` that the user settles in the Lanes panel (use an existing
Simulator, clone one, or dismiss) while the agent polls `lane --operation ls`. `act` is limited to the desktop service's explicit
unattended-action allowlist.

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
`rndevtools://simulators`, `rndevtools://lanes`, `rndevtools://supabase`
(`supabase --operation ls`), `rndevtools://agents` (JSON), and the template
`rndevtools://screen/{udid}` (a fresh JPEG). The `supabase` tool is listed
right after `lane`; its description says when a worktree's local Supabase
applies, what `up` returns, and the self-start fallback, and the `initialize`
instructions repeat the rules against hand-run stack commands. Attribution comes
from the session variables the MCP server inherits. Claude Code passes
`CLAUDE_CODE_SESSION_ID` to the servers it spawns. Codex does not pass
`CODEX_THREAD_ID`, so Codex calls over MCP fall back to an identity built from
the MCP client's name (`mcp-<client>`), which every Codex session shares. The
desktop treats that identity as synthetic: such a session's lanes and claims
are matched by its working directory instead, and its session-end hook sends
that directory (`release.sessionCwd`) so they are released at once.

## Setup for coding agents

`rndevtools setup` is the one-time step that makes agents on this Mac reach
for RN Devtools instead of raw `simctl`. It is idempotent and additive:
existing configuration is read, merged, and written back through a temporary
file and rename; unknown keys are preserved; files setup did not create are
never deleted. `--dry-run` prints the plan without changing anything, and the
same action is available in the desktop app's Settings as "Set up coding
agents".

| Step | Where | Notes |
| --- | --- | --- |
| Symlink the verified CLI | `~/.local/bin/rndevtools` | Re-pointed when the app moves; a foreign file there is left alone and reported. `--no-link` skips it. |
| Register the MCP server | Claude Code `~/.claude.json`, Codex `~/.codex/config.toml`, Cursor `~/.cursor/mcp.json`, Kiro `~/.kiro/settings/mcp.json` | Entry is `{command: <cli>, args: ["mcp"]}`. Claude and Codex are always configured; Cursor and Kiro only when their directory exists, or when named in `--agents`. Kiro gets the read-only tools in `autoApprove`; tools that drive a device still prompt. Codex's TOML is edited textually and setup owns only the `[mcp_servers.rndevtools]` table. |
| Install the skills | `~/.claude/skills`, `~/.agents/skills` (Codex), `~/.kiro/skills` | Every `skills/*/SKILL.md` is embedded in the binary (`rndevtools-lanes` and `rndevtools-supabase`), so the installed copies always match the CLI. With `--project <dir>` they go into that repository's `.claude/skills` and `.agents/skills` instead. |
| Agent hooks | Claude Code `~/.claude/settings.json` → `hooks`, Codex `~/.codex/hooks.json` | Two hooks, same for both agents because they send the same payload and read the same verdict. `PreToolUse` (`rndevtools hook pre-tool-use`) exits 2 (block, with the reason shown to the model) for `simctl boot`, `shutdown`, `erase`, `delete`, `openurl`, `install`, `uninstall`, `launch`, `terminate`, `io`, `privacy`, `push`, `keychain`, `status_bar`, `spawn`, `addmedia`, `clone`, and for hand-started Metro (`expo start`, `react-native start`); `simctl list` and other read-only verbs pass, and anything unparseable passes, because a hook that fails closed would lock the model out of Bash. While local Supabase is turned on in RN Devtools it also applies the [Supabase steering rules](#supabase-steering). `SessionEnd` (`rndevtools hook session-end`) releases everything the ending session holds (`release --all`) so its Simulators return to the pool at once rather than after the 10-minute grace; it never fails the agent's exit and finishes in milliseconds, inside Codex's 3-second cap. Codex runs new or changed hooks only after the user trusts them once with `/hooks`; setup says so in its report. Cursor has no hook mechanism, so for it the AGENTS.md block is the only guard. `--no-hook` skips both. |
| AGENTS.md block | `<project>/AGENTS.md` with `--project` | A short "iOS Simulators" section between `<!-- rndevtools:start -->` / `<!-- rndevtools:end -->` markers, replaced in place on rerun. When the project has `supabase/config.toml`, a "Local Supabase" paragraph follows, worded for when RN Devtools is not managing a worktree: use the `supabase` tool or `lane up` when it is, otherwise start the stack with the project's runner (from its lockfile) and `--runtime native`. The report also returns the block for manual installs. |

Setup finishes with the `doctor` check, so a mis-registered path or a desktop
that is not running shows up immediately rather than in the agent's first
failed tool call.

## Lanes

`lane` runs one git worktree on one Simulator with its own leased Metro port,
so several branches and coding agents can work in parallel:

```bash
rndevtools lane --operation up --worktree "$PWD"                 # pick a free Simulator, boot, lease a port, start Metro, launch
rndevtools lane --operation up --worktree "$PWD" --udid <UDID>   # or name the Simulator yourself
rndevtools lane --operation ls                                   # lanes, environments, discovered worktrees
rndevtools lane --operation launch --worktree "$PWD" --url checkout
rndevtools lane --operation log --lane-id <lane-id>
rndevtools lane --operation down --worktree "$PWD"
```

`up` requires `--worktree`. Without `--udid` the desktop picks a free iPhone
(nobody's lane, nobody's claim), booted ones first; when none is free it parks
a device request for the user and `lane ls` reports how it was settled.
`down`, `launch`, and `log` take exactly one of `--lane-id` or `--worktree`. Lane creation fails rather than
stealing a worktree, Simulator, or port another lane owns. The CLI attaches
`CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` (or `RNDEVTOOLS_AGENT_SESSION_ID`)
to `up` and `launch` so the desktop can show which agent holds a lane. The
agent skill in [`internal/setup/skills/rndevtools-lanes`](internal/setup/skills/rndevtools-lanes/SKILL.md)
teaches Claude Code and Codex the workflow; copy it into `.claude/skills` or
`.codex/skills`. On the command line a relative `--worktree` (for example
`--worktree .`) resolves against the current directory, for `lane`,
`supabase`, and `native`; stdin JSON and MCP tool calls must send absolute
paths, because neither shares the caller's directory.

`lane --operation up --backend auto|off|required` decides the worktree's local
Supabase. `auto`, the default for the `development` environment, starts the
worktree's own stack when RN Devtools manages its Supabase project and hands
Metro the stack's URL and publishable key, and never fails the lane; `required`
fails the lane when the stack cannot start; `off` skips it. Without the flag
the desktop applies the environment's default. The receipt's `lane.backend`
reports `ready`, `starting` (with a `jobId`; the app launches once the stack is
ready), `skipped`, `shadowed`, `refused`, or `failed`, with the reason.

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

## Local Supabase

`supabase` gives a git worktree its own local Supabase stack, run by RN
Devtools on Supabase's native runtime and bound to 127.0.0.1, while the user
has turned the feature on in RN Devtools › Supabase:

```bash
rndevtools supabase --operation up --worktree "$PWD"            # create or resume; waits up to --wait-ms (default 30000, max 45000)
rndevtools supabase --operation ls                              # every stack on this Mac, with lanes and holders
rndevtools supabase --operation status --worktree "$PWD"        # services and health
rndevtools supabase --operation env --worktree "$PWD"           # API/REST/Functions/Mailpit URLs, publishable and anon keys
rndevtools supabase --operation log --stack-id 64616c83 --service auth --service gateway --tail 100 --since 10m
rndevtools supabase --operation reset --worktree "$PWD" --seed=false
rndevtools supabase --operation destroy --worktree "$PWD" --note "obsolete branch"
rndevtools supabase --operation down --worktree "$PWD"
```

| Flag | Field | Rules |
| --- | --- | --- |
| `--operation` | `operation` | `up`, `down`, `ls`, `status`, `env`, `reset`, `log`, or `destroy`. Required. |
| `--worktree` | `worktreePath` | Absolute path, 2..1024 bytes, no control characters. |
| `--stack-id` | `stackId` | 8..64 lowercase hex; a unique prefix of an id from `ls`. |
| `--wait-ms` | `waitMs` | `up` only; integer 0..45000. |
| `--seed` | `seed` | `reset` only; boolean (`--seed=false` resets to the migrations only). |
| `--service` | `services` | `log` only; repeatable (or comma-separated), 1..16 distinct names: a service kind (`database`, `rest`, `auth`, `realtime`, `storage`, `imgproxy`, `functions`, `studio`, `pgmeta`, `mail`, `analytics`, `pooler`), `gateway`, or a lowercase instance UUID. |
| `--tail` | `tail` | `log` only; integer 1..1000. |
| `--since` | `since` | `log` only; `start`, a duration such as `10m` or `1h30m`, or an ISO-8601 time; at most 64 characters. |
| `--note` | `note` | `destroy`, or a `reset` that becomes a request; at most 240 characters (UTF-16 units). |

`ls` takes no target; every other operation takes exactly one of `--worktree`
or `--stack-id`, and each option belongs only to the operation listed. The
CLI validates all of this before connecting (exit 2), and the desktop
validates it again. The agent's identity rides on the request envelope only:
the command carries no agent field, and the desktop records the hold from the
envelope. Results are JSON: `up` returns the stack (ports, never URLs), the
app variable names Metro gets, whether Metro restarted, the CLI to run from
the worktree (`cli.run`, `cli.workdir`), `next`, warnings, and a `jobId` when
the stack is still starting (follow it with `wait --condition job`); only `env`
returns URLs and the publishable and anon keys, and no result ever carries a
secret key, the service-role key, or the database URL. `destroy` never deletes
anything: it files a request the user settles in RN Devtools, as does a
`reset` of a stack another session holds.

Socket deadlines sit past the desktop's own budgets, so a slow call still ends
in the desktop's typed answer rather than a CLI timeout: `up` waits
`wait-ms` + 15 s (45 s by default), `reset` 75 s, and every other operation
45 s; `--request-timeout-ms` overrides them. Exit codes are the usual ones: a
refusal such as `supabase_disabled` (the feature is off, or RN Devtools does
not manage that worktree) is a typed rejection (exit 6) whose `recovery` names
the next step, usually starting the stack yourself with `<runner> start
--runtime native`; a desktop that is not running is exit 3.

### Supabase steering

The desktop writes `steering.json` next to the agent socket
(`~/Library/Application Support/RN Devtools/agent/steering.json`, 0600 in the
0700 directory) while local Supabase is turned on, refreshes it every minute,
and removes it when the feature is turned off:

```json
{"version":1,"writtenAt":1760000000000,"desktopPid":12345,"supabase":{"enabled":true,"roots":[{"worktreeRoot":"/abs/wt","projectRoot":"/abs/wt","mode":"managed","branchContext":"refs/heads/feat-a","stackReady":true,"runner":"pnpm exec supabase"}]}}
```

The PreToolUse hook reads it, only for Bash lines that run `supabase` or kill
processes, with the socket's checks: a real directory and a regular file
(neither a symlink), owned by the current user, writable by nobody else, at
most 64 KiB, and exactly this v1 shape. A missing or invalid file, or
`enabled: false`, means no Supabase rule applies. Each command of a line is
judged on its own: runners are stripped (`npx`, `pnpm exec`/`dlx`, `yarn
[dlx]`, `bunx`, `bun x`, `npm exec`, a path binary, `supabase@<version>`),
`cd`, `pnpm -C`, `--workdir`, and `SUPABASE_WORKDIR` move the directory a
command runs in, `bash -c` scripts are followed, here-document bodies (a
commit message, a file written with `cat <<'EOF'`) are input rather than
commands, for the Simulator rules too, `--help` always passes, a command that
runs `rndevtools` itself is exempt, and anything the hook cannot read or
place runs.

- **Always, while enabled:** `stop --all`; a stop by `--stack-id` or
  `--project-id`, or with a `--workdir` outside the current worktree;
  `stack destroy`; `pkill`/`killall` of stack processes (postgres, postgrest,
  gotrue, auth, realtime, edge-runtime, supabase, and friends), `kill` of what
  `pgrep` finds, and `pg_ctl stop`; and `status --env` (or `-o env`)
  redirected or teed into a `.env*` file.
- **Managed mode**, when the file is at most 3 minutes old, the desktop
  accepts a connection on its socket within 200 ms, and the command runs
  inside a managed root whose Supabase project it would use: `start`, `stop`,
  `dev`, `stack`/`local` `start|stop|restart|prepare`, `db start`, any
  `--runtime`, and downloaded or out-of-tree CLI builds are redirected to
  `rndevtools supabase` (or the root's own runner), and `db diff`, `db pull`,
  `migration squash`, and local declarative schema commands wait until the
  branch's stack is ready.
- **Fallback mode**, otherwise, in projects that opted into the stack backend
  (the segment's or the hook's `SUPABASE_EXPERIMENTAL_STACK`, else
  `supabase/config.json`, else `[experimental] stack = true` in
  `supabase/config.toml`): `start`, `stack start`, and `stack prepare` need
  `--runtime native` (the reason gives the corrected command), `db start` is
  blocked, and local declarative schema commands must follow a native start
  in the same `&&` chain.

The hook is advisory (Codex needs `/hooks` trust, Cursor has no hooks); the
desktop's own native stacks and exposure checks are the real controls.

## Provenance

The implementation is original AVAD Technologies code. It uses only the Go
1.27 standard library and contains no SimSlim source or catalog data. Go runtime
and standard-library attribution is reproduced in
`apps/devtools-desktop/THIRD_PARTY_NOTICES.md`. See `PROVENANCE.md` for the full source,
dependency, build, and release record.
