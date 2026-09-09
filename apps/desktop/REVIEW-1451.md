# Desktop UI/UX and simulator review — PR #1451

Reviewed September 8, 2026. Starting point: `2142ba1eda110c73ce5c8c879bfa54d9f09ee0ce`, fetched directly from [PR #1451](https://github.com/avad-technologies/pumpd-mobile-app/pull/1451). This record covers the desktop review, follow-up implementation, and local verification for that PR.

The desktop is simpler and easier to read, and the create → boot → open flow was verified with PUMPD on a new simulator. A Developer ID certificate was created in Xcode and the desktop was packaged and signed. Real SimSlim testing reproduced an apply failure, led to a correction in the two PUMPD presets, and then passed apply, repeated apply, undo, and restore-and-disable. In the matched welcome-screen samples, the simulator's total process memory footprint fell approximately **14%**. PUMPD startup and frame-rate improvements have not been established.

**Findings and changes**

| Area | Finding | Change |
| --- | --- | --- |
| Typography | Many controls and descriptions used 6–11 px text and low-contrast gray. | Body and control tokens are 14 px; dense metadata and code have a 12 px floor. Secondary grayscale text was brightened. |
| Information density | Repeated explanatory paragraphs, implementation details, duplicate headings, and decorative simulator previews competed with actions. | Added accessible info popovers and expandable sections. Removed the fake phone preview and duplicate fleet status strip. |
| Navigation and actions | “Fleet,” generic “Run action,” “Doctor,” and “Preview treatments” required interpretation. | “Simulators,” action-specific buttons, “Check PUMPD features,” and “Enable editing” now describe the action directly. |
| New simulator | Creation stopped at a shutdown device; opening required another action. | “New simulator” supports “Create & open” by default. The backend records the returned UDID, boots that exact device, waits for readiness, and opens Simulator. The new device becomes selected. |
| Selection | Normal fleet selection also changed batch targets. SimSlim used decorative checkboxes without selection semantics. | Added explicit “Select multiple” mode and controlled HeroUI selection with real checkboxes, keyboard support, and selected-row state. |
| Progress | Accepted queue receipts could show completion before the work finished. Disabling SimSlim on a clean simulator incorrectly said managed overrides remained. | Notifications follow real job states through completion/failure. Enable/disable copy reflects the returned state and actual queued job. Long error details expand inside a bounded notice. Fleet activity supports inspection and cancellation. |
| SimSlim accuracy | Stale previews could be shown for another profile or after a mutation. Built-in profiles could imply verification. “Before/after” presentation did not establish measured savings. | Preview state must match the selected profile. Mutations clear outdated previews and feature checks, including checks requested while a mutation runs and after failed attempts. Removed misleading verification and savings labels. Resource cards show current measurements only. Development builds explain why apply/restore is unavailable. |
| SimSlim apply | Three jobs remain registered on the tested iOS runtime, causing the original 60-service PUMPD Development profile to fail verification and roll back. | Both PUMPD presets now preserve those three jobs through the upstream `Keep` option. The revised Development preset disables 57 services. The services remain managed so old overrides can be restored. Native authorization, verification, rollback, and vendored upstream code remain intact. |
| Destructive actions | Erase described data loss as recoverable. Some button labels claimed actions were “safe.” | Erase clearly states permanent data loss. Confirmation labels describe the requested operation. Capture/recipe deletion has less visual emphasis while retaining confirmation. |
| Captures | Generated filenames, native-compositor explanations, and cleanup settings overwhelmed the preview. | Friendly capture labels, details behind an info button, editing only for screenshots, and expandable storage/cleanup controls. Originals remain preserved when saving an edited copy. |
| Automation | An empty workspace displayed target selection and approval details before there was a recipe. Copy incorrectly called imported definitions “signed.” | Run settings appear after selecting/creating a recipe. Empty states explain the workflow plainly. Sensitive-step warnings and native approvals remain. |
| Settings | A readiness score counted optional/unavailable features; the permissions step could show completion without grants. | Replaced that progress display with required simulator setup and a separate expandable list of optional features/permissions. |
| Build Insights | “Scan root” and renderer implementation explanations appeared in the primary workflow. | “Add build folder,” clearer empty states, and implementation limitations in the header help. |
| Performance display | Unavailable CPU/memory channels occupied full empty cards; static prose crowded measurements. | Show those cards only when reported and explain metrics through info popovers. Preserve the app’s reported performance grade. |
| Small windows | Action rows and toolbars could extend beyond the window. | Controls wrap and inspector columns can shrink. Reviewed the native window at its 1040 × 700 minimum. |
| Background work | Resource sampling ran every two seconds while hidden. Initial sampling raced device discovery. | Five-second sampling, paused while hidden/minimized, refreshed on return. Startup sampling waits for discovery; explicit actions and pending SimSlim recovery remain supervised. |
| Renderer work | Simulator updates could rerender unrelated connected-app panels. | Memoized the connected-app content boundary. Heavy panels remain lazy and large lists remain virtualized/bounded. |
| Main-process reliability | A host metrics command could reject before slower simulator probes finished, leaving an unhandled rejection. | Attach host rejection handlers immediately, then report a bounded unavailable sample. Added a regression test. |
| Local startup | electron-vite failed before Electron’s first-run runtime download had been initialized. | Development/preview scripts ensure Electron is initialized first. |

**Live verification**

Environment: Apple Silicon; macOS build `25G83`; Xcode 26.6 (`17F113`); CoreSimulator `1051.55`; iOS 26.5 (`23F77`). The existing iPhone 17 Pro simulator was left unchanged.

| Check | Observed result |
| --- | --- |
| Create & open from the desktop | Created `PUMPD Devtools Review`, iPhone 17 Pro, UDID `484095FA-D287-4F16-9404-EB29EB1A7E65`. The real job completed in **29.163 seconds**. Device discovery confirmed it booted, and the desktop selected it. |
| PUMPD install and launch | Installed the existing PUMPD Development native binary on the new device. Loaded JavaScript from this PR checkout through Metro. Welcome screen and coach picker rendered. Coach/style selection, carousel controls, and back navigation worked. |
| Desktop connection | The real PUMPD Development session connected over the local broker; console, storage, routes, and registered-store data were available. The reused native binary reports version 1.0.9. |
| Screenshot | Desktop Screenshot created a 530 KB PNG and displayed the actual PUMPD coach picker through the private capture preview. |
| SimSlim preview | The initial PUMPD Development preview completed in approximately **0.8 seconds** and planned 60 service disables. After the real apply failure and preset correction, the preview planned 57 disables. |
| Signed SimSlim apply | The original profile failed verification and rolled back in **48.042 seconds**. The corrected profile applied and verified in **29.281 seconds**; a later full reapply took **22.488 seconds**. PUMPD relaunched and the welcome/coach-picker smoke flow passed with the corrected profile. |
| Repeated apply | Completed in **4.086 seconds** with `changed: false` and “Simulator already matched.” It preserved the prior real-change checkpoint. |
| Undo | Restored the pre-apply checkpoint in **17.689 seconds**. Final managed-disabled count was zero, and PUMPD relaunched. |
| Restore and disable | After reapplying the corrected profile, “Restore, verify & disable” completed in **23.724 seconds**. The final state was `managed-clean`, zero managed-disabled services, mutations disabled, and `restored-and-verified`. The UI tracked the running job until completion. PUMPD relaunched. |
| Final signed candidate | After fixing inspection invalidation and rebuilding, another full apply completed in **31.019 seconds**, and standalone “Restore services” completed in **23.405 seconds**. Live state confirmed both cached inspections were removed during/after apply and restore, with zero managed-disabled services at the end. The final package's clean enable/disable messages were also verified live. |
| PUMPD service check | Completed in **456 ms**. Checks passed for push notifications, StoreKit, HealthKit, universal links, and photos on the unmodified simulator. These checks inspect service overrides; they do not exercise purchases, notification delivery, or permission dialogs inside PUMPD. |
| Visible polling | Observed distinct sample timestamps separated by **5003, 5001, and 5002 ms**. Four distinct samples were observed over roughly 15 seconds. |
| Minimized polling | Eight reads across roughly 15 seconds all retained the same resource sample timestamp. No new periodic metric sample appeared. Sampling resumed after restoring the window. |
| PUMPD JS interaction sample | Recorded **27.2 seconds / 27 samples** while changing coach/style, navigating back, and switching a welcome slide. Average JS FPS **57.8**, p95 event-loop lag **29.9 ms**, **23 long frames**. The mobile collector reported **critical**. This is a development-build baseline, not a successful performance result or a before/after SimSlim comparison. Native UI FPS/CPU/memory were not reported by that collector. |
| Development startup trace | Metro logs recorded fonts loaded at **6.31 seconds** and the root navigator rendered at **8.58 seconds** after the app’s startup trace began. This development session is not a native cold-start benchmark or a before/after comparison. |
| Accessibility/UI | Native accessibility inspection confirmed selected rows and checked states, info popovers, and keyboard-accessible disclosure controls. Info help opened, Escape closed it, and focus returned to its trigger. |

Sampling is scheduled 12 times per minute instead of 30: **60% fewer scheduled samples while visible**. This is an overhead reduction, not a claim of 60% lower CPU, memory, startup time, or better app FPS.

Metro initially bound only to IPv6 while the development client requested IPv4. For this test it was restarted with a process-local setting:

```sh
NODE_OPTIONS=--dns-result-order=ipv4first APP_VARIANT=development EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED=false pnpm --dir apps/mobile start --dev-client --localhost --port 8081
```

Node and Go settings were process-local; Go 1.27.1 was used from a temporary toolchain. At the user's request, Xcode was signed in and a Developer ID Application certificate was created for AVAD Technologies LLC. The private key remains in the local Keychain. The PUMPD mobile binary was reused rather than freshly compiled. A fresh native build and a release-mode performance profile remain separate checks. The live mobile session did not provide a simulator UDID, so automatic association in the fleet’s “Connected PUMPD sessions” section was not established, although the connection and the running process were verified independently.

**Checks**

- Desktop `quality`: lint, both TypeScript projects, unused-code/cycle checks, **424 tests in 59 files**, and production build.
- Native helper build, resource verification, and capability verification.
- Swift formatting/checks and **21 tests**.
- Go helper/CLI checks including race tests and `govulncheck`: passed; no vulnerabilities reported.
- Native packaging and vendored SimSlim integrity checks: **8 tests passed**.
- Developer ID signatures: outer app and all three bundled native helpers verified, including the required AVAD team identity. Hardened runtime, configured Electron fuses, native resource hashes, and packaged cold launch verified.
- `git diff --check`: passed.

The review includes shared UI/layout code across all connected-app tools and simulator panels. Live walkthroughs covered simulator creation, SimSlim mutations and recovery, captures, settings, build-history and automation empty states, and real connected-app network/console/store/performance views. It does not claim exhaustive keyboard/screen-reader coverage, all automation recipe steps, every app action, capture editing/export, or distribution notarization.

**Signing and SimSlim follow-up**

The local signing prerequisite is resolved. Xcode created `Developer ID Application: AVAD Technologies LLC (434X69L4Z5)`, and the same identity signs the packaged desktop and native helpers. The authenticated mutation broker successfully authorized the real UI tests. No ad-hoc signing or development bypass was used. The package is signed and locally runnable; it has **not been notarized** for distribution.

Signed bundle: `apps/devtools-desktop/release/mac-arm64/PUMPD Devtools.app`. On this Mac, with the Swift and Go toolchains available, the repeatable build command is:

```sh
CSC_NAME='434X69L4Z5' CSC_IDENTITY_AUTO_DISCOVERY=true pnpm --filter @pumpd/devtools-desktop package --config.forceCodeSigning=true
```

Final packaged `app.asar` SHA-256: `d43cc2587be8276608d4abe011ebeabc23219560b696e3ab04176f5ce7076231`. Native build identity: `2142ba1eda110c73ce5c8c879bfa54d9f09ee0ce-dirty:53ed0fb920d6c629aca84e90e682a7acadfab0a0c1be1fc94ad6a85573553c56`. The final package adds the enable/disable notification correction after the mutation retest; native helper and mutation-service sources are identical to that retest.

The vendored helper remains SimSlim v0.8.0, upstream `09fc9cbb`, PUMPD patch `pumpd.1`; no vendor files changed. The PUMPD catalog is now `simslim-v0.8.0-09fc9cbb-pumpd.1-presets.2`. The existing [branch verification record](../../docs/branches/add-advanced-devtools.md) documented a September 4 apply on another system combination that failed and rolled back because three services remained registered. This review reproduced that failure with the original profile on the current combination:

- `com.apple.MapKit.SnapshotService`
- `com.apple.siri.acousticsignature`
- `com.apple.siri.context.service`

The Development and UI Automation presets now explicitly preserve those jobs and expose the exceptions in the profile help. The corrected Development preset passed the live sequence above. The Maximum Density preset still uses the upstream full set and was not tested or changed. The immutable compatibility matrix remains at **zero verified combinations**: this local smoke run does not establish all PUMPD features, preset combinations, runtime versions, or interruption/recovery cases. The UI retains its experimental warning and explicit compatibility acknowledgement.

After applying, the service checks again passed for push notifications, StoreKit, HealthKit, universal links, and photos. Those checks verify service availability; actual purchases, notification delivery, HealthKit authorization, photo access, and signed-in training flows were not exercised.

An off simulator with a retained checkpoint is treated as potentially changed because its live service state cannot be inspected. Re-enabling and then disabling SimSlim in that state can request restore/verification again. Booting the dedicated target and refreshing proved it remained clean; disabling then completed directly. This conservative recovery behavior remains in place.

**Measured resource effect**

Each phase contains six distinct samples roughly five seconds apart, with PUMPD Development displaying its animated welcome screen. Memory is the sum of per-process physical footprints reported by the desktop collector. This is one local development-build comparison, not a release benchmark.

| Median measurement | Before | Profile applied |
| --- | ---: | ---: |
| Total simulator process memory | 3333.7 MiB / 3.26 GiB | 2878.5 MiB / 2.81 GiB |
| Simulator process count | 158 | 124 |
| Total simulator process CPU | 22.25% | 18.3% |
| PUMPD process memory | 1150 MiB | 1186 MiB |
| PUMPD process CPU | 15.7% | 12.3% |

The observed memory reduction was **455.2 MiB (13.7%)**, with **34 fewer processes**. PUMPD's own memory did not fall; the reduction was in simulator overhead. CPU readings vary with the workload and this run is insufficient to establish a reliable CPU, startup, or frame-rate improvement. A supplementary restored-state sample returned to 3195.6 MiB and 153 processes; desktop validation ran concurrently during that sample, so it is excluded from the CPU comparison. The earlier mobile performance collector's critical baseline remains an unresolved measurement, not a passing performance claim.

Local evidence is retained under `/tmp/pumpd-devtools-review/`: `fixed-baseline-resources.json`, `fixed-applied-resources.json`, `fixed-restored-resources.json`, the apply/repeat/undo/restore state records, build logs, and quality logs. These temporary artifacts are not committed.

At the end of testing, the dedicated simulator and screenshot were retained for review. Its services were restored, SimSlim was disabled, and the simulator was shut down to release resources. Task-owned Metro was stopped. The user's existing simulator remained booted and was not targeted by any mutation. The signed desktop window remained available. Generated application bundles and machine signing credentials are excluded from Git.
