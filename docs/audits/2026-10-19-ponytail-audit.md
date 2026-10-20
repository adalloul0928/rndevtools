# Ponytail audit, 2026-10-19

A whole-repo audit of RN Devtools at `553dc95`, run with the [ponytail](https://github.com/DietrichGebert/ponytail) audit method: map the repo first, look for bugs, risks, scale problems, missing tests, slowness and lean code in that order, and back every finding with a concrete case.

- **How it ran:** eight area auditors, each followed by a skeptic that tried to refute every finding. They produced 195 findings; the skeptics refuted none, corrected 47 and added 30 they found themselves.
- **Load assumed:** one developer’s Mac running one desktop app, a few connected apps and Simulators, and a handful of coding agents at once.
- **What happened next:** 71 behaviour-preserving lean findings were applied in twelve commits, `fc3479b` to `690eb12` (see [Applied in the cleanup](#applied-in-the-cleanup)). The 148 findings in this document are still open, except 2 and 108: commits merged from GitHub in `19eafeb` fixed those, as each one notes.
- **Line numbers:** findings 1 to 20 point at the code after the cleanup (`690eb12`); findings 21 onward point at `553dc95`, so some have moved.

## What this repo does

RN Devtools is two halves that ship together. On the phone, two npm packages add debug panels (network, console, storage and more) to a React Native app and connect it to the Mac. On the Mac, an Electron app inspects connected apps and runs Simulators, lanes (one git worktree with its own Simulator and Metro port) and one local Supabase database per worktree. Coding agents drive it through a Go command-line tool and MCP server.

## Verdict

Not healthy yet. Fix 1, 2 and 3 first: a Release lane can run another branch’s code, the reference example ships devtools in its release bundle, and one failed load can delete a user’s saved restore points.

**Lean:** the cleanup removed 1,836 lines (2,026 in source, with 190 lines of new tests) and no dependencies. About 430 more lines could go, but each of those changes something visible or breaks a public API; they are marked below.

## Must fix

1. **Release builds from one worktree run in every other worktree** (`packages/react-native/build-cache.js:138, 362-371`)
   - **What this is:** The build cache lets worktrees share one native build when their native inputs match.
   - **Problem:** The cache key ignores the JavaScript. A Release build has the JS bundle baked in, so worktree B's `expo run:ios --configuration Release` installs worktree A's app and runs A's code. The desktop's `native plan` also reports it as a hit.
   - **Fix:** Cache Debug builds only (the configuration name matches `/debug/i`), in the provider and in the desktop's plan script and `native install`.
   - **If we skip it:** A Release lane silently runs another branch's code, and bugs get blamed on the wrong branch.

2. **The example's own pruning proof fails: devtools reach its release bundle** (`examples/expo-demo/metro.config.js:12-18`, `src/app.tsx:1-2`)
   - **What this is:** The example app that is meant to prove that devtools never reach a release build.
   - **Problem:** `app.tsx` imports `@rndevtools/core` and the `@rndevtools/react-native` root directly, and the pruning list names only `@/devtools/desktop`. A production bundle built with the example's real config fails `rndevtools-verify-bundle` on 11 devtools markers. CI never runs this check, so nobody saw it.
   - **Fix:** Move every devtools import into one host module, prune that module, and add `quality` and `verify:bundle` for the example to CI.
   - **If we skip it:** Teams that copy the reference setup ship devtools to their users.
   - **Since the audit:** fixed by `c0a3d04`, merged in `19eafeb`. The app now imports devtools only through `src/devtools/host.tsx`, Metro replaces that one module, and `verify:seam` checks the import graph in the example's `quality` gate, which CI runs. A production export of the merged tree has no devtools markers; at `d9b0014` it had 11.

3. **A failed load followed by one save wipes all saved restore points or scenarios** (`packages/core/src/plugins/restore-repository.ts:475-519`, `scenario-repository.ts:266-313`)
   - **What this is:** The stores that keep restore points and user scenarios on the device.
   - **Problem:** When loading fails (a read error, bad JSON, a newer file format, too many scenarios), the store starts empty. The next capture or save writes that empty list over the saved file. Nothing shows the load error. A partial load with lower limits deletes entries the same way.
   - **Fix:** After a failed load, refuse writes until an explicit clear or replace-import, and show the load error. Add a test: a failing read followed by a save must leave storage untouched.
   - **If we skip it:** One flaky storage read, or a downgrade, permanently deletes a user's saved points.

4. **Recipe number fields save the wrong value** (`apps/desktop/src/renderer/components/recipe-step-editor.tsx:1385`)
   - **What this is:** The number inputs in the Automation step editor (latitude, longitude, speed, amount and others).
   - **Problem:** Each keystroke goes through `Number(text)` and back. A typed `-` becomes `0`, and a zero right after the decimal point disappears. Typing `-122.4` saves `122.4`, the other side of the planet. `37.05` saves `375`.
   - **Fix:** Keep the typed text in local state inside `LabeledInput`, and send the number only when the text parses as a finite number.
   - **If we skip it:** Saved recipes drive Simulators to wrong places with no warning.

5. **Supabase stacks never stop on their own on a Mac with only one coding agent** (`apps/desktop/src/main/supabase/holds.ts:385-410`, `apps/desktop/src/main/agent-sessions.ts:76-173`)
   - **What this is:** The rule that stops a stack 60 s after its last user lets go.
   - **Problem:** Automatic stops pause when session discovery for any agent is "unavailable", and a missing Codex or Claude install also counts as unavailable. So on a Claude-only or Codex-only Mac, no stack ever stops by itself.
   - **Fix:** Treat "this agent's home folder does not exist" as absent, not unreadable, but only for the Supabase holds. Keep the device-hold clocks as they are.
   - **If we skip it:** On the most common setup, idle stacks pile up (about 160 MiB each) until someone stops them by hand.

6. **Slimming several Simulators can reboot one that another agent just took** (`apps/desktop/src/main/slimming-service.ts:787, 862`)
   - **What this is:** A SimSlim job that reboots a list of Simulators one after another.
   - **Problem:** It checks who holds each device only when the job is queued. While device 1 is processed, another agent's `lane up` can take device 2. The job then reboots device 2 anyway and kills that agent's app. Recipes with more targets than their concurrency have the same gap.
   - **Fix:** Check the hold again for each device after taking its lease, and count lane reservations that are not yet saved as holds.
   - **If we skip it:** With a few agents at once, one agent's slim silently breaks another agent's work.

7. **MCP `jobs list` and `recipe list` results are rejected by SDK clients** (`apps/desktop/native/rndevtools-cli/internal/mcp/server.go:686`)
   - **What this is:** The MCP server copies the desktop's answer into `structuredContent`.
   - **Problem:** MCP requires an object there. For some calls the desktop answers with an array, `null` or `true`, and the official SDK refuses the whole result. This was reproduced from this very session: the `jobs` and `recipe` list tools failed with "expected record, received array".
   - **Fix:** In `toolSuccess`, wrap anything that is not an object as `{"result": ...}`, and add a test for `[]`, `null` and `true`.
   - **If we skip it:** Agents cannot list jobs or discover recipes over MCP.

## Should fix

8. **A device action keeps running after the desktop gave up on it** (`packages/react-native/src/desktop/client.ts:740-812, 1081, 1128`)
   - **What this is:** The signal the app gets for each action the desktop sends.
   - **Problem:** It fires only after the 45 s timeout, never when the connection drops or the client stops. The desktop reports a failure while an on-device prompt stays open and can still apply the change. Actions on the reconnected socket also wait behind the stale one, so every action fails for up to 45 s.
   - **Fix:** Keep the action's abort controller next to its socket, and abort it on close and on stop.
   - **If we skip it:** Writes can apply after a reported failure, or apply twice on retry.

9. **One long nested list makes the desktop drop the app over and over** (`packages/react-native/src/desktop/client.ts:305-322`)
   - **What this is:** Trimming each snapshot to the desktop's row limits before sending it.
   - **Problem:** Only top-level lists are trimmed. A nested list over its cap (for example performance samples above 1,500, which core allows up to 10,000) makes the desktop reject the snapshot and close the socket. The app reconnects and sends the same snapshot, forever.
   - **Fix:** Trim every nested path the desktop schema caps, and add a test that compares the client's table with the schema.
   - **If we skip it:** Apps with bigger buffers lose the desktop connection completely.

10. **Recreate, Apply config and Studio can act on the wrong branch's stack** (`apps/desktop/src/main/supabase/service-operations.ts:289-340, 847-987`)
    - **What this is:** Supabase jobs that stop a stack and start it again, or destroy it and create it again.
    - **Problem:** They check that the worktree is still on the stack's branch only before they wait their turn, which can take minutes. If HEAD moves meanwhile, Recreate creates and pins the other branch's stack, and Apply config loads the other branch's config. Pre-download has the same gap.
    - **Fix:** Re-check the branch inside the locked job, and pass the branch precondition to the start step, as the normal start already does.
    - **If we skip it:** A confirmed destructive action can report success on the wrong database.

11. **One app whose name has a space blocks every SimSlim apply** (`apps/desktop/native/rndevtools-sim-helper/internal/simulator/client.go:348`)
    - **What this is:** The step that ties each running service to a process name before slimming.
    - **Problem:** If any process in the Simulator has a name outside the strict pattern (a space, a bracket, a non-ASCII letter), it rejects the whole process list. So "Example App" running in the Simulator makes every apply fail with an unhelpful error.
    - **Fix:** Skip processes with such names instead of failing. They can never match a service name, so nothing else changes.
    - **If we skip it:** Teams whose app name has a space cannot slim while the app runs.

12. **The first desktop version bump breaks native permission checks** (`apps/desktop/native/rndevtools-native-host/Sources/RNDevtoolsNativeHost/NativeHost.swift:4`)
    - **What this is:** The version the Swift helper reports, which Electron compares with `package.json`.
    - **Problem:** The Go helper gets its version at build time, but the Swift one is typed in as `0.1.0`. The npm packages are already at 0.2.0. When the desktop version goes up, permission and capability checks report "untrusted".
    - **Fix:** Make the native build fail when the Swift constant differs from `package.json`, or generate it at build time.
    - **If we skip it:** The release that bumps the version ships broken native inspection.

13. **The release job shows signing secrets to install-time scripts** (`.github/workflows/release.yml:55-94`)
    - **What this is:** The job that installs, builds, signs and notarizes the desktop app.
    - **Problem:** The Developer ID certificate, its password and the Apple ID password are set for the whole job. So `pnpm install` can read them, and it runs HeroUI Pro's postinstall, which downloads code from a CDN.
    - **Fix:** Set those four secrets only on the packaging step, and the HeroUI token only on the install step.
    - **If we skip it:** A compromised install script can steal the signing certificate.

14. **A manual run of the Release workflow publishes to npm from any branch** (`.github/workflows/release.yml:6, 12-47`)
    - **What this is:** The job that publishes both npm packages.
    - **Problem:** The workflow also runs on manual dispatch, and the publish job has no check that it runs on a tag. A dispatch to re-test notarization publishes the current branch to npm `latest`.
    - **Fix:** Add `if: startsWith(github.ref, 'refs/tags/v')` to the publish job.
    - **If we skip it:** A test click can ship an untagged npm release.

15. **`wait` ignores its timeout and answers "cancelled"** (`apps/desktop/src/main/agent-command-router.ts:971, 1830-1842`)
    - **What this is:** `rndevtools wait` for a Simulator job, a slimming job, or network idle.
    - **Problem:** These three waits never read `timeoutMs`. The socket aborts the request 5 s after the timeout, so the agent gets "cancelled" while the job keeps running. Other waits answer "timed out" or return the job.
    - **Fix:** Give these waits their own deadline, and return the job as it stands (or "timed out" for network idle).
    - **If we skip it:** Agents take a slow job for a cancelled one and retry or give up.

16. **Lanes fail for worktrees under `/tmp`, `$TMPDIR` or any symlinked folder** (`apps/desktop/src/main/lane-service.ts:633, 677`)
    - **What this is:** `lane up` and friends match the folder an agent works in against `git worktree list`.
    - **Problem:** git prints real paths with symlinks resolved, but the request keeps the symlinked spelling, so `/tmp/wt` never matches `/private/tmp/wt`. `lane up` fails with "not inside a worktree", and `lane down` says no lane runs.
    - **Fix:** Resolve the requested folder with `fs.realpath` once, in the lane service and in the router.
    - **If we skip it:** Agents whose worktrees live in a temp folder cannot use lanes.

17. **Supabase steering misses `pnpm run supabase` and `npm exec supabase --`** (`apps/desktop/native/rndevtools-cli/internal/setup/hook_supabase.go:418-453`)
    - **What this is:** The hook that stops agents from running commands like `supabase stop --all` that hit every agent's database.
    - **Problem:** The rules strip `pnpm exec` but not `pnpm run`, and they read the `--` in `npm exec supabase -- stop --all` as end-of-options. Both spellings pass, while equivalent ones are blocked. `bun supabase` passes too.
    - **Fix:** Add the `run` case for pnpm, accept npm's `exec`/`run` with the one `--` that npm strips, and add bun's shorthand. Better: let both rule sets share one runner parser.
    - **If we skip it:** One ordinary spelling stops every other agent's local database.

18. **The Captures panel can delete a capture the search hides** (`apps/desktop/src/renderer/panels/simulator/captures-panel.tsx:95-96, 141-142`)
    - **What this is:** The selected capture drives the preview and the Export, Show file and Delete buttons.
    - **Problem:** The selection and its fallback come from the unfiltered list, not the list on screen. After a search, the inspector can show, and delete, a capture that is not visible.
    - **Fix:** Pick the selection and the fallback from the visible list, as every Connected panel already does.
    - **If we skip it:** Only the name in the confirm dialog stands between a click and deleting the wrong capture.

19. **Agents in a nested worktree keep the main checkout's stack running** (`apps/desktop/src/main/supabase/holds.ts:345`)
    - **What this is:** Any agent working inside a worktree keeps that worktree's stack from stopping.
    - **Problem:** The check is a plain path prefix. Claude Code's own worktrees live inside the main checkout (`<repo>/.claude/worktrees/<name>`). So every agent there also counts as working in the main checkout, and its row says so.
    - **Fix:** Skip sessions whose folder is inside a nested worktree root of that stack.
    - **If we skip it:** The main checkout's stack never auto-stops while any agent works in a nested worktree.

20. **Successful navigations are later logged as failures** (`packages/core/src/plugins/navigation.tsx:309-333, 1158-1249`)
    - **What this is:** Navigation tracking: requested, then committed, then focused.
    - **Problem:** A route that was reached but whose focus was never reported is marked "failed" 30 s later, with an error-level event on the shared timeline. Hosts that call only `record()` see every navigation turn into a failure.
    - **Fix:** Drop committed transitions quietly when they time out; keep the failure only for uncommitted ones.
    - **If we skip it:** The timeline fills with false errors.

## Other open findings

Shorter entries, most important first. Each one names the problem and the fix the skeptic agreed to; the area is in brackets.

### Should fix

21. **Network profile picker does nothing unless the host supplies a confirm handler** [packages/core; bug] (`packages/core/src/plugins/network.tsx:1313-1314, 3098-3120, 3611-3622`)
     - **Problem:** With createNetworkPlugin({ enableSimulation: true }) and no actionCoordinator, the plugin builds createDevToolsActionCoordinator() with no confirm. Every profile except 'none' requires confirmation, so it is rejected with confirmation-unavailable. The panel still shows the picker as available and throws the receipt away (`void setSimulationProfile(value)`). The selection snaps back with no message.
     - **Fix:** When options.actionCoordinator is missing, show the picker as unavailable with the reason ('Network profiles need an actionCoordinator with a confirm handler'). Also show the error of any rejected or failed receipt the picker gets back. Document the requirement in the README.
22. **Typed environment rules don't compile inline, and their type mismatches render as 'Expected undefined'** [packages/core; bug] (`packages/core/src/plugins/environment.tsx:61-68, 87-97 (EnvironmentPluginOptions.rules), 210-217 (validationLabel)`)
     - **Problem:** The options use a stale local EnvironmentValueRule that has no `severity` and no `validation` fields, so an inline typed rule is a compile error. At runtime the panel validates with the model's typed rules. But validationLabel prints `Expected ${expectedType}`, and typed rules are forbidden to set expectedType, so every typed type mismatch reads 'Expected undefined, found string'.
     - **Fix:** Use the model's EnvironmentValueRule and EnvironmentValidationResult (see the duplication finding). Make validationLabel switch on result.issueCode (boolean/number/url/enum/version) and use expectedType only for legacy rules. Add a panel test with createEnvironmentBooleanRule.
     - **Since the audit:** the cleanup (`fc3479b`) fixed the compile half: inline typed rules now compile. The "Expected undefined" label is still open.
23. **Android Query panel never shows mutation Variables or Data** [packages/core; bug] (`packages/core/src/plugins/query.tsx:668-711 (AndroidMutationRow), 340-348 and 307-316 (refresh → buildSnapshot(false))`)
     - **Problem:** The row reads mutation.variables and mutation.data from the stored snapshot. The store is only ever filled by buildSnapshot(false), which passes includeData && captureData = false, so those fields are always undefined. iOS (MutationDetails, :623-666) and Android query rows (queryPreviews) read the live cache instead.
     - **Fix:** Pull the live lookup in MutationDetails into a small mutationPreviews(mutation) helper and use it in AndroidMutationRow too, as AndroidQueryRow already does for queries.
24. **Console grouping merges logs with different correlation IDs** [packages/core; bug] (`packages/core/src/plugins/console.tsx:580-609`)
     - **Problem:** The group fingerprint covers level, scope, message, attributes, error and source, but not correlationId. A repeat with a different correlation ID is folded into the previous row, which keeps the first row's correlationId. The README promises correlation metadata is preserved.
     - **Fix:** Add `correlationId ?? ''` to the parts passed to consoleGroupFingerprint (lines 582-591).
25. **Storage change diff reports unchanged arrays as changed** [packages/core; bug] (`packages/core/src/plugins/storage-model.ts:528-567 (diffStorageValues.visit)`)
     - **Problem:** visit() recurses only into non-array objects. Arrays fall through to Object.is, which is always false for two JSON.parse results, so any array that is present on both sides is pushed as 'changed' even when it is identical.
     - **Fix:** Use only the first option: recurse when both sides are arrays, giving index paths like $.tags.0 within the existing depth and 200-entry caps. Do not skip on equal diffPreview text. Add an array test, including one where only a redacted element changes.
     - **Skeptic's correction:** Reproduced (f07-storage.test.ts): the theme change also emits {$.tags changed, ['a'] -> ['a']}, and two identical arrays emit '$ changed'. However, the second fix option is lossy. diffPreview sanitizes and caps at 4 KiB, so [{"token":"a"}] vs [{"token":"b"}] preview identically as [REDACTED]. Arrays that differ only past 4 KiB also preview identically. …
26. **Camera fixture media-type check breaks for mediaTypes: 'videos' and for the enum forms** [packages/react-native; bug] (`packages/react-native/src/camera/provider.ts:202-204,219-227`)
     - **Problem:** expo-image-picker types mediaTypes as MediaType | MediaType[] | MediaTypeOptions. The video check uses .includes('videos'), which works on a string only by accident. The image check assumes an array (length === 1 && [0] === 'videos'). So with mediaTypes: 'videos', an image fixture is handed to a video-only flow. With the still-typed enum value 'Videos' or 'All', a video fixture is refused as "accepts images only".
     - **Fix:** Normalize once: `const types = [options?.mediaTypes ?? 'images'].flat().map((t) => String(t).toLowerCase())`. Accept videos when types contains 'videos' or 'all', and images when it contains 'images', 'livephotos' or 'all'. Use both flags in fixtureAsset. Add tests for the string and enum forms; lines 215 and 224 are not covered today.
27. **Lanes lose their stack hold after a desktop restart unless their environment defaults to Auto** [desktop: local Supabase; bug] (`apps/desktop/src/main/supabase/service-engine.ts:2489-2516`)
     - **Problem:** It re-attaches a lane only when the lane's environment currently defaults to backend 'auto'. Lane Metro processes deliberately outlive the app (lane-service.ts:482-483). A lane started with Auto or Required on an environment that now defaults to Off is therefore not re-attached, and its stack loses the lane hold. The reverse also happens: a development lane started with Backend Off gets attached and holds a stack it does not use.
     - **Fix:** Store the attached lane ids on the stack record in stacks.json (lanes.json stays untouched) and re-attach from that at boot. Fall back to the environment default only for lanes that were never recorded.
28. **A valid app.json without `slug` loses its URL scheme, so lane launch fails** [desktop: main process, preload, shared; bug] (`apps/desktop/src/main/lane-worktree.ts:152-155`)
     - **Problem:** It treats the `expo` key as the config only when `expo.slug` exists. Expo itself uses `config.expo ?? config`, and `slug` is optional: Expo derives it from `name`. Example: `{"expo":{"name":"Demo","scheme":"demo","ios":{"bundleIdentifier":"com.example.demo"}}}` reads as `{}`. The lane starts Metro, then `launchLane` throws "The worktree declares no URL scheme in app.json...", and the installed-app check is skipped.
     - **Fix:** Use `parsed.expo` whenever it is an object: `const expo = isRecord(parsed) && isRecord(parsed.expo) ? parsed.expo : parsed;`. One line, plus a test case without a slug.
29. **Build Insights misses new builds once a DerivedData folder grows** [desktop: main process, preload, shared; bug] (`apps/desktop/src/main/build-insights-service.ts:469-494 (limits at 19-21)`)
     - **Problem:** The walk stops after 5,000 visited entries or 100 results, in name order, and both limits fail in practice. (1) It lists every project's second level before any `Logs/Build` or `Logs/Test` folder. This Mac's 8 DerivedData projects already hold 1,753 entries in the first three levels, about 220 each. With roughly 23 projects (each worktree's build makes its own), the walk stops with zero results while the source still shows 'ready'. (2) Node returns folder entries sorted by name. …
     - **Fix:** Keep a bounded walk that never descends into folders that cannot hold result bundles (*.noindex such as ModuleCache.noindex, Build, SourcePackages). Look in Logs/* both directly under the root and one level down. Collect the candidates, sort them newest-first by mtime, then cap at 100. When the entry budget is hit, report a truncated scan on the source instead of 'ready'.
     - **Skeptic's correction:** The code issue is real. discoverXcresults (build-insights-service.ts:469-494) shares one 5,000-entry budget across a breadth-first, name-sorted walk (libuv scandir sorts, which I confirmed). It returns partial results with status 'ready' and keeps the first 100 bundles by name, which means the oldest. The evidence is wrong, though. …
30. **Lane busy state is one slot; a second lane operation clears it while a start is still running** [desktop: renderer; bug] (`apps/desktop/src/renderer/state/lane-runtime.tsx:252-254, 313, 334; consumers lanes-panel.tsx:248, 354, 414, 515, 811, 1449, 1469; fleet-panel.tsx:634; supabase-panel.tsx:475`)
     - **Problem:** Each run overwrites the slot and sets it back to null when it ends, even if another run is still going. Start a lane (boot plus Metro can take up to the health timeout), then press 'Track repository' in the same form, which is never disabled. 'Start Metro' re-enables at once and the 'Starting…' label disappears. When that dialog closes, every lane button in Lanes and Fleet re-enables while the start is still running.
     - **Fix:** Track in-flight operations as a count per kind, incremented at start and decremented in finally. Expose isPending(kind) and isBusy, and switch the six consumers to them. This also lets the read-only 'Metro log' stay usable during a slow launch.
31. **'Untrack' and the worktree overview cannot be reached while any lane exists** [desktop: renderer; bug] (`apps/desktop/src/renderer/panels/simulator/lanes-panel.tsx:173-177, 527-541, 1427-1477`)
     - **Problem:** The effect at 173-177 snaps the selection to lanes[0] whenever it is not a lane id, and nothing ever sets it back to ''. So with one lane running, the overview, and with it 'Untrack', can never be shown. It even renders lane chips for worktrees that have lanes, a state it can never display.
     - **Fix:** Only snap when a non-empty selection disappears (if (selectedLaneId && !lanes.some(…))). Add an 'All worktrees' button in the list header that sets the selection to ''.
32. **Storage editor swaps Input for TextArea at 81 characters and loses keyboard focus** [desktop: renderer; bug] (`apps/desktop/src/renderer/panels/storage-panel.tsx:321-325`)
     - **Problem:** The element type depends on the draft: draft.length > 80 renders a TextArea, otherwise an Input. Typing the 81st character (or deleting back to 80) unmounts one element and mounts the other. Focus drops to <body> and the next keystrokes go nowhere.
     - **Fix:** Choose the element from the stored value, not the draft: selected.valueType === 'json' || (selected.valueText?.length ?? 0) > 80. Or always use the TextArea.
33. **Simulator panels use private size and duration formatters that disagree with the shared ones ("1m 60s", "0 B")** [desktop: renderer; bug] (`apps/desktop/src/renderer/components/simulator-ui.tsx:289-304; lib/format.ts:7-11, 60-75; panels/simulator/build-insights-panel.tsx:14-19, 306, 334, 480`)
     - **Problem:** There are three byte formatters and two duration formatters. 1536 B shows as '1.5 KB' in Fleet and '2 KB' in Supabase. 2.5 GiB shows as '2.5 GB' in Simulator panels and '2560.0 MB' in Connected panels. NaN or a negative value becomes '0 B' instead of '—'. The private formatDuration rounds the seconds separately, so a 119,600 ms build reads '1m 60s'.
     - **Fix:** Replace simulator-ui's formatBytes with lib/format formatSize (it has a GB tier and the '—' guard) in fleet, slimming and captures. Do not use core's formatBytes there. In build-insights-panel, add a local formatBuildDuration that rounds to whole seconds first: s = Math.round(ms / 1000); `${Math.floor(s / 60)}m ${s % 60}s`, with '—' for non-finite or negative input. Then delete simulator-ui's formatDuration.
     - **Skeptic's correction:** Every value checks out. simulator-ui formatBytes(1536) gives '1.5 KB' while formatSize gives '2 KB'. 2.5 GiB gives '2.5 GB' while core gives '2560.0 MB'. NaN and negative values give '0 B'. 119,600 ms gives '1m 60s'. …
34. **Helper crashes with 'netpoll failed' when started without FD 3** [native helpers (Go sim helper, Swift host); bug] (`apps/desktop/native/rndevtools-sim-helper/internal/authorization/authorization.go:79`)
     - **Problem:** If FD 3 is not open when the helper starts, the discarded os.File still owns descriptor number 3. The Go runtime then puts its netpoll kqueue on fd 3 (the context.WithTimeout in runWithContext is enough), and the File's finalizer closes it at the next GC. Result: 'runtime: kevent on fd 3 failed with 9 / fatal error: runtime: netpoll failed'. On Darwin a kqueue even reports itself as a FIFO, which is why simulator-command-runner.ts:176-183 blames a 'pollable FIFO' and works around it by opening /dev/null as FD 3. …
     - **Fix:** Build the inherited-FD authorizer only when request.Operation.RequiresMutationAuthorization() is true. Before calling os.NewFile, check FD 3 with syscall.Fstat (it must be a FIFO) and confirm O_NONBLOCK, so no File ever wraps a descriptor the helper does not own. Current Electron and broker runs see no change. After this, the reservedAuthorizationFd block in simulator-command-runner.ts can be deleted.
35. **Rollback gives up at once if the Simulator is still booting or shutting down** [native helpers (Go sim helper, Swift host); bug] (`apps/desktop/native/rndevtools-sim-helper/internal/simulator/client.go:592`)
     - **Problem:** A device in the 'Booting' or 'Shutting Down' state falls into the default branch, which returns 'simulator is in transient state ...' immediately. When an apply is cancelled through FD 4 or times out in the middle of a reboot, CoreSimulator finishes the transition on its own a few seconds later. By then failAndRollback (mutation.go:443-444) has already turned the error into rollback_boot_failed and mutation_failed_needs_attention, even though it has a 30-minute rollback budget.
     - **Fix:** Before acting, poll findDevice every 500 ms while the state is Booting, Shutting Down or Creating, until it settles or ctx ends. shutdown() already polls this way. Add a fake-runner test that reports Booting twice and then Booted.
36. **Root `pnpm quality` is not the gate CI enforces** [tooling, CI, example and docs; bug] (`package.json:19, turbo.json:14-26, CONTRIBUTING.md:5-10, AGENTS.md:15-22`)
     - **Problem:** Each workspace's `quality` also runs check:dead-code (knip), and the desktop's also runs `build`. CI runs those workspace gates. So the root command passes on changes CI rejects, for example a newly unused export in packages/core. Root quality also includes @rndevtools/desktop typecheck and tests, which need the licensed HeroUI Pro payload, so CONTRIBUTING's setup (`pnpm install && pnpm quality`) fails for the fork contributors it addresses. …
     - **Fix:** Set root `quality` to `turbo quality`, with turbo.json task `"quality": { "dependsOn": ["^build"], "cache": false }`. knip analyses every workspace, so a per-package cache would be wrong. In CONTRIBUTING, give license-less contributors `pnpm install --ignore-scripts && pnpm --dir packages/core quality && pnpm --dir packages/react-native quality`.
37. **e2e harness tests whatever dist/ already exists** [tooling, CI, example and docs; bug] (`apps/desktop/e2e/harness.ts:125-132, apps/desktop/package.json:34`)
     - **Problem:** After any source edit, `pnpm --filter @rndevtools/desktop test:e2e` runs against the previous bundle, because both entry files still exist. A fix looks broken, or a regression passes, until someone rebuilds by hand. The preload bundle is not checked at all.
     - **Fix:** Build once per run in a Playwright globalSetup: add e2e/global-setup.ts running `pnpm --filter @rndevtools/desktop build` and set `globalSetup` in playwright.config.ts. Then delete ensureBuilt, its call, rendererEntry and the execFileSync/existsSync imports. Leave `test:e2e` as `playwright test`.
     - **Skeptic's correction:** Confirmed: harness.ts:126-127 builds only when the renderer or main entry is missing, and it never checks preload. The proposed fix leaves a gap, though. Putting `pnpm build &&` only in the test:e2e script and deleting ensureBuilt means `pnpm exec playwright test <spec>` and IDE runners get no build at all: a fresh checkout fails to launch, and an existing dist/ is still stale.
38. **Build lock stays held when Expo uploads under a different entry or skips the upload** [packages/react-native; risk] (`packages/react-native/build-cache.js:341-364 (claimOrWait), 436-442 (release in uploadBuildCache)`)
     - **Problem:** The lock is released only for the entry computed at upload time, but Expo recomputes the fingerprint before calling uploadBuildCache. If a native input changes during a long build (for example an agent adds a native package), the upload goes to a new entry and the original entry stays locked. On Android, Expo skips the upload entirely when it falls back to installing through Gradle. …
     - **Fix:** Keep the module-level Set of claimed lock paths and release all of them in uploadBuildCache's finally (fixes the fingerprint-change case). Also, in claimOrWait, on timeout log and return null without claiming instead of throwing. Any claim that outlives its build then costs one duplicate build, not a failed lane: Gradle fallback, rebundle miss, or a PID reused after a reboot (isAbandoned checks only liveness). …
     - **Skeptic's correction:** Reproduced. Resolving h1 and uploading under h2 left h1's build.lock naming the live PID, and a waiter timed out naming that PID. build-cache-providers/index.js:165-171 recomputes the fingerprint at upload, and runAndroidAsync.js:136 uploads only when options.binary is set. …
39. **Per-stack keys are reported as applied when they were not** [desktop: local Supabase; risk] (`apps/desktop/src/main/supabase/service-engine.ts:3171-3176; service-operations.ts:1018-1020; lane-backend.ts:166; agent-operations.ts:271-273`)
     - **Problem:** The Copy-key note and the 'shared-default-keys' warnings for lanes and agents look only at the policy toggle. #startOverrides ignores what applyToWorktree returns ('not-ignored' or 'failed'). Stacks that were already running when the toggle was turned on also keep the public default keys until they restart.
     - **Fix:** Decide 'own key' per stack, not per policy. Compare the stack's publishable key in #credentials with the key keyStore issued for its project, or remember the last applyToWorktree result per project root. Use that for the copy note and both warnings, and add a test for the 'not-ignored' case.
40. **`lane up` and `lane launch` let a caller choose which session it acts as** [desktop: main process, preload, shared; risk] (`apps/desktop/src/main/agent-command-router.ts:2218 (used at 2247, 2263, 2278, 2285)`)
     - **Problem:** The router prefers the command field over the envelope: `const laneAgent = command.agent ?? context.agent`. It then uses that identity both for the hold check and as the new lane's owner. A caller can pipe in JSON that names another session; `rndevtools agents` lists every session id. Example: `{"kind":"lane","operation":"launch","laneId":"...","agent":{"kind":"claude","sessionId":"<B>"}}` passes B's hold check and relaunches B's app. …
     - **Fix:** Let the envelope win: `const laneAgent = context.agent ?? command.agent;`. The CLI and MCP paths fill both from the same variables, so normal calls behave as before. Add a router test where the field does not match the envelope.
41. **Recipe names go into the privileged-run and delete dialogs unsanitized** [desktop: main process, preload, shared; risk] (`apps/desktop/src/main/index.ts:548 and 587`)
     - **Problem:** Both dialogs insert `recipe.name` as-is. The name accepts any characters up to 128 (recipe-protocol.ts:519), including newlines and bidirectional overrides, and recipes are shared as JSON files through Import. Example: an imported recipe named `Screenshot tour\n\nNo privileged steps. Safe to run.` makes the approval dialog appear to call itself harmless, and a right-to-left override character reverses the text that follows it. …
     - **Fix:** Wrap the name with the existing `sanitizeDialogText(recipe.name)` from security.ts in both places. Two lines.
42. **setup rewrites users' agent config files lossily: big integers rounded, & < > escaped, keys re-sorted** [agent CLI (Go); risk] (`apps/desktop/native/rndevtools-cli/internal/setup/setup.go:289 and :314 (writeJSONServers); :457 and :491 (installHooks)`)
     - **Problem:** The README promises that unknown keys are preserved, and the files may be symlinks into a dotfiles repo. Decoding into map[string]any turns every number into a float64. json.MarshalIndent also HTML-escapes strings and sorts the keys. I ran Apply on a hand-written settings.json. `"BIG_ID": 12345678901234567890` became `12345678901234567000`. `1.0` became `1`. The user's own hook command `cd x && ./check.sh <in >out` became `cd x && ./check.sh <in >out`. All keys were re-sorted alphabetically. …
     - **Fix:** Downgrade to nice and fix the premise. Share one helper pair: decode = json.NewDecoder(bytes.NewReader(raw)) + UseNumber() + Decode(&doc) + a second Token()/Decode that must return io.EOF (same pattern as readInputObject in command/parse.go), else report 'not valid JSON' and skip; encode = json.NewEncoder + SetEscapeHTML(false) + SetIndent("", " ") (Encode appends the newline). …
     - **Skeptic's correction:** Reproduced on a scratch HOME: 12345678901234567890 became 12345678901234567000, 1.0 became 1, 1e21 became 1e+21, && < > became & < >, keys were sorted. …
43. **Clone and disk-cleanup failures lose SimSlim's reason and the clone's UDID** [native helpers (Go sim helper, Swift host); risk] (`apps/desktop/native/rndevtools-sim-helper/internal/simulator/client.go:176`)
     - **Problem:** Each one replaces SimSlim's error with a fixed sentence. SimSlim's CloneDevice returns the new UDID along with an error when the clone is ready but the source's boot state could not be restored ('cloned simulator X, but could not restore the source boot state'). It also reports 'additionally could not delete the unsafe clone' in the error text. …
     - **Fix:** In client.go, keep SimSlim's error (wrap it with %w) and return the clone UDID together with the error when CloneDevice returns one. In service.go, append protocol.BoundedDetail(err.Error()) to clone_failed, disk_plan_failed and disk_cleanup_failed, and put a UDID that passes udidPattern into Details. …
     - **Skeptic's correction:** The finding is true. Vendored clone.go:60-72 returns (newUDID, err) when the clone is safe but the source boot state could not be restored. …
44. **Broker labels post-launch failures 'mutation_authorization_required'** [native helpers (Go sim helper, Swift host); risk] (`apps/desktop/native/rndevtools-native-host/Sources/RNDevtoolsNativeHost/SimulatorMutationBroker.swift:643`)
     - **Problem:** The Go helper and Electron use mutation_authorization_required to mean 'refused before any Simulator access'. slimming-service.ts:89 lists it in NO_MUTATION_ERROR_CODES as proven safe, and NativeHostResponseError exists so that 'a refused attestation can be told apart from a helper that died mid-operation'. …
     - **Fix:** Use the existing 'simulator_helper_failed' code for every error thrown after kill(SIGCONT). Keep mutation_authorization_required for attestation and the checks before resume.
45. **HeroUI Pro payload is outside the lockfile and release-age policy** [tooling, CI, example and docs; risk] (`pnpm-workspace.yaml:16-20 (allowBuilds), pnpm-lock.yaml:1507-1508,7679-7682`)
     - **Problem:** The lockfile pins and integrity-checks only a stub tarball (dependencies chalk + heroui-pro CLI). At install time the postinstall replaces the package directory with code downloaded from HeroUI's CDN. That code is what electron-vite bundles into the signed desktop renderer: 18 renderer modules import it. No pnpm integrity hash or release-age rule covers those bytes, and any check the obfuscated downloader makes is against data from the same CDN.
     - **Fix:** Hash from inside the package so the nested node_modules is really excluded and paths do not depend on where the command runs: `(cd node_modules/@heroui-pro/react && find . -type f -not -path './node_modules/*' -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) | shasum -a 256`. Compare the result with a digest committed next to the pin. …
     - **Skeptic's correction:** The finding holds. pnpm-lock.yaml:7679-7682 pins a stub (chalk 5.6.2 + heroui-pro 1.0.0-beta.12). The installed package.json lists @internationalized/* and @react-stately/utils, and 543 payload files were written at install time (2026-09-24) over the 16 stub files. Lockfile integrity and minimumReleaseAge cover only the stub. …
46. **Images panel does O(n²) work on every render** [packages/core; scale] (`packages/core/src/plugins/images.tsx:298-339, 360-383, 575-604, 630, 671`)
     - **Problem:** analyzeImageDiagnostic filters all entries to count failures for one fingerprint. summarizeImageDiagnostics calls it for every entry, and every recent row (up to 80) calls it again, with no memoisation. Each beginLoad, recordLoad, recordDisplay or recordError re-renders the panel.
     - **Fix:** Build a per-fingerprint failure-count Map once (inside summarizeImageDiagnostics and a useMemo in the panel). Pass it through an internal helper or an optional extra parameter, keeping the exported analyzeImageDiagnostic(entry, entries) signature. Severity is nice at default limits and should only when maxEntries is raised.
     - **Skeptic's correction:** The O(n²) shape is real (images.tsx:338-342 runs inside summarize and per row) and the 114k / ~100M call counts are right. The impact is overstated, though. Bench (f08-images.test.ts, V8): 0.9 ms per render at 300 entries and 19 ms at 2,000. …
47. **Running stacks show 'Checking…' after launch when more than 16 stacks exist** [desktop: local Supabase; scale] (`apps/desktop/src/main/supabase/service-engine.ts:1979-2025 (MAX_STATUS_READS_PER_LIST at 234)`)
     - **Problem:** At boot every listed stack counts as changed. The 16 reads go to the first entries in CLI order, stopped stacks included, although a stopped stack's state already follows from owner 'unavailable'. A running stack later in the list gets no status, so stackStateFor returns 'unknown'. The availability rules then refuse Restart, Read database and Copy URL with "Start the stack first." until the next list, which can take up to 5 minutes.
     - **Fix:** One line: sort `changed` so entries with `owner === 'reachable'` come first before `.slice(0, MAX_STATUS_READS_PER_LIST)`.
48. **Restore-point import and rollback-failure paths have no tests** [packages/core; test] (`packages/core/src/plugins/restore-repository.ts:439-467; restore-transaction.ts:303-318, 449-464; restore-points.tsx:626-645`)
     - **Problem:** These paths change or can corrupt app state, but no test exercises them. A regression where merge drops existing points, replace skips the limit check, or a failed rollback is reported as 'rolled-back' would pass CI.
     - **Fix:** Add tests: importJson replace, merge, duplicate-id and over-limit; a source whose restore throws on apply and again on rollback, expecting status 'needs-attention' and the restore() error text; the same for resetToBaseline.
49. **Broker candidate rotation and the connect timeout have no test** [packages/react-native; test] (`packages/react-native/src/desktop/client.ts:879-886, 912-935, 950, 1124-1132; src/desktop/client.test.ts (every client uses candidates: [BROKER_URL])`)
     - **Problem:** The suite never runs these lines (the coverage run lists them as uncovered). This is what finds the broker when the desktop falls back from port 47931 to 47932-47940. If a change stopped candidateIndex from advancing, devices would dial a dead port forever and every test would still pass.
     - **Fix:** Add a test with two candidates. The first socket closes without opening; in a second variant it never opens and the test advances 3.5 s. Assert the second URL is dialed. Then open it, close it from the server side, and assert the reconnect reuses the second URL.
50. **The Simulator and slimming approval tokens in index.ts have no test** [desktop: main process, preload, shared; test] (`apps/desktop/src/main/index.ts:1054-1393`)
     - **Problem:** About 340 lines of this glue live inline in the Electron entry file, so no unit test runs them. The other IPC areas (capture, recipe, lane, Supabase, Build Insights, onboarding) were moved into `*-ipc.ts` modules that have tests. The existing confirmation tests build the token payload by hand (simulator-confirmation.test.ts:98-145), so they keep passing even if the handler's issue and consume sides change. …
     - **Fix:** Move these handlers into `simulator-ipc.ts` and `slimming-ipc.ts` with the dialogs injected, the way recipe-ipc.ts is built. Add tests for three cases: a token approved for one action or UDID is refused for another; a cancelled dialog cleans up the staged certificate; a request that carries an existing token is refused.
51. **Desktop and Simulator runtime action gates have no tests** [desktop: renderer; test] (`apps/desktop/src/renderer/state/desktop-runtime.tsx:184-256; apps/desktop/src/renderer/state/simulator-runtime.tsx:305-389`)
     - **Problem:** Nothing tests these rules. Changing `!(result.ok && dismissed)` to `!dismissed` would hide a rejected storage write or Zustand patch after the user dismissed 'Sending action to device…', and no test would fail. The Recipe and Slimming runtimes put the same token rule into pure helpers with tests (confirmAndRunRecipe, confirmSlimmingSettingRequest).
     - **Fix:** Extract desktopActionNotice(result, { latest, dismissed }, successMessage) and confirmSimulatorAction(bridge, action), modelled on confirmAndRunRecipe. Add 3 to 4 cases each: dismissed success, dismissed failure, missing token, cancelled dialog.
52. **No test ties the Go command validator to the desktop's zod schema, and they already drift** [agent CLI (Go); test] (`apps/desktop/native/rndevtools-cli/internal/command/command_test.go:16 (TestValidateMatchesServerCommandUnion) and :346 (TestSupabaseValidateMatchesTheDesktopRules) vs apps/desktop/src/shared/agent-cli-protocol.ts`)
     - **Problem:** I bundled agent-cli-protocol.ts with esbuild into /tmp and ran 27,105 mutated commands (every field removed or set to boundary values, strings at length edges, emoji, unknown keys) through both validators. They disagreed on 194 inputs in 21 groups. …
     - **Fix:** Add one shared fixture of command JSON with expected ok/not-ok, for example internal/command/testdata/commands.json. Have command_test.go and src/shared/agent-cli-protocol.test.ts both iterate it, so a change on either side fails the other's suite. Seed it with the drifts above and decide each in the fixture.
53. **The real image composer has no test** [native helpers (Go sim helper, Swift host); test] (`apps/desktop/native/rndevtools-native-host/Sources/RNDevtoolsNativeHost/ImageComposer.swift:15`)
     - **Problem:** Every Swift test injects StubImageComposer, and no script runs compose_image. PROTOCOL.md promises symlink and ownership checks, an O_EXCL temp reservation, the link() commit and cleanup, yet no test fails if any of them breaks. The literal temp-file name (next finding) went unnoticed for this reason.
     - **Fix:** Add one test that sets CFFIXED_USER_HOME to a temp directory and stages a small PNG in a 0700 workspace. Run SystemImageComposer and assert that the output exists, the inputs and temp file are gone, and a symlinked inputs directory is refused.
54. **Packaging logic is first exercised by the tag-triggered release** [tooling, CI, example and docs; test] (`.github/workflows/ci.yml:39-68, .github/workflows/release.yml:12-101, apps/desktop/scripts/after-pack.cjs`)
     - **Problem:** CI's desktop job runs only native:check and quality, so `native:build`, `package`, after-pack and the cold-start check run for the first time on a v* tag. publish-packages runs in parallel and does not depend on desktop-app. An Electron bump that adds a fuse, an electron-builder update that changes `packager.helper.buildSignOptions`, or an after-pack edit passes CI and breaks the release after the npm packages are already out.
     - **Fix:** In ci.yml's desktop job, add `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @rndevtools/desktop package` followed by `pnpm --filter @rndevtools/desktop native:verify:cold-start`. In release.yml, add `needs: desktop-app` to publish-packages so a broken package blocks the npm publish.
55. **Desktop e2e specs and test configs are never typechecked** [tooling, CI, example and docs; test] (`apps/desktop/tsconfig.node.json:7-13, apps/desktop/tsconfig.renderer.json:10-15, apps/desktop/e2e/shell.e2e.ts:55`)
     - **Problem:** Neither config includes e2e/**, playwright.config.ts, vitest.config.ts or electron.vite.config.test.ts. Biome lints those files and knip analyses them, but tsc never checks them, and e2e is not in CI. A harness signature change can break the specs silently. Five type errors already exist: `const { window } = harness` shadows the browser global inside `evaluate` callbacks.
     - **Fix:** Add an `e2e/tsconfig.json` that extends ../tsconfig.json with lib ES2023+DOM and types node, includes e2e/**/*.ts and the three root config/test files, and append `&& tsc --noEmit --pretty false -p e2e/tsconfig.json` to typecheck. In shell.e2e.ts, use `const page = harness.window`.
56. **limitDesktopProjection keeps JSON-serializing every remaining row after the byte budget is full** [packages/react-native; speed] (`packages/react-native/src/desktop/projection.ts:67-91 (the `continue` at line 85)`)
     - **Problem:** Once the kept rows fill maxBytes, the loop carries on and JSON.stringifies every remaining row only to find it does not fit. With large rows, such as network entries with captured bodies, that is hundreds of milliseconds per call on the app's JS thread.
     - **Fix:** Skip rows that can never fit (utf8 bytes + 2 > maxBytes) with `continue`. `break` at the first row that fails only because the retained rows have used the budget. This keeps a contiguous newest window apart from unshippable rows, and stops the scan once the budget is full. Add tests for an oversized newest row and for the early stop. Drop the WeakMap idea.
     - **Skeptic's correction:** Reproduced in Jest/V8 with the real module: 2,000 rows of 64 KiB, 4 MiB budget. The current code makes 2,000 stringify calls at about 460 ms per call, with core's JS utf8ByteLength walk on each row. The break variant makes 64 calls at about 14 ms and keeps the same 63 rows. …
57. **Every agent tap and screenshot first lists all Simulators (~0.3 s), and screenshots do it twice** [desktop: main process, preload, shared; speed] (`apps/desktop/src/main/agent-command-router.ts:1559-1562, 1959, 1985, 2005; simulator-service.ts:1266-1270`)
     - **Problem:** A refresh runs `xcrun simctl list --json`, which took 0.29 to 0.33 s on this Mac. Every tap pays that. Screenshots pay it twice, because the queued job lists the inventory again when it runs (simulator-service.ts:1269). For an agent working in tap-then-screenshot loops, that adds about 0.9 s per step, more than the screenshot itself takes.
     - **Fix:** Look the UDID up in `simulator.getState()` and call `refresh()` only when the device is missing, or for input when it is not shown as booted. The refresh at execution time stays as the authoritative check.
58. **Three different 'make text safe for a dialog' functions** [desktop: main process, preload, shared; lean, merge] (`apps/desktop/src/main/simulator-confirmation.ts:25-41 (safePromptLine), desktop-action-confirmation.ts:26-45 (securityDialogText), security.ts:111-158 (sanitizeDialogText)`)
     - **Problem:** Three functions each strip a different set of characters. securityDialogText lets through the left-to-right and right-to-left marks, U+061C and the zero-width space. safePromptLine lets through U+061C and the zero-width space. One of them uses NFKC normalization, which the comment on sanitizeDialogText says hides look-alike characters. Example: a scenario id containing U+200E reaches the scenario dialog unchanged.
     - **Fix:** Use `sanitizeDialogText(value, { maxLength: 96, fallback })`, keeping each call's fallback, in desktop-action-confirmation.ts, and `sanitizeDialogText(name, { fallback: 'Unnamed Simulator' })` in simulator-confirmation.ts. Then delete securityDialogText and safePromptLine. Treat it as a small UI-visible change.
     - **Skeptic's correction:** The character gaps are as stated, once you count what /\s+/ already collapses (U+2028/2029/FEFF). securityDialogText misses U+200E/200F, U+061C and U+200B, and uses NFKC. safePromptLine misses U+061C and U+200B. Two corrections. desktop-action-confirmation passes its own fallback per call ('unknown device', 'unknown'), so `{ maxLength: 96 }` alone would drop them. …
     - **Not in the cleanup:** dialog text changes in edge cases.
### Nice to have

59. **On-device and desktop 'Invalidate' do different things** [packages/core; bug] (`packages/core/src/plugins/query.tsx:368-384 (runQueryAction), 608-617 and 489-496 (row Invalidate), 966-979 and 1097-1110 (Invalidate all)`)
     - **Problem:** runQueryAction('invalidate'), the hook a host wires to the desktop's query.invalidate, uses refetchType 'none'. The on-device buttons use TanStack's default, which also refetches active queries. The 'Invalidate all' confirmation says it only 'Marks every cached query as stale'.
     - **Fix:** Pick one meaning: either pass refetchType: 'none' everywhere, or drop it from runQueryAction and change the message to say active queries refetch.
60. **Reset to baseline ignores declared source dependencies** [packages/core; bug] (`packages/core/src/plugins/restore-transaction.ts:356-360 vs 110-184`)
     - **Problem:** Restore pulls in dependencies and applies them in dependency order (resolveOrder). Reset uses registration order and does not pull in dependencies.
     - **Fix:** Order the selected sources with the same topological visit as resolveOrder (extract it) before capturing rollback data and applying.
61. **Floating window filters tools and colours status badges differently from the sheet** [packages/core; bug] (`packages/core/src/components/floating-window.tsx:297-302, 369-405; tools-sheet.tsx:139-148, 248-297, 555-579`)
     - **Problem:** The window matches the query against title or description, while the sheet matches title only. The window paints every badge colors.orange, while the sheet uses BADGE_TONES by tone. The Android sheet's status-row block and the window's are near-copies.
     - **Fix:** Use one RN HomeStatusRows component (with BADGE_TONES) in the Android sheet and the window, and one plugin-match predicate in all three.
     - **Not in the cleanup:** changes what the floating window shows.
62. **Ordinary words in a request body block replay and cURL body export** [packages/core; bug] (`packages/core/src/plugins/network-presentation.ts:71-72, 299-328, 665-683`)
     - **Problem:** The regex matches bare words such as 'truncated', 'circular', 'redacted' and 'unreadable' anywhere, but the collector always writes its markers in brackets, as [REDACTED] or %5BREDACTED%5D.
     - **Fix:** Allow a bounded run inside the bracket: /(?:\[|%5B)[^\][%]{0,48}?(?:redact|omitted|unreadable|truncated|cancelled|depth limit|circular)/i. Tested: it matches every collector marker, including '[Value omitted: input limit]' and '[Header omitted: input limit]' that today's regex also misses. It rejects the bare-word examples and stays linear (0 ms on 200k '['). Add tests for each marker and for the bare words.
     - **Skeptic's correction:** The false positives are real and affect URLs and headers as well as bodies ('order truncated by user' matches). The proposed fix is unsafe. …
63. **Scenario recovery is re-checked with default limits, so larger scenarios can't be undone after a restart** [packages/core; bug] (`packages/core/src/plugins/scenario-engine.ts:1318 (#parseRecovery), 136-143 (ScenarioEngineOptions)`)
     - **Problem:** #parseRecovery calls parseScenarioDefinition(raw.scenario) with DEFAULT_SCENARIO_DEFINITION_LIMITS (256 KiB). ScenarioRepository accepts custom, larger limits, and the engine has no limits option.
     - **Fix:** Add definitionLimits to ScenarioEngineOptions and pass it into parseScenarioDefinition in #parseRecovery.
64. **Restore point rename and import skip the label redaction that capture and duplicate apply** [packages/core; bug] (`packages/core/src/plugins/restore-repository.ts:375-397 (rename), 155-163 (parsePoint) vs restore-points.tsx:567-569 and restore-repository.ts:408-411`)
     - **Problem:** capture() and duplicate() run redactDiagnosticText on the label. rename() and importJson (parsePoint) store the label as given, and labels go to the desktop snapshot (restorePoints[].label).
     - **Fix:** In rename and parsePoint use truncateText(redactDiagnosticText(label.trim()), 256).text, as capture() does, and reject only empty results. Never reject on post-redaction size during hydrate.
     - **Skeptic's correction:** True: rename (restore-repository.ts:375-397) and parsePoint (:155-163) only boundedText the label, while capture (restore-points.tsx:567-569) and duplicate (:408-411) redact. Labels reach the desktop through the host's captureTools (restorePoints[].label), and the client only JSON-stringifies them. …
65. **Types that public APIs take are not exported from the plugins entry point** [packages/core; bug] (`packages/core/src/plugins/index.ts:110-126, 210-222`)
     - **Problem:** The ScenarioEngine constructor takes ScenarioEngineOptions and ScenarioRecoveryStorage, and NavigationPlugin.beginTransition/navigate/getTransitions use NavigationTransitionContext and NavigationTransitionEvent. None is re-exported, and package.json 'exports' blocks deep imports.
     - **Fix:** Re-export these four types from plugins/index.ts.
66. **Android cache key ignores the target ABI** [packages/react-native; bug] (`packages/react-native/build-cache.js:112-130 (toolchainSegment) and the header comment at :20-21`)
     - **Problem:** Expo's debug Android builds contain only the connected device's ABI (-PreactNativeArchitectures). Expo also uses the cache for physical Android devices, not only emulators as the comment says. Example on an Intel Mac: one worktree builds for an x86_64 emulator, and another worktree running on an arm64 phone gets that APK and fails with INSTALL_FAILED_NO_MATCHING_ABIS. The same happens with armeabi-v7a phones on Apple Silicon.
     - **Fix:** Cache Android only when runOptions.allArch is true: otherwise return null without claiming and skip the upload. Correct the comments at :20-21 (physical Android devices use the cache too) and :112-117 (the target ABI is not in the key).
     - **Skeptic's correction:** True. runAndroidAsync.js:62 resolves the cache with no emulator check, so physical devices use it. resolveGradlePropsAsync.js:70-79 builds only the connected device's first ABI for debug builds unless allArch is set (Expo reads ro.product.cpu.abilist, not ro.product.cpu.abi). toolchainSegment for Android uses the host arch only, and the comments at :20-21 and :112-117 are wrong. …
67. **iOS cache key ignores --scheme** [packages/react-native; bug] (`packages/react-native/build-cache.js:138-152`)
     - **Problem:** `expo run:ios --scheme ExampleApp-Staging` and a default-scheme run with the same fingerprint and configuration share one entry. Whichever runs second installs the other scheme's .app, which has a different bundle id and build settings.
     - **Fix:** Append safeSegment(runOptions.scheme) to the configuration segment when a scheme is set.
68. **Pruning matches a relative module name in every directory** [packages/react-native; bug] (`packages/react-native/metro.js:174-175`)
     - **Problem:** The README allows `module` to be a project-relative path with no `path`. With module: './devtools', any other file that imports its own sibling './devtools', for example src/screens/index.ts, also gets the stub in release builds. That module then has the wrong exports at runtime.
     - **Fix:** Skip the name match when entry.module starts with '.' or is absolute. The resolved-file match at lines 176-185 already covers those entries.
69. **On an Android emulator, passing desktopBrokerCandidates() output into startDesktopClient drops 10.0.2.2** [packages/react-native; bug] (`packages/react-native/src/desktop/client.ts:519-535`)
     - **Problem:** The alias is allowed only when `candidates` is undefined, yet the exported helper adds ws://10.0.2.2 for emulators. startDesktopClient has no port option, so a host on a non-default port builds candidates with the helper and passes them in. The client then dials only 127.0.0.1 and localhost, which inside the emulator is the emulator itself, so it never connects.
     - **Fix:** Compute the flag the same way the helper does: Platform.OS === 'android' && Device.isDevice === false && !process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_URL.
70. **imageOverlay.setSource and clear skip the remote-import guard and the file cleanup** [packages/react-native; bug] (`packages/react-native/src/diagnostics/image-overlay.ts:46-48, 64-102`)
     - **Problem:** The README names only `imageOverlay` (the raw controller). Suppose a host applies a local pick with imageOverlay.setSource() while setRemoteImageOverlaySource() is still downloading. When the download lands, it replaces the user's pick, because the generation counter was never bumped. imageOverlay.clear() also leaves the downloaded file (up to 20 MiB) in the cache.
     - **Fix:** Route the exported controller's setSource and clear through the wrappers as proposed, and leave patch, getSnapshot and subscribe raw. In the wrapped setSource, keep activeRemoteImage when the new source's renderUri is that file's URI. Document setRemoteImageOverlaySource and clearImageOverlay in README 296-308.
     - **Skeptic's correction:** True. remoteImportGeneration only changes in the wrappers (67, 75, 97), so a raw imageOverlay.setSource during a download is overwritten when the download lands. A raw clear() leaves a file of up to 20 MiB until the next import. The README names only imageOverlay and configureImageOverlay, and nothing in the tree calls the wrappers. …
71. **RNDEVTOOLS_BUILD_CACHE_DIR is neither ~-expanded nor made absolute, unlike cacheDirectory** [packages/react-native; bug] (`packages/react-native/build-cache.js:66-67 vs 142-144`)
     - **Problem:** Set RNDEVTOOLS_BUILD_CACHE_DIR=~/rn-cache somewhere no shell expands it (launchd, a GUI app's environment), or set any relative value. The result is a path relative to each worktree's working directory. Every worktree then gets its own cache, so nothing is shared, plus a stray '~' directory inside its tree.
     - **Fix:** `return path.resolve(expandHome(env.RNDEVTOOLS_BUILD_CACHE_DIR, homedir))`, passing the injected homedir. This fixes '~'. If relative roots should be shared, reject them or anchor them to the home directory for both the env var and cacheDirectory, and say so in build-cache.d.ts. Otherwise drop the 'every worktree gets its own cache' claim for relative values.
     - **Skeptic's correction:** The '~' part is real, and more likely than stated. `expo run` loads every key from the project's .env files into process.env (@expo/env load, called from runIosAsync.js:107) before calling the provider, and .env never expands '~'. The probe got the literal path '~/rn-cache/ios/...'. The relative-path part is overstated. …
72. **The friendly 'server busy' replies can never be sent** [desktop: main process, preload, shared; bug] (`apps/desktop/src/main/agent-cli-service.ts:295 and 375-386; broker.ts:476 and 502-505`)
     - **Problem:** Both also set `server.maxConnections` to that same number, and Node then closes the extra connection before the handler ever runs. The busy branches are dead code, and an agent over the limit gets a bare 'read response: EOF' transport error instead of `server_busy`. Eight is reachable with a handful of agents, because `lane up` holds a connection for up to 230 s, `wait` for up to 10 minutes, and agents make tool calls in parallel.
     - **Fix:** Set `server.maxConnections` a few above the in-code limit (for example `MAX_CONNECTIONS + 4`) so the typed reply is actually sent, and consider raising the agent limit to about 16. Alternatively, delete the dead branches.
73. **Monthly build activity is grouped by UTC month** [desktop: main process, preload, shared; bug] (`apps/desktop/src/main/build-insights-store.ts:375-382`)
     - **Problem:** The month comes from `getUTCFullYear` and `getUTCMonth`. A build at 20:00 on 31 October in California, which is 03:00 UTC on 1 November, is counted in November.
     - **Fix:** Use `getFullYear()` and `getMonth()` instead.
74. **Scenario import says "looks valid" for documents the real parser rejects** [desktop: renderer; bug] (`apps/desktop/src/renderer/panels/scenarios-panel.tsx:82-106 (test scenarios-panel.test.ts:38-42)`)
     - **Problem:** It only checks for JSON with a non-empty scenarios array. The authoritative parser (core parseScenarioDocumentJson, used by main) also requires schemaVersion and namespace, allows no extra keys, and parses every definition. Pasting {"scenarios":[{"id":"x"}]} shows 'looks valid', and the import then fails with 'unsupported schema'. The test codifies that document as valid.
     - **Fix:** Keep the empty-text check and the 'Add at least one scenario to import.' check, then call parseScenarioDocumentJson(text, { maxScenarios: DEFAULT_SCENARIO_USER_LIMIT }) and return its error message. Update both scenarios-panel.test.ts and e2e/scenarios.e2e.ts:48-50 to use a full document: schemaVersion 1, namespace 'rndevtools-scenarios' and a real definition.
     - **Skeptic's correction:** validateScenarioImport only checks for JSON with a non-empty array. Main (desktop-action-confirmation.ts:80) runs parseScenarioDocumentJson with maxScenarios: DEFAULT_SCENARIO_USER_LIMIT (25), which rejects a missing schemaVersion or namespace and any extra keys. The parser is in the renderer bundle via desktop-runtime, browser-bridge and demo-data. …
75. **Deep links reset the other workspace's remembered tool** [desktop: renderer; bug] (`apps/desktop/src/renderer/app.tsx:254-275, 331-335`)
     - **Problem:** onHashChange replaces the whole route with routeFromHash(), which fills the half the hash does not name with defaults. On Connected › Zustand, press ⇧⌘S, then 'Open in Lanes' in Fleet. ⇧⌘C now opens Network, not Zustand.
     - **Fix:** Merge instead of replacing: setRoute((current) => ({ ...current, ...parsed })), where parsed sets only the workspace and tool named in the hash.
76. **Connected sidebar shortcut hint reads "⌘ ⌘ B" on macOS** [desktop: renderer; bug] (`apps/desktop/src/renderer/app.tsx:1004, 1084-1092 (duplicate rule at 75-77)`)
     - **Problem:** On darwin it renders the lucide Command icon (which draws ⌘) followed by the text '⌘ B'. The Simulator footer correctly renders icon + '1–9'. It is also a second copy of sidebarShortcut() with different spacing ('⌘B' vs '⌘ B').
     - **Fix:** Render the icon followed by 'B' on darwin and 'Ctrl B' elsewhere, derived from sidebarShortcut(). Delete the local string.
77. **"Camera fixtures" badge shows 0 when nothing is active or no device is connected** [desktop: renderer; bug] (`apps/desktop/src/renderer/tool-config.ts:120 (compare 87-88)`)
     - **Problem:** Camera returns `active ? 1 : 0`, while Test identities uses the same rule with undefined. With no device connected, every other tool shows nothing and only 'Camera fixtures' shows 0.
     - **Fix:** `count: (device) => (device?.tools.cameraFixture.active ? 1 : undefined)`.
78. **setup checks its inputs only after it has started writing** [agent CLI (Go); bug] (`apps/desktop/native/rndevtools-cli/internal/setup/setup.go:112-180 (run, unknown-agent check at :179) and internal/app/setup.go:57-120 (runSetup)`)
     - **Problem:** An unknown agent name is rejected only when the loop reaches it, after earlier steps have been applied. `HOME=<fake> rndevtools setup --agents claude,typo --no-link --no-hook` wrote ~/.claude.json and then printed setup_failed 'unknown agent "typo"' with exit 7. That is the internal-failure code for a usage error, and the partial report is thrown away. A trailing comma (`--agents claude,`) behaves the same. …
     - **Fix:** Validate before any write. Check every name in options.Agents against the four known agents (reject empty names) and return a usage error, exit 2. Require options.Project to be an existing directory. In runSetup report err.Error() from flag.Parse so the flag is named. On a mid-run failure include report.Changes in the error JSON so the user can see what landed.
79. **Go caps the Supabase note at 240 UTF-16 units; the desktop (zod 4) counts code points, and a test pins the wrong answer** [agent CLI (Go); bug] (`apps/desktop/native/rndevtools-cli/internal/command/schema.go:875 and :941 (utf16Length); README.md:421; PROVENANCE.md:47; command_test.go (the 😀 x121 case)`)
     - **Problem:** zod 4.6.5, the version the desktop pins, counts string length in code points. I ran `z.string().max(240)` on 121 emoji (242 UTF-16 units) and it passed; 241 emoji failed. So a destroy or reset note of 121 to 240 emoji is accepted by the desktop and rejected by the CLI before it connects. The Go test TestSupabaseValidateMatchesTheDesktopRules asserts the opposite for 121 emoji, and the README and PROVENANCE repeat 'UTF-16 units'. …
     - **Fix:** Replace utf16Length(*value.Note) with utf8.RuneCountInString(*value.Note) and delete utf16Length. Flip the test: 240 emoji accepted, 241 rejected. Change the README and PROVENANCE wording to '240 characters'.
80. **protocol.DecodeResponse limits error text in bytes where the desktop limits it in UTF-16 units** [agent CLI (Go); bug] (`apps/desktop/native/rndevtools-cli/internal/protocol/protocol.go:239 and :242 (validateRemoteError)`)
     - **Problem:** The desktop truncates both with String.slice(0, 4096), which counts UTF-16 units, and its own response schema counts code points. Go measures len() in bytes. An error message of 1366 box-drawing characters (4098 bytes) or 1400 check marks is valid for the desktop but fails in Go with 'response error message is invalid'. The caller then sees invalid_response (exit 5) instead of the real typed rejection and its recovery text. …
     - **Fix:** Use utf8.RuneCountInString(...) > 4*1024 for Message and Recovery. Any value of at most 4096 UTF-16 units is at most 4096 runes, so valid desktop replies are never refused. Add a test with 2000 multi-byte characters.
81. **release --all passes CLI validation with a note; the desktop rejects it** [agent CLI (Go); bug] (`apps/desktop/native/rndevtools-cli/internal/command/schema.go:347-360 (claim/release case in Validate)`)
     - **Problem:** The `value.Note != nil` check sits after that early return, so it applies only to `release --udid`. `{"kind":"release","all":true,"note":"x"}` passes in Go but the desktop's strict schema answers 'Unrecognized key: note'. The same field is refused for `release --udid` ('release does not accept note'). The user gets a typed desktop rejection (exit 6) instead of the local usage error (exit 2).
     - **Fix:** Before the `if value.All != nil` block add `if expectedKind == protocol.CommandRelease && value.Note != nil { return errors.New("release does not accept note") }`, and add `{"kind":"release","all":true,"note":"x"}` to the rejected list in command_test.go.
82. **The MCP server reports an oversized call as internal_error; the CLI reports invalid_arguments** [agent CLI (Go); bug] (`apps/desktop/native/rndevtools-cli/internal/mcp/server.go:630-642 (send) and :739 (classifyTransportError)`)
     - **Problem:** When the envelope is too big, EncodeRequest fails and the error goes through classifyTransportError, which returns code internal_error, non-retryable, with no recovery text. app.Run reports the same failure as invalid_arguments with 'Reduce the JSON payload so the complete request fits within 256 KiB' (and a test pins that). Over MCP a model sees 'internal_error: request exceeds 262144 bytes' and may blame the server or retry unchanged. A 300 KiB act payload reproduces it.
     - **Fix:** In send, when protocol.EncodeRequest fails return a tool error invalid_arguments with the same recovery sentence as app.Run, instead of passing the error to classifyTransportError. Add a test with a 300 KiB payload.
83. **simulator_status on a Shutdown Simulator returns matchingProfileIds: null** [native helpers (Go sim helper, Swift host); bug] (`apps/desktop/native/rndevtools-sim-helper/internal/simulator/client.go:241`)
     - **Problem:** This branch builds Status without MatchingProfileIDs, so the field encodes as null, and it skips the profile match that the Booted branch computes. sim-helper-client.ts:229 requires an array, so the only client would reject the response. Even if it accepted it, a Shutdown Simulator that exactly matches a profile would report no match. This is latent today because slimming-service.ts:1933 only asks about booted devices.
     - **Fix:** Move the profile-match loop (client.go:620-626) into a helper that takes a managed-disabled list. Call it from both branches, the Shutdown branch passing preparation.State.ManagedDisabledServiceIDs. Keep Device as the original Shutdown record, and assert [] in the shutdown status test.
     - **Skeptic's correction:** The finding is true. client.go:241-246 omits MatchingProfileIDs, so it encodes as null, and helperStatusSchema (sim-helper-client.ts:224-230) requires an array. It is not entirely latent: slimming-service.ts:1933-1936 filters on the state from the earlier device list, so a Simulator shut down between that list and the call reaches this branch, after a temporary boot. …
84. **Image-recipe integer decoder crashes on values near Int.max** [native helpers (Go sim helper, Swift host); bug] (`apps/desktop/native/rndevtools-native-host/Sources/RNDevtoolsNativeHost/ImageCompositionProtocol.swift:684`)
     - **Problem:** Double(Int.max) rounds up to 2^63, so the check 'double <= Double(Int.max)' lets 2^63 through and Int(double) then traps. A payload with any integer field set to 9223372036854775807 kills the host with SIGTRAP instead of returning invalid_payload. Electron's zod bounds keep such values out today.
     - **Fix:** Replace the range checks and the conversion with Int(exactly: number.doubleValue), which returns nil for non-integral, infinite or out-of-range values.
85. **Text input accepts DEL, then silently skips it** [native helpers (Go sim helper, Swift host); bug] (`apps/desktop/native/rndevtools-native-host/Sources/RNDevtoolsNativeHost/SimulatorInput.swift:123`)
     - **Problem:** The check 'isASCII && value >= 0x20' lets 0x7F (DEL) through, but KeyboardLayout cannot type it, and SimulatorInputSequencer.swift:69 drops characters it cannot map with 'continue'. So 'a<DEL>b' types 'ab' and reports success. Electron's shared schema (characters 0x20-0x7E plus newline and tab) already rejects DEL, so the two validators disagree.
     - **Fix:** Accept (0x20...0x7E) plus newline and tab, matching simulator-input-protocol.ts.
86. **Cold-start verifier's default app path is wrong on Intel Macs** [tooling, CI, example and docs; bug] (`apps/desktop/scripts/verify-packaged-cold-start.mjs:18-26`)
     - **Problem:** With no defaultArch set, electron-builder writes x64 apps to `release/mac/` (only non-default arches get a suffix), so on an x64 host the default path does not exist. lstatSync then throws an uncaught ENOENT stack. CI is arm64 (`release/mac-arm64`), which hides this.
     - **Fix:** Use `process.arch === 'x64' ? 'mac' : `mac-${process.arch}`` for the directory name.
87. **Cold-start crash check ignores helper process crash reports** [tooling, CI, example and docs; bug] (`apps/desktop/scripts/verify-packaged-cold-start.mjs:202-215`)
     - **Problem:** macOS names reports after the crashing process. Electron's helpers ('RN Devtools Helper (GPU)', '(Renderer)', '(Plugin)') and the native helpers (rndevtools-native-host, rndevtools-sim-helper) never match the prefix. A GPU-helper crash at launch caused by a bad nested signature produces a report while Electron falls back to software rendering, and the check passes. native/README.md:101-104 claims it 'rejects new macOS crash reports'.
     - **Fix:** Filter on `file.startsWith(packageManifest.productName) || file.startsWith('rndevtools')`.
88. **Linux `make` fails on the deb target** [tooling, CI, example and docs; bug] (`apps/desktop/package.json:6,120-126, apps/desktop/README.md:105`)
     - **Problem:** The deb target needs `linux.maintainer` or an author email. The author is 'Aren Dalloul' with no email, so `pnpm --filter @rndevtools/desktop make` on Linux throws "Please specify author 'email' in the application package.json".
     - **Fix:** Fix both causes. Set `build.linux.executableName` (e.g. `rn-devtools`) and have after-pack use `context.packager.executableName` for Linux instead of productFilename. Add `build.linux.maintainer`, or give the author an email. Alternatively, drop the linux targets and the README's 'AppImage and DEB on Linux' sentence.
     - **Skeptic's correction:** The deb requirement is real: FpmTarget.js computeFpmMetaInfoOptions throws authorEmailIsMissed for author 'Aren Dalloul'. But Linux `package` and `make` fail earlier. after-pack.cjs:26,40-45 flips fuses on `<appOutDir>/RN Devtools` (appInfo.productFilename). …
89. **PUBLISHING.md describes a different release process than release.yml** [tooling, CI, example and docs; bug] (`PUBLISHING.md:1-19, .github/workflows/release.yml:3-47`)
     - **Problem:** The two paths collide. If you follow the doc and then push the v* tag needed for the desktop artifacts, publish-packages fails with 'cannot publish over previously published version'. If you tag first, the doc's manual publish fails. The doc never mentions the workflow or provenance.
     - **Fix:** Rewrite PUBLISHING.md as: bump both versions, push a `vX.Y.Z` tag, and release.yml verifies, publishes with provenance and attaches the desktop artifacts. Keep the manual commands only as a fallback that must not be followed by a tag.
90. **verify:bundle writes to an un-ignored ./build** [tooling, CI, example and docs; bug] (`examples/expo-demo/package.json:9, examples/expo-demo/.gitignore`)
     - **Problem:** No .gitignore covers examples/expo-demo/build, so running the README's pruning check leaves the exported bundle and assets as untracked files that `git add -A` commits. expo export's default output, dist/, is already ignored at the root.
     - **Fix:** Drop `--output-dir ./build` and verify `./dist`.
91. **Image source labels keep unredacted URL paths** [packages/core; risk] (`packages/core/src/plugins/images.tsx:196-207`)
     - **Problem:** For http(s) sources it keeps origin + pathname as-is and drops only the query, hash and userinfo. Emails and tokens in path segments enter the images store and the panel. AGENTS requires redacting URLs before they enter a store.
     - **Fix:** `label: boundedLabel(redactDiagnosticText(`${url.origin}${url.pathname}`))`, as boundedTargetId already does, and set redacted when it changed.
92. **Capability registry lets one throwing listener stop the others** [packages/core; risk] (`packages/core/src/core/capabilities.ts:240`)
     - **Problem:** `for (const listener of [...listeners]) listener();` has no try/catch, unlike ExternalStore, BoundedEventStore and DevtoolsEventStore. A throwing subscriber makes reconcile() throw after the new state is already stored, and the remaining listeners are skipped.
     - **Fix:** Wrap each listener call in try/catch with the same 'observer must never interrupt' comment.
93. **Cached .app copies turn relative symlinks into links back into the builder's build folder** [packages/react-native; risk] (`packages/react-native/build-cache.js:414`)
     - **Problem:** fs.cpSync without verbatimSymlinks rewrites relative symlink targets as absolute paths into the source tree. If an .app contains a relative symlink (for example a bundle's Versions/Current -> A), the cached copy points into worktree A's DerivedData. Once that is cleaned or rebuilt, installs from the cache break or pick up A's newer files. The current demo .app (120 MB) has no symlinks, so this has not happened yet.
     - **Fix:** fs.cpSync(buildPath, staging, { recursive: true, verbatimSymlinks: true }).
94. **The lane reconcile timer and recipe cancel write to disk with no catch** [desktop: main process, preload, shared; risk] (`apps/desktop/src/main/lane-service.ts:468-476 (body 1662-1729); recipe-service.ts:528-540`)
     - **Problem:** Both writes are fire-and-forget (`void this.#reconcile()` and `void this.#save(...)`) with no `.catch`. If a write fails, for example because the disk is full or the folder is not writable, the promise rejection goes unhandled. Node turns that into an uncaught exception, and Electron shows its 'A JavaScript error occurred in the main process' box. The same failure inside `LaneService.start()` stops the whole app from starting. …
     - **Fix:** Allow one reconcile at a time: `this.#reconciling ??= this.#reconcile().catch((error) => { this.#error = safeError(error); }).finally(() => { this.#reconciling = undefined; })`. Add `.catch(() => undefined)` to the cancel save.
95. **A failed save at recipe start leaves its Simulators 'claimed' until restart** [desktop: main process, preload, shared; risk] (`apps/desktop/src/main/recipe-service.ts:497-511`)
     - **Problem:** It marks the targets first and then awaits `#save(record)`. If that write throws, the run never starts and nothing removes the marks. Every later run on those UDIDs is refused with '... is already claimed by another run.' until the app restarts.
     - **Fix:** Wrap the save in try/catch: on error, delete this run's marks and rethrow.
96. **Codex config edit can write a duplicate [mcp_servers.rndevtools] table, and deletes comments above the next table** [agent CLI (Go); risk] (`apps/desktop/native/rndevtools-cli/internal/setup/setup.go:327 (codexServerBlock) and :356 (writeCodexServer)`)
     - **Problem:** The regexp expects bare keys and LF line endings. With a CRLF config, or with a hand-written quoted table name `[mcp_servers."rndevtools"]`, nothing is stripped and a second `[mcp_servers.rndevtools]` table is appended, which is a duplicate table, so config.toml no longer parses and Codex fails to load it. The body pattern also accepts any line that does not start with `[`, so a comment line directly above the next table is deleted along with our table. That contradicts the comment 'leaves every other byte alone'. …
     - **Fix:** Keep 'skip instead of appending' but change the mechanics. (1) Make codexServerBlock tolerate `\][ \t]*\r?\n` and `\r?\n` blank lines so CRLF and trailing spaces strip cleanly. …
     - **Skeptic's correction:** Reproduced all of it: a CRLF config and `[mcp_servers."rndevtools"]` both end with two tables, and python tomllib rejects the result ('Cannot declare (mcp_servers, rndevtools) twice'); `# my other server` above the next table is deleted. …
97. **The session-end hook silently swallows every transport error, not only 'desktop not running'** [agent CLI (Go); risk] (`apps/desktop/native/rndevtools-cli/internal/app/setup.go:294-298 (runSessionEndHook)`)
     - **Problem:** Any error from Do returns ExitSuccess with no output, under a comment that says the desktop is not running. That holds for ErrorUnavailable only. A deadline against a live but busy desktop (the desktop's release budget is 1.5 s, the CLI deadline 2 s), a reset connection or a malformed reply is swallowed the same way. The agent exits believing it released its lanes. They stay held for the 10-minute grace and nothing says so; the closed socket may also make the desktop abort the release part-way.
     - **Fix:** Reclassify as cosmetic. Fix the misleading comment (only ErrorUnavailable means 'not running') and, if wanted, print one 'rndevtools hook session-end: <error>' line for other client errors while still exiting 0; do not present it as a data-loss risk, and expect nobody to read it.
     - **Skeptic's correction:** The code claim holds: with a server that never answers, resets, or sends garbage, the hook exits 0 with empty stderr (2 s for the hang), and the comment is true only for ErrorUnavailable. …
98. **Broker pins the desktop bundle ID that also lives in package.json** [native helpers (Go sim helper, Swift host); risk] (`apps/desktop/native/rndevtools-native-host/Sources/RNDevtoolsNativeHost/SimulatorMutationBroker.swift:14`)
     - **Problem:** It duplicates build.appId in apps/desktop/package.json:76, and nothing checks that the two agree. The team ID is injected at build time precisely so that a fork can sign its own build. A fork that also changes appId gets every mutation refused with 'The desktop parent is not a production-signed desktop application.'
     - **Fix:** Derive the identifier from package.json at build time, together with the version from the helperVersion finding, or make build-native-helpers.mjs fail when the two differ.
99. **Desktop pins outside the catalog with caret ranges, against AGENTS.md** [tooling, CI, example and docs; risk] (`AGENTS.md:47, apps/desktop/package.json:39-73, apps/desktop/scripts/after-pack.cjs:79-92,123-131`)
     - **Problem:** The desktop manifest has 17 non-catalog specifiers, 9 of them caret ranges, and the root and example add 4 more. One is electron-builder ^26.17.0, while after-pack.cjs calls its private MacTargetHelper API (findSigningIdentity, a 7-argument buildSignOptions, doSign). A routine `pnpm update` can therefore change signing internals, which only the release job exercises. @heroui/react is pinned in the manifest while @heroui/styles, which must move with it, is in the catalog.
     - **Fix:** Pin electron-builder exactly. Its app-builder-lib dependency is already exact (26.17.0), so this freezes the MacTargetHelper API that after-pack.cjs calls. Then either move @heroui/react into the catalog beside @heroui/styles, along with the other desktop pins, or reword AGENTS.md:47 to say 'shared dependencies'. Fix the count to 10 caret ranges.
     - **Skeptic's correction:** A manifest scan confirms 17 non-catalog desktop specifiers, but 10 of them are caret ranges, not 9. Root turbo and the example's three expo-* packages are exact non-catalog pins. The lockfile pins exact versions (electron-builder 26.17.0), so drift needs a deliberate `pnpm update`. after-pack's calls match MacTargetHelper.d.ts:14-15. …
100. **Turbo's strict env mode drops the opt-in integration-test variables** [tooling, CI, example and docs; risk] (`turbo.json:11-26, apps/desktop/AGENTS.md:31`)
     - **Problem:** Running `RNDEVTOOLS_SUPABASE_IT_BIN=... RNDEVTOOLS_SUPABASE_IT_HOME=... pnpm test` (or `pnpm quality`) at the root strips both variables, so the suites hit `describe.skipIf(!enabled)` and the run is green without running them. The same goes for RNDEVTOOLS_SUPABASE_PROBES. AGENTS.md only says 'set' the variables.
     - **Fix:** Add `"env": ["RNDEVTOOLS_SUPABASE_IT_*", "RNDEVTOOLS_SUPABASE_PROBES"]` to the test:run task.
101. **Network actions are refused after 256 per tools session** [packages/core; scale] (`packages/core/src/plugins/network.tsx:2961-2992, 1502-1510`)
     - **Problem:** Entries are never evicted inside a session, so call 257 is rejected ('The network action receipt limit was reached for this session.') until the authority or session resets. The coordinator behind it prunes settled receipts instead.
     - **Fix:** When full, evict the oldest settled receipt (as createDevToolsActionCoordinator's prune() does). The replay window becomes the last 256 IDs; the desktop client keeps its own replay guard.
102. **Repeated warnings fill the 200-line diagnostics log, and an oversized snapshot is rebuilt every second** [packages/react-native; scale] (`packages/react-native/src/desktop/client.ts:683-689, 926-932, 1125-1131`)
     - **Problem:** With no desktop running, the discovery warning is logged once per sweep, about every 4.5 s (20 candidates × 100 ms plus 2.5 s), so it fills all 200 slots in about 15 minutes. A snapshot over 8 MiB is captured again, fully stringified and logged as an error on every 1 s tick. That fills the log in 200 s, and the JS thread pays for the capture every second even though nothing is sent.
     - **Fix:** Log each condition once until it clears, the way the file already does with backpressureReported and reportedTrim. After an oversize, skip capturing until the next action or a longer backoff.
103. **Remote reference-image import paths have no test** [packages/react-native; test] (`packages/react-native/src/diagnostics/image-overlay.ts:81-93; image-overlay-import.ts:145-171, 263-298`)
     - **Problem:** The suite never runs any of them (coverage lists them as uncovered). Removing the generation check, or breaking cleanup on a validation failure, would pass every test.
     - **Fix:** Add tests for: two overlapping setRemoteImageOverlaySource calls where the first resolves last (the second image stays and the first file is deleted), a cache-size mismatch that deletes the file, and lossless and lossy WebP header fixtures.
104. **Client replay and admission-refusal wiring is untested** [packages/react-native; test] (`packages/react-native/src/desktop/client.ts:802-816, 1056-1074`)
     - **Problem:** Those two classes have their own unit tests, but the client code that uses them does not: a repeated actionId should return the stored result without running the host again, a reused id with different contents should get the conflict error, and a full queue or the rate limit should refuse the action. The coverage run lists these lines as uncovered. Dropping the lookup would run a replayed action twice and every test would still pass.
     - **Fix:** Add client-level tests: the same action sent twice calls runAction once and returns two identical results; the same id with a different payload returns the conflict error; with 16 hung actions pending, the 17th is refused with 'queue is full'.
105. **Lint skips the shipped pruning and verifier scripts** [tooling, CI, example and docs; test] (`packages/react-native/package.json:44-56, examples/expo-demo/package.json:7`)
     - **Problem:** packages/react-native ships metro.js (withDevtoolsPruning), verify-bundle.mjs and build-cache.js from the package root, and the example's metro.config.js and app.config.js sit outside src. None of them is linted, and tsc covers only src. A lint-class bug in either half of the 'pair' passes `quality`.
     - **Fix:** Use `biome check src *.js *.mjs *.d.ts` in packages/react-native and `biome check src *.js *.ts` in the example.
106. **Console rebuilds a set of every retained ID on each log, even with no bookmarks** [packages/core; speed] (`packages/core/src/plugins/console.tsx:507-512 (called at 607 and 634)`)
     - **Problem:** It maps all retained events into a Set on every ingested log, even when there are no bookmarks, which is the usual case.
     - **Fix:** Return early: `if (bookmarksStore.getSnapshot().length === 0) return;`.
107. **Every broker push re-renders the open Simulator panel** [desktop: renderer; speed] (`apps/desktop/src/renderer/app.tsx:294, 407-414, 447-451, 1098-1130`)
     - **Problem:** The broker emits connected-app state up to every 100 ms. Each push re-renders App, then SimulatorContent, then the open panel (Supabase, Automation, Captures…), none of which read desktop state. ConnectedContent is memoized against the opposite direction, but SimulatorContent is not, and setSimulatorTool is a new function on every render.
     - **Fix:** Wrap setSimulatorTool in useCallback and SimulatorContent in memo, as ConnectedContent already is.
108. **Native helper tests run twice on two macOS runners** [tooling, CI, example and docs; speed] (`.github/workflows/ci.yml:70-92`)
     - **Problem:** On every push to main and every same-repo PR, the Desktop job's `native:check` already runs gofmt, vet, `go test -race`, govulncheck, swift format lint and swift test on the same sources. native-tests repeats a near-subset of that on a second macOS runner.
     - **Fix:** Add `if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository` to native-tests. A skipped required check reports success.
     - **Since the audit:** fixed by `d8e87f5` and `c0a3d04`, merged in `19eafeb`: one native job runs the Go gate and a Swift build, and the desktop job no longer repeats it.
109. **FloatingLauncher and MiniPill duplicate the snap-drag logic** [packages/core; lean, merge] (`packages/core/src/components/floating-launcher.tsx:36-137; mini-pill.tsx:42-151`)
     - **Problem:** Both are copies differing only in item width and spring constants, and they must change together (both carry the same 'host echo cancels the spring' fix).
     - **Fix:** Extract a useSnapDrag({ itemWidth, itemHeight, bottomObstructionInset, initialPosition, onPositionChange, spring }) hook returning { gesture, animatedStyle }. Worklets still compile in the host's Babel pipeline.
     - **Not in the cleanup:** needs a device check of the Reanimated worklets.
110. **The scenario document format has two parsers** [packages/core; lean, merge] (`packages/core/src/scenario-model.ts:90-152; packages/core/src/plugins/scenario-repository.ts:68-121 (namespace literal at :73 and :97)`)
     - **Problem:** They already differ: one rejects extra top-level keys and the other doesn't; one caps documents at 512 KiB, the other at 4 MiB. The repository hard-codes 'rndevtools-scenarios' instead of SCENARIO_DOCUMENT_NAMESPACE, so the desktop and device can disagree on what is a valid document.
     - **Fix:** Raise the model's ceiling, or accept maxDocumentBytes up to the repository's 4 MiB cap, keeping the desktop default at 512 KiB. Then have importJson call parseScenarioDocumentJson(value, { maxScenarios: #maxUserScenarios, definitionLimits: #limits, maxDocumentBytes: <repository cap> }). Keep the lenient partial pass for hydrate, use SCENARIO_DOCUMENT_NAMESPACE, and add a round-trip test above 512 KiB.
     - **Skeptic's correction:** The differences are as described: extra-key rejection, a 512 KiB cap vs 4 MiB, and the hard-coded namespace at scenario-repository.ts:73 and :97. But the proposed fix would shrink the device's import cap. parseScenarioDocumentJson clamps maxDocumentBytes to at most SCENARIO_DOCUMENT_MAX_BYTES (512 KiB, scenario-model.ts:91-97). …
     - **Not in the cleanup:** changes which documents the device accepts.
111. **Two colour palettes with different Android fallbacks** [packages/core; lean, reuse] (`packages/core/src/components/panel-shell.tsx:26-33; panel-ui.tsx:3-26; plugins/query-presentation.ts:19-26`)
     - **Problem:** Both helpers are `Platform.OS === 'ios' ? PlatformColor(name) : fallback`, but the Android fallbacks differ: shellColors.tint is '#007AFF' and colors.blue is '#6750A4'.
     - **Fix:** Delete iosColor and define shellColors and the query palette from colors (background, label, blue, …).
     - **Not in the cleanup:** changes Android colours.
112. **componentVisuals ships with no caller, no docs and no test** [packages/react-native; lean, yagni] (`packages/react-native/src/diagnostics/component-visuals.ts:1-96; src/index.ts:54-57`)
     - **Problem:** Nothing in the tree imports it: not core, the example app, the desktop app, the README or the CHANGELOG. Its coverage is 0%.
     - **Fix:** Keep it: add a unit test (set and select flows, listener isolation) and a README line showing `visuals: componentVisuals`. Only if the known consumer does not use it, remove it with a **Breaking** entry under 0.2.0 in CHANGELOG.md. linesSaved is 0 if it is kept.
     - **Skeptic's correction:** The facts hold: a whole-tree grep finds only index.ts and the file, no docs mention `visuals`, and no test loads it. It is not dead code, though. …
     - **Not in the cleanup:** removing it breaks a public export.
113. **The desktop's native plan re-implements the cache's artifact lookup** [packages/react-native; lean, merge] (`packages/react-native/build-cache.js:165-180; apps/desktop/src/main/native-plan.ts:66-74`)
     - **Problem:** The plan re-parses artifact.json and re-checks the basename and that the file exists, but skips the rule that an .app must be a directory. The artifact.json format now has two readers that must change together.
     - **Fix:** Cheapest: add the shape check to PLAN_SCRIPT (`.app` must pass fs.statSync(candidate).isDirectory()). If lookupBuildCache is exported, keep the inline fallback, and count linesSaved as 0 until it can be dropped.
     - **Skeptic's correction:** Two readers do exist (build-cache.js:165-180 and native-plan.ts:72-74), and the plan skips the .app-must-be-a-directory rule. The value is overstated. The plan requires each worktree's installed copy of build-cache.js, so it must keep its inline reader as a fallback for copies without the new export, and no lines are saved. …
     - **Not in the cleanup:** the fix adds a check, so behaviour changes.
114. **The shared contract carries about 1,200 lines of renderer-only view model** [desktop: local Supabase; lean, split] (`apps/desktop/src/shared/supabase-protocol.ts:3530-4745`)
     - **Problem:** These are two jobs in one 6,180-line module. stackStatus, serviceStateLabel, visibleStackFlags, attentionItems, sidebarBadge, nextEvents and the lane chip helpers are used only by the renderer. Main imports none of them but bundles them, and every copy tweak edits the contract file.
     - **Fix:** Optional, for organization only. Move stackStatus, serviceStateLabel, visibleStackFlags, attentionItems, sidebarBadge, nextEvents, the lane chip helpers and their tests into a new renderer module (for example src/renderer/simulator/supabase-view-model.ts), not into supabase-model.ts. Keep activeJobFor, plural and the availability helpers shared. Drop the bundle-size argument.
     - **Skeptic's correction:** The named functions have no non-test uses outside the renderer. The claim 'main bundles them' is wrong, though: dist/main/index.js and dist/preload/index.js (built after the HEAD commit) contain neither attentionItems' copy ('Auto-stop paused…') nor stackStatus, because Rollup tree-shakes them. So the only gain is file organization. …
     - **Not in the cleanup:** a file move with no line savings.
115. **lane-metro decodes lsof's path escapes back to UTF-8 only to print one error** [desktop: main process, preload, shared; lean, yagni] (`apps/desktop/src/main/lane-metro.ts:504-571 (UTF8, UNSAFE_IN_MESSAGE, readableLsofPath, readablePath) and 703-708`)
     - **Problem:** The stop decision itself uses device and inode numbers plus the plain escaping (`printsPath`, `lsofPrintedByte`). About 55 lines, plus many test cases, exist only so that a non-ASCII folder in this rare error reads as 'À faire' instead of lsof's ASCII `\xc3\x80 faire`. lsof already runs in the C locale, so its output is already safe ASCII.
     - **Fix:** Print both paths in lsof's C-locale escaping: `cwd.printed` as it is, and the lane's path through `lsofPrintedByte`. Delete `readableLsofPath`, `UNSAFE_IN_MESSAGE` and `UTF8`, and their tests.
     - **Not in the cleanup:** one error message gets less readable.
116. **"Is this job still running" is written five different ways** [desktop: renderer; lean, merge] (`apps/desktop/src/renderer/app.tsx:497-503; panels/simulator/slimming-panel.tsx:1189-1196; panels/simulator/captures-panel.tsx:151-156; panels/simulator/fleet-panel.tsx:207, 706, 713; state/simulator-runtime.tsx:204-211; state/slimming-runtime.tsx:190-197`)
     - **Problem:** The titlebar and SimSlim list five active statuses. Captures lists four (no 'rolling-back') and reports only 'failed', so a compose job ending in needs-attention or cancelled clears without panel feedback. Fleet uses !finishedAt instead. Supabase already has a shared isActiveSupabaseJob.
     - **Fix:** Export isActiveSimulatorJob(status) (plus a terminal-kind helper) next to the job schema in shared and use it in all six places.
     - **Not in the cleanup:** panel feedback changes.
117. **Titlebar Simulator picker duplicates SimulatorTargetSelect** [desktop: renderer; lean, merge] (`apps/desktop/src/renderer/app.tsx:571-605; components/simulator-ui.tsx:69-102`)
     - **Problem:** Two copies of the same control with slightly different empty text ('No Simulator' vs 'No target discovered') and labels. A fix to one, such as showing held devices, misses the other.
     - **Fix:** Merge only if SimulatorTargetSelect gets props that replace (not append) its base class, plus variant, aria-label and empty-text props. The titlebar then passes its own values. Otherwise leave both copies: once those props exist, the saving is about 20 lines.
     - **Skeptic's correction:** Value, onChange, disabled and the option mapping are the same, but the fix as written breaks the titlebar. <SimulatorTargetSelect className="device-select" /> produces class 'sim-target-select device-select'. …
     - **Not in the cleanup:** the titlebar picker would look different.
118. **Legacy profile aliases are never sent and cannot work for mutations** [native helpers (Go sim helper, Swift host); lean, delete] (`apps/desktop/native/rndevtools-sim-helper/internal/catalog/catalog.go:78`)
     - **Problem:** No caller sends the legacy IDs, which predate this repo. For mutations they cannot work anyway: prepare returns the canonical ID, and sim-helper-client.ts:772-781 throws response_mismatch when it differs from the ID that was sent.
     - **Fix:** Delete the map, the lookup in ProfileByID and PROTOCOL.md:103-105, and update catalog_test.go:132-134 and service_test.go:350-356. Accept that agent preview/verify with 'ui-automation' or 'maximum-slimming' will return unknown_profile.
     - **Skeptic's correction:** Mutations do fail: prepare returns the canonical ID, and sim-helper-client.ts:772-781 throws response_mismatch. But the read-only paths still accept the aliases. agent-command-router.ts:855-866 forwards any identifier for agent slimming preview/verify, the helper maps it (catalog.go:108-111), and previewProfile/verifyProfile never compare IDs. …
     - **Not in the cleanup:** agent preview and verify answers change.
119. **Prepare and commit repeat the same four safety checks** [native helpers (Go sim helper, Swift host); lean, merge] (`apps/desktop/native/rndevtools-sim-helper/internal/helper/mutation.go:107`)
     - **Problem:** Both run the same four checks: the current state is representable, the target is representable, the existing state verifies (with the restore/undo repair exception), and the process capture succeeds. Prepare promises that commit will accept, so the two copies must change together, and their wording has already drifted ('disabled-service registration state' versus 'disabled launchd-job registration state').
     - **Fix:** Extract one preflight(ctx, operation, preparation, desired, acknowledgement) that returns the delta, verification and captured names, or an APIError. Commit wraps that error with cleanupPreflight.
     - **Not in the cleanup:** error wording changes.
120. **Prepared tokens carry process names nothing reads** [native helpers (Go sim helper, Swift host); lean, delete] (`apps/desktop/native/rndevtools-sim-helper/internal/helper/checkpoint.go:52`)
     - **Problem:** The prepared token stores the process names seen during prepare, and validateCheckpointPayload checks them, but no decision ever reads them. Commit deliberately captures fresh names instead (mutation.go:320-326).
     - **Fix:** If you do it, accept a one-time break: after the update, a pending mutation's stored token no longer decodes for reconciliation. Bump checkpointSchemaVersion and checkpointDigestDomain together, rewrite PROTOCOL.md:233-238, and drop the assertion at service_test.go:398. Otherwise keep the field; it saves only 14 lines.
     - **Skeptic's correction:** It is true that only validation (checkpoint.go:207-219 and 258) and one test (service_test.go:398) read the field; commit re-captures names (mutation.go:320-338). But the evidence is wrong. decodeCheckpoint never compares the tuple's HelperBuildCommit, and prepare(undo_last) (service.go:337-348) never compares tuples. …
     - **Not in the cleanup:** stored tokens from the previous build stop decoding.
121. **Mutation-availability attestation runs only for handshakes nobody sends** [native helpers (Go sim helper, Swift host); lean, yagni] (`apps/desktop/native/rndevtools-native-host/Sources/RNDevtoolsNativeHost/SimulatorMutationBroker.swift:494`)
     - **Problem:** It runs the full parent attestation (signature checks, reading the manifest, hashing the host binary), but no caller sends a v4 or v5 handshake. Electron sends only v2 and v3 handshakes and expects simulatorMutation: false; the verify script uses v1 and v2.
     - **Fix:** Delete isAvailable() from the protocol and both implementations. Report the v4+ capability as offered, as simulatorInput already is, and let run_simulator_mutation's own attestation decide.
     - **Not in the cleanup:** a protocol answer changes.
122. **Vitest repeats the renderer alias, guarded by a test** [tooling, CI, example and docs; lean, reuse] (`apps/desktop/vitest.config.ts:4-13, apps/desktop/electron.vite.config.test.ts:16-20, apps/desktop/electron.vite.config.ts:15-17`)
     - **Problem:** The same value lives in two places, plus a test that only exists to keep them equal.
     - **Fix:** Export `rendererAliases` from electron.vite.config.ts and use `resolve: { alias: rendererAliases }` in vitest.config.ts. Then delete the explanatory comment and the 'gives Vitest the same path aliases' test.
     - **Not in the cleanup:** tried and reverted: every Vitest run printed an extra warning.
123. **Overrides repeat catalog pins** [tooling, CI, example and docs; lean, merge] (`pnpm-workspace.yaml:11-14`)
     - **Problem:** Each version is written twice. Bumping the catalog alone leaves the override in force across the graph, so the catalog would claim a version that is not installed.
     - **Fix:** Write `'@types/react': 'catalog:'` and `'react-dom': 'catalog:'` in overrides.
     - **Not in the cleanup:** needs a lockfile update.

### Found while verifying the cleanup

124. **Desktop demo data still uses the source app’s workout domain** [risk, should] (`apps/desktop/src/shared/demo-data.ts (28 lines, for example 37, 103, 135, 199, 215, 328)`)
     - **Problem:** Demo-mode network, console, query and route rows read "Coach response completed", workout_sessions, workout_sets and /workout/active. AGENTS.md says nothing product-specific may live in source, and this data is what every demo screen and screenshot shows.
     - **Fix:** Rename the demo rows to neutral ExampleApp terms (items, sessions, /items/active). This changes what the demo screens show, so it was left out of the cleanup.
125. **The desktop e2e suite reads the host’s real agent sessions and pointer** [test, nice] (`apps/desktop/e2e/harness.ts`)
     - **Problem:** The harness gives each run a fresh profile and port, but agent discovery still reads the real ~/.claude and ~/.codex sessions, and Electron opens real windows, so a parked mouse cursor leaves a hover state. Lanes showed "Agents (4)" in one run and "(5)" in the next.
     - **Fix:** Inject an empty agent-session source in demo mode, or point its homes at the run’s scratch directory, and move the pointer off the window before each screenshot.

### Added by the skeptics

Issues a skeptic found while checking an auditor’s list. Each was reproduced or read in code once, but not checked again by a second agent.

126. [packages/react-native] packages/react-native/build-cache.js:370-377: runOptions.rebundle (`expo run:ios --unstable-rebundle`) is not excluded. On a hit, Expo (runIosAsync.js:130-177) writes EXConstants.bundle, and for Release also main.jsbundle and assets, into the shared cached .app in place, changing the entry every other worktree installs. On a miss, Expo rebundles the app already on the Simulator and never builds or uploads, so the claim stays held while that process runs Metro. Fix: return null without claiming when runOptions.rebundle is set.
127. [packages/react-native] packages/react-native/src/desktop/client.ts:312-318: trimToSnapshotLimits cuts rows but leaves the host's summary fields (omitted counts and truncated flags in storageSummary, querySummary, zustandSummary, componentSummary) saying nothing was omitted. The desktop then shows a trimmed collection as complete, and only a client diagnostic records the trim.
128. [packages/react-native] packages/react-native/build-cache.js:67 (with apps/desktop/src/main/native-plan.ts:49-60): `expo run` loads every key from the project's .env files into process.env before calling the provider, so RNDEVTOOLS_BUILD_CACHE_DIR can come from .env, where '~' is never expanded. The desktop's plan script loads no .env, and a desktop opened from Finder has no shell-profile variables either. The plan and the build then use different cache roots, and the plan reports a miss for a cached build.
129. [desktop: local Supabase] apps/desktop/src/main/supabase/agent-operations.ts:560-571: `supabase down` answers 'It stops in 1 min…' without checking holds.clocksPaused, so while session discovery is unreadable it promises a stop that never happens.
130. [desktop: main process, preload, shared] apps/desktop/src/main/agent-service.ts:114-130 — ClaimStore.set() replaces the in-memory claims before writing. If the write fails, the agent gets an error, but the claim stays active as a hold until release or restart.
131. [desktop: main process, preload, shared] apps/desktop/src/main/simulator-stream-service.ts:325-333 — #ensureFrameDirectory caches the mkdir promise forever. If mkdir fails once, or the frame directory is later removed (for example by macOS $TMPDIR cleanup while the app stays open), it is never re-created, so every later frame fails and the tile stays 'stalled' until restart.
132. [desktop: main process, preload, shared] apps/desktop/src/main/agent-command-router.ts:1071-1081 — laneForTarget returns the first lane that matches either laneAppDirectory===path or worktreePath===path. With two app lanes in one monorepo checkout, `lane down/launch/log --worktree-path <checkout>` can pick a nested app's lane even when the root app's lane matches exactly.
133. [desktop: main process, preload, shared] apps/desktop/src/main/slimming-service.ts:327-330 — the comment says a held device is refused 'for every caller, agent or GUI alike', but decideDeviceAccess (shared/device-hold.ts:262) allows any request without a requester (the operator), so GUI slims always pass. The comment is wrong.
134. [desktop: renderer] apps/desktop/src/renderer/components/recipe-step-editor.tsx:445-455: 'Route waypoints' turns every blank line into a {latitude: 0, longitude: 0} waypoint, including the trailing newline left by pressing Enter or pasting lines. Number('') is 0 and coordinateSchema (shared/recipe-protocol.ts:116-119) accepts it, so the saved route drives the Simulator to 0,0. Skip blank lines and reject empty fields.
135. [desktop: renderer] apps/desktop/src/renderer/panels/simulator/supabase-stack-detail.tsx:675-677: the adopt note re-implements the stop-delay wording with Math.round(ms / 60_000) min and no zero case. It reads '0 s after nothing holds it' for a 0 ms policy, '2 min' for 130 s and '60 min' for an hour, where the other copies say 'as soon as', '3 min' and '1 h'.
136. [agent CLI (Go)] internal/setup/setup.go:300-312 (writeJSONServers, `servers["rndevtools"] = wanted`) - the whole rndevtools entry is replaced, so keys a user added inside it (env, timeout, a trimmed Kiro autoApprove) are dropped on the next update, contrary to the README's 'unknown keys are preserved'; verified: a user env block was removed and the action was update.
137. [agent CLI (Go)] internal/command/parse.go:139-142 and internal/mcp/server.go:540-542 - the `release` flags and MCP tool have no sessionCwd (MCP answers 'unknown argument session-cwd'), so for a Codex session (shared mcp-* identity) the `release all=true` call the server's instructions tell every agent to make releases nothing, and the desktop's reply (agent-command-router.ts:823) asks for an argument the tool cannot take; the MCP server could default it to its own working directory.
138. [native helpers (Go sim helper, Swift host)] apps/desktop/native/rndevtools-native-host/Sources/RNDevtoolsNativeHost/SimulatorMutationBroker.swift:810-822: when Electron cancels after the helper was resumed, the broker closes FD 4 and waits up to the full grace period for the helper's rollback. It then throws away the helper's JSON response (`_ = output.finish()`) and returns code 'cancelled', retryable: true, with the message 'cancelled before its atomic commit' (Cancellation.swift:26-30). The helper's rollback evidence never reaches Electron, and the message is wrong once the helper may have changed the Simulator.
139. [native helpers (Go sim helper, Swift host)] apps/desktop/native/rndevtools-sim-helper/internal/simulator/client.go:584-586: RestoreBootState returns as soon as `simctl list` says Booted, without running `simctl bootstatus -b`. Vendored simslim slim.go:44-46 notes that list reports Booted from the moment a boot starts. So after a cancelled `simctl boot`, failAndRollback's next step (Status → launchctl print-disabled, mutation.go:446) can hit a half-booted device and end in rollback_status_failed.
140. [native helpers (Go sim helper, Swift host)] apps/desktop/native/rndevtools-sim-helper/internal/simulator/client.go:322-325 and 340-343: CaptureRunningServiceProcesses replaces the launchd snapshot/parse errors and the process-measurement error with fixed sentences. The BoundedDetail appended at mutation.go:163 and 335 therefore cannot say which probe failed. This is the same pattern as the clone/disk finding.
141. [tooling, CI, example and docs] .github/workflows/release.yml:77-94 with apps/desktop/package.json:91-114: nothing fails the release when signing or notarization secrets are empty. The fail-fast step checks only APPLE_TEAM_ID. electron-builder has no forceCodeSigning, so it only logs 'skipped macOS application code signing' and 'skipped macOS notarization' (MacTargetHelper.js reportError, notarizeIfProvided). after-pack.cjs:93-104 then ad-hoc signs with `codesign --deep --sign -`, the cold-start check passes, and an unsigned, unnotarized DMG/ZIP is attached to the GitHub release. …
142. [tooling, CI, example and docs] apps/desktop/scripts/after-pack.cjs:26,37-45: on Linux, electron-builder renames the binary to LinuxPackager.executableName ('@rndevtoolsdesktop', the sanitized package name), but after-pack flips fuses on '<appOutDir>/RN Devtools' (appInfo.productFilename). `package` and `make` on Linux therefore die with ENOENT in afterPack, before the deb error in finding 12 is reached.
143. [tooling, CI, example and docs] examples/expo-demo/.gitignore:1-3: there is no `.expo/` rule. The README's `expo start` writes .expo/README.md, devices.json and settings.json (@expo/cli dotExpo.js ensureDotExpoProjectDirectoryInitialized). `git check-ignore` exits 1 for them, because only `*.log` covers .expo/dev/logs, so they show up untracked and get committed by `git add -A`.
144. [tooling, CI, example and docs] examples/expo-demo/package.json:11-28 vs examples/expo-demo/README.md:29-40: the example has no expo-dev-client (its ios/Podfile.lock has no dev launcher), yet the README runs it in lanes. Lanes start Metro with --dev-client (apps/desktop/src/main/lane-metro.ts:287) and open '<scheme>://expo-development-client/?url=…' (apps/desktop/src/shared/lane-protocol.ts:390-402). A plain `expo run:ios` debug build cannot handle that URL and loads its build-time packager port (8081), not the lane's leased port.
145. [tooling, CI, example and docs] apps/desktop/package.json:4 vs README.md:6, AGENTS.md:3 and CHANGELOG.md:184: the docs say the two halves 'version together', but the desktop is 0.1.0 while both packages are 0.2.0. A v0.2.0 tag attaches 'RN Devtools-0.1.0-*' artifacts and native manifests stamped appVersion 0.1.0, and nothing in release.yml checks the tag against the desktop version.
146. [tooling, CI, example and docs] README.md:85-94: the root README presents `pnpm quality` ('lint + typecheck + test across all workspaces') as the development gate. This is the same CI mismatch as finding 7, outside that finding's location list.
147. [tooling, CI, example and docs] apps/desktop/native/README.md:101-104 calls the cold-start check 'The macOS CI package gate', but it runs only in release.yml on tags and manual dispatch, never in ci.yml.
148. [tooling, CI, example and docs] .github/workflows/release.yml:85-92: `native:build` builds the helpers and the next step verifies them, then `make` runs native:build:package and rebuilds them before packaging. The job builds the helpers twice, and the capability handshake is checked on binaries that are then overwritten. Call electron-builder directly after the verified build, or verify after packaging.

## Applied in the cleanup

Only lean findings whose fix changes nothing a user, an agent, a test, the UI, a stored file or the wire protocol can observe. Each area went through an implementer, a skeptic hunting for behaviour changes in its diff, and a fix round. Each line below is the finding as the audit named it; the commit message says what changed.

- `fc3479b` refactor(core):
     - Zustand capture runs a redundant full redaction pass on every store change
     - environment.tsx re-declares environment-model.ts and runs the same rule checks twice
     - Network correlation-header options say response headers, but only request headers are read
     - `maxEventBytes` means total buffer in console/zustand but per-event in DevtoolsEventStore
     - Restore and reset-to-baseline duplicate the capture/apply/rollback/receipt sequence
     - Network panel's clearRequests copies requestClear
     - Redundant eager copy of network events on every store change
     - scenario-engine carries its own UTF-8 byte counter
     - Unreachable branches (in part: the console.tsx text check and the redact.ts narrowing line stay; the latter is the only type narrowing for consumers who compile the shipped source without strictNullChecks)
- `1239fa0` test(core):
     - The source app's workout domain leaks into a shipped comment and test fixtures
- `6f5cb78` refactor(react-native):
     - Six hand-written byte readers do DataView's job
     - send() has one caller and repeats sendWithinBudget's serialize-and-log
     - The 'move to next candidate' block is written out twice word for word
     - isLocalBrokerHost is isLoopbackBrokerHost plus one address
     - build-cache.js restates two of its own helpers
     - extensionForFixture has an unreachable 'bin' branch
- `5068ba8` refactor(desktop), main process:
     - Ten copies of 'send this to every window' in index.ts
     - 19 copies of the owner-window dialog ternary and 7 copies of the same confirm box
     - Six hand-written 'write JSON safely' routines that disagree on durability
     - Five copies of 'wait until this job finishes' and five copies of the finished-status list
     - Eleven copies of the 'redacted error text, at most 4 KiB' helper
     - The Simulator UDID regex is written out 15 times
     - index.ts repeats recipe-policy's 'privileged step' rule to word the dialog
     - LaneService's `resolveLaneEnv` hook is never used outside one test
     - Two copies of the bounded, owner-checked file copy in native-host-client
     - Three hand-rolled abortable sleeps; Node already has one
     - recipe-ipc rebuilds the recipe summary that recipe-store already builds
     - Small dead code: a pass-through, an unused getter, a dead fallback, a one-line wrapper
- `a01b05c` refactor(desktop), Supabase and renderer:
     - IPC re-implements the confirmation option substitution
     - within() is copied in two modules and the copies differ (in part: the engine's own #within stays, because it rethrows its task's rejection)
     - The rollout-phase switch is permanently on
     - Key fingerprints and supersededBy are written but never read
     - Three bounded file readers do one job
     - Two atomic file writers do one job
     - hasControlCharacters is copied four times next to the exported one
     - cli-contract re-implements the loopback URL checks
     - Path and session-key helpers are copied
     - The live-state set and the SysV refusal text are copied
     - Each repository scan reads and parses config.toml twice per worktree
     - The 'follow' job kind is never created
     - Camera fixture file preparation is copied in two files
     - Runtime provider boilerplate is copied 7 to 10 times, and two copies skip redaction (in part: only the strictly behaviour-preserving parts; no redaction or revision guard was added where a copy lacks one)
     - SimulatorPanelHeader only passes its props to PanelHeader
     - Simulator tool descriptions are never rendered
     - App Actions' requiresAccessibility flag is never set
     - portOf is copied verbatim
     - The stop-delay wording rule is written three times
     - Recipe limits are copied from the shared schema
     - Skeleton's 'md' radius and .ui-skeleton.is-md are never used
- `b7a2969` refactor(cli):
     - Never-read fields: mcp.Config.Logger, toolMeta.destructive, command.Field.Path
     - command.Parse and setup.EvaluateShellCommand are production code only for the tests
     - protocol keeps the command list three times: constants, validCommands map, Commands()
     - The same small helpers are written several times across app, mcp and command (in part: the optional Config.socket() helper was skipped)
     - client.Do re-implements what net.Conn.Write already does and repeats the oversize branch
     - setup has two tiny helpers that duplicate the standard library
- `8c63542` refactor(sim-helper):
     - Restore-point checkpoints are only ever created by tests
     - Unbound authorizer mode exists only for tests
     - Sort and set helpers are written three times
     - Validation regexes are copied across packages
     - Wrappers kept only for tests or pure forwarding
- `d915730` refactor(native-host):
     - Composition temp-file name is a literal string, not a UUID
     - Two copies of the process-group reaping loop
     - Capability 'framework available' probes can never fail
- `9eda5fe` build:
     - Three byte-identical biome.json files
- `060e845` chore(desktop):
     - Delete build-native-helpers' unused partial-build flags
     - externalizeDeps.exclude lists in the electron-vite config do nothing
     - Dead checks in verify-native-resources.cjs
- `4a270fc` refactor(example):
     - app.config.js merges app.json into itself
- `690eb12` docs:
     - Desktop README: package/make don't use the Electron download it describes
     - Root README says native builds need govulncheck
     - Example README's Supabase command fails in the example

Invisible but not byte-identical: lane and agent-claim files are now fsynced; the Supabase CLI resolver can no longer block on a FIFO `package.json` (a skeptic-added finding, closed by the reader merge); an empty build commit now fails closed in the sim helper; and editing `app.config.js` changes the example’s native fingerprint once.

## How the cleanup was verified

- All 15 repository gates: root quality, core (770 tests), react-native (110), the example, desktop (2,101 tests and the build), strict knip, gofmt, go vet and race tests for the CLI with and without agent variables, the native Go check with govulncheck, the vendored SimSlim manifests, and Swift lint, build and 45 tests.
- Every commit typechecks and vets on its own.
- The opt-in real Supabase CLI 2.121.0 suites: 8 of 8 and 8 of 8, with no stack left running.
- An unpacked package: native helpers, fuses, a valid signature, native resources and host capabilities, and a cold start with no crash report.
- The Playwright e2e suite, 78 of 78, twice before and twice after. 39 of its 53 screenshots are pixel-identical; the other 14 differ only by wall-clock times, random loopback ports, the host’s live agent count and a hover under the parked mouse cursor.

## Not checked

- Android, and Hermes on a physical device.
- A signed, notarized release build, and GitHub CI.
- Windows and Linux packaging.
- HeroUI Pro’s obfuscated install-time downloader.
- The vendored SimSlim tree, which is byte-anchored and was out of scope.
- Long panel bodies (parts of the Supabase views, automation, Zustand and component inspector panels) and the largest test files were only partly read.
