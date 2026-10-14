---
name: rndevtools-lanes
description: >
  Run React Native worktrees on their own iOS Simulators through RN Devtools
  lanes. Use this skill whenever a coding agent needs to open a Simulator for a
  git worktree or branch, start Metro without colliding with another agent's
  port, launch the Expo dev client against that Metro, drive or inspect the app
  that is running there, or clean up when the work is done — including requests
  phrased as "run this branch", "open the simulator", "start the app for my
  worktree", or "fix a Metro port collision".
---

# RN Devtools lanes

A **lane** is one git worktree running on one Simulator, served by one Metro on
a port the desktop leased for it. Lanes are how several branches, and the agents
working on them, run side by side without fighting over port 8081 or a shared
Simulator. The RN Devtools desktop app owns every lane; this CLI talks to it over
a private local socket.

## Prerequisites

- RN Devtools is running on this Mac (`rndevtools doctor` succeeds).
- The worktree is a **checkout root** (output of `git worktree list`), has its
  dependencies installed, and declares `expo.scheme` in `app.json`. Lanes read
  the scheme to deep-link the dev client; they never evaluate `app.config.js`.
- The Expo development client is **already installed** on the Simulator. Lanes
  never trigger a native build. If `rndevtools apps --udid <UDID>` does not list
  the app, build and install it once (`npx expo run:ios -d <UDID>`) and reuse it.

## Rules

- **One lane per worktree, one Simulator per lane.** Lane creation fails rather
  than stealing a worktree, a Simulator, or a port another lane holds. If
  `lane up` is refused, read the error: it names the owning lane. Do not work
  around it by killing processes.
- **Never pick ports by hand.** The desktop leases ports from the environment's
  range (`development` 8100–8199 by default). Do not start `expo start` or
  `react-native start` yourself inside a worktree that has a lane.
- **Always address Simulators by exact UDID.** Never use `booted`; with several
  Simulators running, `simctl` picks one at random. The UDID you get back from
  `lane up` is the one to pass to every later `rndevtools` call.
- **Stop only the lanes you started.** `lane down` stops the lane's Metro and
  frees the Simulator. It does not shut the Simulator down.
- **Attribution is automatic.** The CLI forwards `CLAUDE_CODE_SESSION_ID` or
  `CODEX_THREAD_ID` so the desktop shows which session holds which lane. Other
  agents can export `RNDEVTOOLS_AGENT_SESSION_ID`.
- Slimming is a separate, operator-confirmed workflow in the desktop's SimSlim
  panel. Prefer Simulators the fleet already reports as slim; do not try to slim
  from the CLI.

## Start a worktree on a Simulator

```bash
rndevtools doctor                                     # 1. desktop reachable?
rndevtools simulators                                 # 2. pick an available UDID
rndevtools lane --operation ls                        # 3. see existing lanes and worktrees
rndevtools lane --operation up \
  --worktree "$PWD" --udid <UDID> [--environment development]   # 4.
```

`lane up` boots the Simulator if needed, starts Metro on the leased port, waits
up to 15 s for `/status`, and deep-links the dev client with the SDK 57 launch
form (`<scheme>://expo-development-client/?url=http://127.0.0.1:<port>`). The
result includes `lane.id`, `lane.port`, `lane.simulatorUdid`, and `lane.metro`
(`starting` | `ready` | `stopped`). Pass `--launch=false` to lease and start
Metro without opening the app.

If Metro does not become ready, the lease is kept so you can read the bundler
error:

```bash
rndevtools lane --operation log --worktree "$PWD"
```

Fix the actual Metro error, then relaunch:

```bash
rndevtools lane --operation launch --worktree "$PWD"
rndevtools lane --operation launch --worktree "$PWD" --url checkout/cart   # deep link via the lane scheme
```

## Drive the app that is running in the lane

Use the UDID from the lane for every call so your actions stay on your
Simulator:

```bash
rndevtools screen   --udid <UDID>
rndevtools elements --udid <UDID> --query "button"
rndevtools act      --udid <UDID> --tool routes --action-command navigate --action-payload '{"path":"/settings"}'
rndevtools wait     --udid <UDID> --condition network-idle
rndevtools capture  --udid <UDID> --name "after-checkout"
```

The connected app reports its own Simulator UDID, so `--udid` reaches both the
Simulator and the app session running inside it.

## Stop

```bash
rndevtools lane --operation down --worktree "$PWD"     # or --lane-id <lane.id>
```

## Report

State the lane id, worktree and branch, Simulator name and UDID, environment,
Metro port and health, and whether the Simulator was slim. A healthy Metro or a
successful launch is not proof a feature works; include UI evidence from
`screen`, `elements`, or `capture`.
