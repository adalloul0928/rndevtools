package setup

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/client"
)

func TestHookBlocksMutatingSimctlAndHandStartedMetro(t *testing.T) {
	for command, want := range map[string]string{
		"xcrun simctl boot 727CE7B2-CCBA-47A5-8803-1D61DCEBCF44": "lane",
		"simctl shutdown all":                           "down",
		"cd app && xcrun simctl openurl booted exp://x": "launch",
		"xcrun simctl install booted ./build/App.app":   "native",
		"xcrun simctl io booted screenshot /tmp/a.png":  "capture",
		"npx expo start --port 8081":                    "lane",
		"yarn react-native start":                       "lane",
		"pnpm exec expo start":                          "lane",
	} {
		decision := EvaluateShellCommand(command)
		if !decision.Block {
			t.Fatalf("%q should be blocked", command)
		}
		if !strings.Contains(decision.Reason, want) {
			t.Fatalf("%q reason %q lacks %q", command, decision.Reason, want)
		}
	}
}

func TestHookAllowsReadOnlyAndUnrelatedCommands(t *testing.T) {
	for _, command := range []string{
		"xcrun simctl list devices -j",
		"xcrun simctl list devicetypes",
		"xcrun simctl getenv booted HOME",
		"xcrun simctl help",
		"git status && pnpm test",
		"rndevtools lane --operation up --worktree /w --udid 727CE7B2-CCBA-47A5-8803-1D61DCEBCF44",
		"rndevtools input --kind button --button home --udid X",
		"echo 'simctl boot is what we avoid'",
		"xcrun xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build",
	} {
		if decision := EvaluateShellCommand(command); decision.Block {
			t.Fatalf("%q should pass, got %q", command, decision.Reason)
		}
	}
}

func TestHookJudgesEachCommandOfALineOnItsOwn(t *testing.T) {
	// An rndevtools command anywhere in the line used to exempt all of it.
	for command, want := range map[string]string{
		"rndevtools doctor; expo start":                                   "Metro",
		"rndevtools doctor && npx expo start --port 8081":                 "Metro",
		"rndevtools lane --operation ls || yarn react-native start":       "Metro",
		"rndevtools doctor & pnpm exec expo start":                        "Metro",
		"rndevtools doctor | expo start":                                  "Metro",
		"rndevtools doctor\nexpo start":                                   "Metro",
		"(rndevtools doctor; expo start)":                                 "Metro",
		"if rndevtools doctor; then npx expo start; fi":                   "Metro",
		"cd ~/src/rndevtools/examples/app && npx expo start":              "Metro",
		"RNDEVTOOLS_AGENT_SESSION_ID=s1 rndevtools doctor; expo start":    "Metro",
		"rndevtools claim --udid X --note `expo start`":                   "Metro",
		"rndevtools doctor; xcrun simctl shutdown all":                    "simctl shutdown",
		`rndevtools claim --udid X --note "$(xcrun simctl boot booted)"`:  "simctl boot",
		"rndevtools claim --udid X --note $(xcrun simctl io booted list)": "simctl io",
	} {
		decision := EvaluateShellCommand(command)
		if !decision.Block {
			t.Fatalf("%q should be blocked", command)
		}
		if !strings.Contains(decision.Reason, want) {
			t.Fatalf("%q reason %q lacks %q", command, decision.Reason, want)
		}
	}
}

func TestHookReadsCommitMessagesAsTextNotCommands(t *testing.T) {
	for _, command := range []string{
		"git commit -m \"$(cat <<'EOF'\nfix(cli): stop agents running xcrun simctl boot and expo start by hand\nEOF\n)\"",
		"cat > notes.md <<'EOF'\nxcrun simctl shutdown all\nnpx expo start\nEOF",
	} {
		if decision := EvaluateShellCommand(command); decision.Block {
			t.Fatalf("%q should pass, got %q", command, decision.Reason)
		}
	}
	if !EvaluateShellCommand("cat > notes.md <<'EOF'\nnotes\nEOF\nxcrun simctl shutdown all").Block {
		t.Fatal("a command after the here-document is still judged")
	}
}

func TestHookExemptsOnlyTheCommandThatRunsRndevtools(t *testing.T) {
	for _, command := range []string{
		`rndevtools claim --udid 727CE7B2-CCBA-47A5-8803-1D61DCEBCF44 --note "expo start hung; restart it"`,
		`~/.local/bin/rndevtools claim --udid X --note 'then xcrun simctl boot it'`,
		`'/Applications/RN Devtools.app/Contents/Resources/native/rndevtools' lane --operation launch --worktree /w --url "expo start"`,
		`rndevtools lane --operation log --lane-id lane-1 | grep 'expo start'`,
		`rndevtools doctor && git status`,
		"git status # expo start comes later",
	} {
		if decision := EvaluateShellCommand(command); decision.Block {
			t.Fatalf("%q should pass, got %q", command, decision.Reason)
		}
	}
}

func TestHookReadsThePayloadCwd(t *testing.T) {
	payload := `{"session_id":"s","cwd":"/Users/dev/app","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rndevtools doctor; expo start"}}`
	call, ok := readPreToolUse(strings.NewReader(payload))
	if !ok || call.cwd != "/Users/dev/app" || call.command != "rndevtools doctor; expo start" {
		t.Fatalf("call %+v ok %v", call, ok)
	}
	if !EvaluateClaudePreToolUse(strings.NewReader(payload)).Block {
		t.Fatal("the payload's command must still be judged segment by segment")
	}
	if _, ok := readPreToolUse(strings.NewReader(`{"tool_name":"Read","cwd":"/w","tool_input":{"file_path":"/w/a"}}`)); ok {
		t.Fatal("only Bash calls are judged")
	}
}

func TestHookReadsClaudePayloadAndFailsOpen(t *testing.T) {
	blocked := EvaluateClaudePreToolUse(strings.NewReader(`{"tool_name":"Bash","tool_input":{"command":"xcrun simctl boot 727CE7B2-CCBA-47A5-8803-1D61DCEBCF44"}}`))
	if !blocked.Block {
		t.Fatal("Bash simctl boot must be blocked")
	}
	for _, payload := range []string{
		`{"tool_name":"Read","tool_input":{"file_path":"/tmp/simctl boot"}}`,
		`not json at all`,
		``,
	} {
		if decision := EvaluateClaudePreToolUse(strings.NewReader(payload)); decision.Block {
			t.Fatalf("%q must fail open", payload)
		}
	}
}

func TestReadSessionEnd(t *testing.T) {
	payload := ReadSessionEnd(strings.NewReader(`{"session_id":"thr_123","transcript_path":"/x","cwd":"/w","hook_event_name":"SessionEnd","reason":"other"}`))
	if payload.SessionID != "thr_123" || payload.Reason != "other" || payload.Cwd != "/w" {
		t.Fatalf("payload %+v", payload)
	}
	if ReadSessionEnd(strings.NewReader("garbage")).SessionID != "" {
		t.Fatal("unparseable input must yield an empty session id")
	}
}

// MARK: - Supabase steering

// supabaseFixture is a Mac for the Supabase rules. managed is a worktree RN
// Devtools runs (a main checkout on refs/heads/feat-a); linked is a linked
// worktree of another repository that opted into the stack backend with a
// dotted key; legacy is a project that did not opt in; plain has no
// Supabase project. Paths are canonical, like the desktop's; raw is the
// same temporary directory through its /var symlink.
type supabaseFixture struct {
	raw, base             string
	managed, linked, repo string
	legacy, plain, home   string
	steering              steeringState
	steeringOK            bool
	reachable             bool
	reads, probes         int
	now                   time.Time
	env                   map[string]string
}

func newSupabaseFixture(t *testing.T) *supabaseFixture {
	t.Helper()
	raw := t.TempDir()
	base, err := filepath.EvalSymlinks(raw)
	if err != nil {
		t.Fatal(err)
	}
	fixture := &supabaseFixture{raw: raw, base: base, steeringOK: true, reachable: true, now: time.UnixMilli(1_760_000_000_000), env: map[string]string{}}
	fixture.managed = filepath.Join(base, "wt", "feat-a")
	write(t, filepath.Join(fixture.managed, ".git", "HEAD"), "ref: refs/heads/feat-a\n")
	write(t, filepath.Join(fixture.managed, "supabase", "config.toml"), "project_id = \"example-app\"\n\n[experimental]\nstack = true\n")
	write(t, filepath.Join(fixture.managed, "apps", "mobile", "app.json"), "{}\n")
	write(t, filepath.Join(fixture.managed, "node_modules", ".bin", "supabase"), "#!/bin/sh\n")
	fixture.repo = filepath.Join(base, "repo")
	fixture.linked = filepath.Join(base, "wt", "feat-b")
	write(t, filepath.Join(fixture.repo, ".git", "HEAD"), "ref: refs/heads/main\n")
	write(t, filepath.Join(fixture.repo, ".git", "worktrees", "feat-b", "HEAD"), "ref: refs/heads/feat-b\n")
	write(t, filepath.Join(fixture.repo, ".git", "worktrees", "feat-b", "commondir"), "../..\n")
	write(t, filepath.Join(fixture.repo, "node_modules", ".bin", "supabase"), "#!/bin/sh\n")
	write(t, filepath.Join(fixture.linked, ".git"), "gitdir: "+filepath.Join(fixture.repo, ".git", "worktrees", "feat-b")+"\n")
	write(t, filepath.Join(fixture.linked, "supabase", "config.toml"), "# opted in with a dotted key\nexperimental.stack = true # local stacks\n")
	fixture.legacy = filepath.Join(base, "legacy")
	write(t, filepath.Join(fixture.legacy, ".git", "HEAD"), "ref: refs/heads/main\n")
	write(t, filepath.Join(fixture.legacy, "supabase", "config.toml"), "project_id = \"legacy\"\n\n[api]\nport = 54321\n")
	fixture.plain = filepath.Join(base, "plain")
	fixture.home = filepath.Join(base, "home")
	for _, directory := range []string{fixture.plain, fixture.home} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	fixture.steering = steeringState{
		writtenAt:  fixture.now.Add(-30 * time.Second),
		desktopPID: 4242,
		enabled:    true,
		roots: []steeringRoot{{
			worktreeRoot:  fixture.managed,
			projectRoot:   fixture.managed,
			branchContext: "refs/heads/feat-a",
			stackReady:    true,
			runner:        "pnpm exec supabase",
		}},
	}
	return fixture
}

func (fixture *supabaseFixture) environment() supabaseEnvironment {
	return supabaseEnvironment{
		steering: func() (steeringState, bool) {
			fixture.reads++
			return fixture.steering, fixture.steeringOK
		},
		reachable: func() bool {
			fixture.probes++
			return fixture.reachable
		},
		now:    func() time.Time { return fixture.now },
		home:   func() string { return fixture.home },
		getenv: func(name string) string { return fixture.env[name] },
	}
}

func (fixture *supabaseFixture) judge(cwd string, command string) HookDecision {
	return evaluateShellCallWith(shellCall{command: command, cwd: cwd}, fixture.environment())
}

// expect checks one command run from cwd: blocked with every wanted phrase
// in the reason, or allowed when nothing is wanted.
func (fixture *supabaseFixture) expect(t *testing.T, cwd string, command string, wants ...string) {
	t.Helper()
	decision := fixture.judge(cwd, command)
	if len(wants) == 0 {
		if decision.Block {
			t.Errorf("%q (in %s) should pass, got %q", command, cwd, decision.Reason)
		}
		return
	}
	if !decision.Block {
		t.Errorf("%q (in %s) should be blocked", command, cwd)
		return
	}
	for _, want := range wants {
		if !strings.Contains(decision.Reason, want) {
			t.Errorf("%q (in %s): reason %q lacks %q", command, cwd, decision.Reason, want)
		}
	}
}

func TestSupabaseRulesApplyOnlyWhileTheFeatureIsOn(t *testing.T) {
	fixture := newSupabaseFixture(t)
	for _, command := range []string{"supabase stop --all", "pkill postgres", "supabase start", "supabase status --env > .env"} {
		fixture.steeringOK = false
		fixture.expect(t, fixture.linked, command)
		fixture.steeringOK = true
		fixture.steering.enabled = false
		fixture.expect(t, fixture.linked, command)
		fixture.steering.enabled = true
		fixture.expect(t, fixture.linked, command, "Blocked")
	}
	// Lines that run neither supabase nor a kill tool never read the file.
	fixture.reads = 0
	for _, command := range []string{"git status", "pnpm test", "cd /tmp && ls", "echo supabase stop --all", "grep -r 'pkill postgres' docs", "cat supabase/config.toml"} {
		fixture.expect(t, fixture.linked, command)
	}
	if fixture.reads != 0 {
		t.Fatalf("steering.json read %d times for unrelated commands", fixture.reads)
	}
}

func TestSupabaseFallbackKeepsStacksNative(t *testing.T) {
	fixture := newSupabaseFixture(t)
	in := fixture.linked
	for command, corrected := range map[string]string{
		"supabase start":                               "supabase start --runtime native",
		"npx supabase start":                           "npx supabase start --runtime native",
		"npx -y supabase start --exclude studio":       "npx -y supabase start --runtime native --exclude studio",
		"npx supabase@2.121.0 start":                   "npx supabase@2.121.0 start --runtime native",
		"pnpm exec supabase start":                     "pnpm exec supabase start --runtime native",
		"pnpm dlx supabase start":                      "pnpm dlx supabase start --runtime native",
		"pnpm supabase start":                          "pnpm supabase start --runtime native",
		"yarn supabase start":                          "yarn supabase start --runtime native",
		"yarn dlx supabase start":                      "yarn dlx supabase start --runtime native",
		"bunx supabase start":                          "bunx supabase start --runtime native",
		"bun x supabase start":                         "bun x supabase start --runtime native",
		"npm exec -- supabase start":                   "npm exec -- supabase start --runtime native",
		"./node_modules/.bin/supabase start":           "./node_modules/.bin/supabase start --runtime native",
		"supabase start --runtime docker":              "supabase start --runtime native",
		"supabase start --runtime=auto -x studio":      "supabase start --runtime native -x studio",
		"supabase start --runtime podman":              "supabase start --runtime native",
		"supabase start --runtime":                     "supabase start --runtime native",
		"supabase --workdir . start":                   "supabase --workdir . start --runtime native",
		"supabase stack start":                         "supabase stack start --runtime native",
		"supabase stack prepare":                       "supabase stack prepare --runtime native",
		"supabase local start":                         "supabase local start --runtime native",
		"SUPABASE_EXPERIMENTAL_STACK=1 supabase start": "SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native",
		"supabase start > start.log 2>&1":              "supabase start --runtime native > start.log 2>&1",
		"supabase start --exclude 'studio, mail'":      "supabase start --runtime native --exclude 'studio, mail'",
	} {
		fixture.expect(t, in, command, "without `--runtime native`", "`"+corrected+"`", "ask the user")
	}
	fixture.expect(t, in, "supabase db start", "`supabase db start`", "`supabase start --runtime native`")
	fixture.expect(t, in, "pnpm exec supabase db start", "`pnpm exec supabase start --runtime native`")
	for _, command := range []string{
		"supabase db schema declarative generate",
		"supabase db schema declarative sync --local",
		"supabase db schema declarative generate --local=true",
		"supabase start --runtime native; supabase db schema declarative generate",
		"supabase start --runtime native || supabase db schema declarative generate",
		"supabase start --runtime native & supabase db schema declarative generate",
	} {
		fixture.expect(t, in, command, "automatic runtime selection", "`supabase start --runtime native && ")
	}
	fixture.expect(t, in, "supabase start --runtime docker && supabase db schema declarative generate", "without `--runtime native`")
	for _, command := range []string{
		"supabase start --runtime native",
		"supabase start --runtime=native",
		"npx supabase start --runtime native",
		"npx -y supabase@2.121.0 start --runtime=native",
		"pnpm dlx supabase start --runtime native",
		"pnpm supabase start --runtime native",
		"yarn supabase start --runtime native",
		"yarn dlx supabase start --runtime native",
		"bunx supabase start --runtime native",
		"bun x supabase start --runtime native",
		"npm exec -- supabase start --runtime native",
		"./node_modules/.bin/supabase start --runtime native",
		"supabase stack start --runtime native",
		"supabase stack prepare --runtime=native",
		"supabase start --runtime docker --runtime native",
		"pnpm exec supabase start --runtime native --exclude studio,analytics",
		"supabase start --help",
		"supabase start -h",
		"supabase help start",
		"supabase db start --help",
		"supabase stop",
		"supabase status",
		"supabase stack restart",
		"supabase stack list",
		"supabase stack logs --service auth",
		"supabase stack status",
		"supabase migration up --local",
		"supabase migration new add_profiles",
		"supabase db reset --local",
		"supabase gen types typescript --local > src/types/database.ts",
		"supabase test db",
		"supabase seed buckets --local",
		"supabase inspect db db-stats --local",
		"supabase functions serve",
		"supabase init",
		"supabase link --project-ref abcdefghijklmnopqrst",
		"supabase db diff",
		"supabase start --runtime native && supabase db schema declarative generate",
		"pnpm exec supabase start --runtime native && pnpm exec supabase db schema declarative sync --local",
		"supabase start --runtime native && echo ready && supabase db schema declarative generate",
		"supabase db schema declarative generate --linked",
		"supabase db schema declarative sync --db-url postgresql://example.com:5432/postgres",
		"supabase db schema declarative generate --local=false",
	} {
		fixture.expect(t, in, command)
	}
}

func TestSupabaseFallbackAppliesOnlyToOptedInProjects(t *testing.T) {
	fixture := newSupabaseFixture(t)
	native := "--runtime native"
	for _, cwd := range []string{fixture.legacy, fixture.plain, fixture.home, "", "relative/dir"} {
		for _, command := range []string{"supabase start", "supabase db start", "supabase db schema declarative generate"} {
			fixture.expect(t, cwd, command)
		}
	}
	fixture.expect(t, fixture.legacy, "SUPABASE_EXPERIMENTAL_STACK=1 supabase start", native)
	fixture.expect(t, fixture.legacy, "env SUPABASE_EXPERIMENTAL_STACK=1 npx supabase start", native)
	fixture.expect(t, fixture.linked, "SUPABASE_EXPERIMENTAL_STACK=0 supabase start")
	// The CLI accepts only 0 or 1.
	fixture.expect(t, fixture.linked, "SUPABASE_EXPERIMENTAL_STACK=true supabase start")
	// The hook's own environment counts when the segment does not say.
	fixture.env["SUPABASE_EXPERIMENTAL_STACK"] = "1"
	fixture.expect(t, fixture.legacy, "supabase start", native)
	fixture.env["SUPABASE_EXPERIMENTAL_STACK"] = "0"
	fixture.expect(t, fixture.linked, "supabase start")
	fixture.expect(t, fixture.linked, "SUPABASE_EXPERIMENTAL_STACK=1 supabase start", native)
	delete(fixture.env, "SUPABASE_EXPERIMENTAL_STACK")
	// The CLI's routing prefers config.json over config.toml.
	project := filepath.Join(fixture.base, "json-project")
	write(t, filepath.Join(project, "supabase", "config.toml"), "project_id = \"json\"\n")
	write(t, filepath.Join(project, "supabase", "config.json"), `{"experimental":{"stack":true}}`)
	fixture.expect(t, project, "supabase start", native)
	write(t, filepath.Join(project, "supabase", "config.json"), `{"experimental":{"stack":false}}`)
	write(t, filepath.Join(project, "supabase", "config.toml"), "[experimental]\nstack = true\n")
	fixture.expect(t, project, "supabase start")
	// A command below the project root finds the config above it.
	fixture.expect(t, filepath.Join(fixture.linked, "supabase"), "supabase start", native)
}

func TestTomlStackFlagForms(t *testing.T) {
	for text, want := range map[string]bool{
		"[experimental]\nstack = true\n":                              true,
		"[experimental]\nstack=true":                                  true,
		"[ experimental ]  # local stacks\n  stack = true  # on\n":    true,
		"experimental.stack = true\n":                                 true,
		"\"experimental\".\"stack\" = true\n":                         true,
		"experimental = { stack = true }\n":                           true,
		"experimental = { other = 1, stack = true }\n":                true,
		"[experimental]\nother = \"# not a comment\"\nstack = true\n": true,
		"[experimental]\nstack = false\n":                             false,
		"[experimental]\nstack = \"true\"\n":                          false,
		"[experimental]\nstack = env(SUPABASE_STACK)\n":               false,
		"[experimental]\nstack = true\nstack = true\n":                false,
		"[api]\nstack = true\n":                                       false,
		"stack = true\n":                                              false,
		"[experimental]\n# stack = true\n":                            false,
		"[experimental.stack]\nenabled = true\n":                      false,
		"[db]\nnote = \"\"\"\n[experimental]\nstack = true\n\"\"\"\n": false,
		"[[remotes]]\nstack = true\n":                                 false,
		"":                                                            false,
	} {
		if got := tomlStackEnabled(text); got != want {
			t.Errorf("%q: %v, want %v", text, got, want)
		}
	}
}

func TestSupabaseRulesFollowTheCommandDirectory(t *testing.T) {
	fixture := newSupabaseFixture(t)
	from := fixture.plain
	native := "--runtime native"
	fixture.expect(t, from, "cd "+fixture.linked+" && supabase start", native)
	fixture.expect(t, from, "cd "+fixture.legacy+" && supabase start")
	fixture.expect(t, fixture.legacy, "cd ../wt/feat-b && supabase start", native)
	fixture.expect(t, from, "cd "+fixture.linked+"; supabase start", native)
	fixture.expect(t, from, "cd "+fixture.linked+"\nsupabase start", native)
	fixture.expect(t, from, "cd -P "+fixture.linked+" && supabase start", native)
	fixture.expect(t, from, "(cd "+fixture.linked+"; supabase start)", native)
	fixture.expect(t, from, "(cd "+fixture.linked+"); supabase start")
	fixture.expect(t, from, "cd "+fixture.linked+" | supabase start")
	fixture.expect(t, from, "cd "+fixture.linked+" & supabase start")
	fixture.expect(t, from, "pushd "+fixture.linked+" && supabase start", native)
	fixture.expect(t, fixture.linked, "popd && supabase start")
	fixture.expect(t, fixture.linked, `cd "$SOMEWHERE" && supabase start`)
	fixture.expect(t, fixture.linked, "cd - && supabase start")
	fixture.expect(t, from, "echo $(cd "+fixture.linked+" && supabase start)", native)
	fixture.expect(t, from, "echo $(cd "+fixture.linked+") && supabase start")
	fixture.expect(t, from, "supabase start --workdir "+fixture.linked, native)
	fixture.expect(t, from, "supabase start --workdir="+fixture.linked, native)
	// --workdir is used exactly as given, with no search above it.
	fixture.expect(t, from, "supabase start --workdir "+filepath.Join(fixture.linked, "supabase"))
	fixture.expect(t, from, "SUPABASE_WORKDIR="+fixture.linked+" supabase start", native)
	fixture.expect(t, from, "pnpm -C "+fixture.linked+" exec supabase start", native)
	fixture.expect(t, from, "pnpm --dir="+fixture.linked+" exec supabase start", native)
	fixture.expect(t, from, "yarn --cwd "+fixture.linked+" supabase start", native)
	fixture.expect(t, from, "bash -lc 'cd "+fixture.linked+" && supabase start'", native)
	fixture.expect(t, fixture.linked, `sh -c "supabase start"`, native)
	fixture.expect(t, fixture.linked, "bash -o pipefail -c 'supabase start | tee start.log'", native)
	fixture.expect(t, fixture.linked, "bash -O extglob --norc -ec 'supabase start'", native)
	fixture.expect(t, fixture.linked, "eval supabase start", native)
	fixture.expect(t, fixture.linked, "bash scripts/start.sh")
	fixture.home = fixture.linked
	fixture.expect(t, from, "cd && supabase start", native)
	fixture.expect(t, from, "cd ~ && supabase start", native)
	fixture.expect(t, from, "cd $HOME/supabase/.. && supabase start", native)
	fixture.expect(t, from, "cd ~/supabase && supabase start", native)
}

func TestSupabaseAlwaysOnRulesProtectOtherAgentsStacks(t *testing.T) {
	fixture := newSupabaseFixture(t)
	for _, cwd := range []string{fixture.legacy, fixture.linked, fixture.managed, fixture.plain, ""} {
		for _, command := range []string{"supabase stop --all", "npx supabase stop --all", "supabase stack stop --all", "supabase local stop --all", "supabase stop --all=true", "supabase --workdir . stop --all"} {
			fixture.expect(t, cwd, command, "every agent's local Supabase stack", "rndevtools `supabase` tool (operation down")
		}
		if cwd != fixture.managed {
			// In the managed worktree any stop is redirected instead.
			fixture.expect(t, cwd, "supabase stop --all=false --stack mine")
		}
		for _, command := range []string{"supabase stop --stack-id 64616c83", "supabase stack stop --stack-id=64616c83912c", "supabase stop --project-id example-app"} {
			fixture.expect(t, cwd, command, "may stop another agent's stack")
		}
		for _, command := range []string{"supabase stack destroy", "supabase stack destroy --stack-id 64616c83 --yes", "pnpm exec supabase local destroy"} {
			fixture.expect(t, cwd, command, "deletes a local database", "RN Devtools › Supabase", "operation destroy", "db reset --local")
		}
	}
	// --workdir and SUPABASE_WORKDIR may name only this worktree.
	fixture.expect(t, fixture.linked, "supabase stop --workdir "+fixture.legacy, "outside this worktree")
	fixture.expect(t, fixture.linked, "SUPABASE_WORKDIR="+fixture.legacy+" supabase stop", "outside this worktree")
	fixture.expect(t, fixture.linked, "supabase stop --workdir ../feat-a", "outside this worktree")
	fixture.expect(t, fixture.linked, "supabase stop --workdir .")
	fixture.expect(t, fixture.linked, "supabase stop --workdir supabase/..")
	fixture.expect(t, filepath.Join(fixture.linked, "supabase"), "supabase stop --workdir ..")

	for _, command := range []string{
		"pkill postgres", "pkill -9 -f supabase", "killall postgres", "sudo pkill -f edge-runtime",
		"kill $(pgrep postgres)", "kill -9 $(pgrep -f supabase)", "kill `pidof postgres`",
		"pgrep -f postgres | xargs kill -9", "ps aux | grep postgres | awk '{print $2}' | xargs kill",
		"pg_ctl -D /tmp/data stop -m fast", "pkill auth", "pkill -f gotrue", "killall beam.smp",
		"pkill -f 'postgres: '", "pkill -f realtime", "pkill mailpit", "/usr/bin/pkill postgres",
	} {
		fixture.expect(t, fixture.legacy, command, "kills every agent's database", "operation down")
	}
	for _, command := range []string{
		"pkill -f node", "kill 1234", "pgrep postgres", "pkill oauth-proxy", "killall Simulator",
		"ps aux | grep postgres", "pg_ctl status", "kill -0 $(cat metro.pid)", "pgrep -f supabase | wc -l",
		"echo postgres | xargs echo",
	} {
		fixture.expect(t, fixture.legacy, command)
	}

	for command, file := range map[string]string{
		"supabase status --env > .env":                                ".env",
		"supabase status -o env >> .env.local":                        ".env.local",
		"supabase status --env &> .env":                               ".env",
		"supabase status --env >.env":                                 ".env",
		"supabase status --env>.env":                                  ".env",
		"supabase status --env >| .env":                               ".env",
		"supabase status -o env > apps/mobile/.env.development.local": "apps/mobile/.env.development.local",
		"supabase status --output=env > .env":                         ".env",
		"supabase status -oenv > .env":                                ".env",
		"supabase status --env --output-format text > .env.local":     ".env.local",
		"supabase status --env | tee .env":                            ".env",
		"supabase status -o env | tee -a .env.local":                  ".env.local",
		"supabase status -o env | grep KEY > .env":                    ".env",
		"supabase stack status --env > .env":                          ".env",
		`npx supabase status --env > "$PWD/.env"`:                     "$PWD/.env",
	} {
		fixture.expect(t, fixture.legacy, command, "SECRET_KEY", "operation env", file)
	}
	for _, command := range []string{
		"supabase status --env", "supabase status > status.txt", "supabase status -o env | grep API_URL",
		"supabase status --env > /tmp/supabase-status.txt", "supabase status -o json > status.json",
		"supabase status --env | pbcopy",
	} {
		fixture.expect(t, fixture.legacy, command)
	}

	// Here-document bodies are input, not commands: commit messages and files
	// that mention these commands pass.
	for _, command := range []string{
		"git commit -m \"$(cat <<'EOF'\nfix: never run supabase stop --all or pkill postgres\nEOF\n)\"",
		"cat > docs/local-db.md <<'EOF'\nsupabase start\nsupabase status --env > .env\nEOF",
		"cat > scripts/reset.sh <<EOF\nsupabase stack destroy --yes\nEOF",
	} {
		fixture.expect(t, fixture.linked, command)
	}
	fixture.expect(t, fixture.linked, "cat > notes.md <<'EOF'\nsupabase start\nEOF\nsupabase stop --all", "every agent's")

	// Only the command that runs rndevtools is exempt.
	fixture.expect(t, fixture.linked, "rndevtools supabase --operation up --worktree "+fixture.linked)
	fixture.expect(t, fixture.linked, `rndevtools claim --udid 727CE7B2-CCBA-47A5-8803-1D61DCEBCF44 --note "supabase stop --all broke it"`)
	fixture.expect(t, fixture.linked, "rndevtools doctor; supabase stop --all", "every agent's")
	fixture.expect(t, fixture.linked, "rndevtools doctor && pkill postgres", "kills every agent's database")
	fixture.expect(t, fixture.linked, "rndevtools supabase --operation up --worktree . && supabase start", "--runtime native")
}

func TestSupabaseManagedModeRedirectsToRNDevtools(t *testing.T) {
	fixture := newSupabaseFixture(t)
	in := fixture.managed
	up := "rndevtools supabase --operation up --worktree " + fixture.managed
	down := "rndevtools supabase --operation down --worktree " + fixture.managed
	for _, command := range []string{
		"supabase start", "supabase start --runtime native", "pnpm exec supabase start", "supabase stack start",
		"supabase stack restart", "supabase stack prepare --runtime native", "supabase local start", "supabase dev",
	} {
		fixture.expect(t, in, command, "RN Devtools runs this worktree's local Supabase", up, "lane up", "`pnpm exec supabase … --local`")
	}
	for _, command := range []string{"supabase stop", "pnpm exec supabase stop", "supabase stack stop", "supabase local stop"} {
		fixture.expect(t, in, command, down, "data is kept")
	}
	fixture.expect(t, in, "supabase db start", up)
	fixture.expect(t, in, "supabase migration up --local --runtime docker", "--runtime`", "always native", up)
	for _, command := range []string{
		"npx supabase@latest migration up --local", "npx -p supabase@2.0.0 supabase migration up --local",
		"pnpm dlx supabase migration up --local", "pnpx supabase gen types typescript --local",
		"yarn dlx supabase gen types typescript --local", "bunx supabase@latest db reset --local",
		"/opt/homebrew/bin/supabase migration up --local", "~/bin/supabase db reset --local",
	} {
		fixture.expect(t, in, command, "only answers the CLI build that started it", "`pnpm exec supabase`")
	}
	for _, command := range []string{
		"pnpm exec supabase migration up --local", "./node_modules/.bin/supabase migration up --local",
		fixture.managed + "/node_modules/.bin/supabase migration list --local", "supabase migration up --local",
		"npx supabase db reset --local", "supabase status", "supabase status --env", "supabase stack list",
		"supabase stack logs --tail 50", "supabase gen types typescript --local", "supabase migration new add_profiles",
		"supabase db diff", "supabase db pull", "supabase migration squash", "supabase db schema declarative generate",
		"supabase test db", "supabase start --help",
	} {
		fixture.expect(t, in, command)
	}
	// The app directory of a monorepo worktree uses the worktree's project.
	fixture.expect(t, filepath.Join(fixture.managed, "apps", "mobile"), "supabase start", up)
	// --workdir and cd reach a managed root from elsewhere.
	fixture.expect(t, fixture.plain, "supabase start --workdir "+fixture.managed, up)
	fixture.expect(t, fixture.plain, "cd "+fixture.managed+" && supabase stop", down)
	// The rules that protect other agents still come first.
	fixture.expect(t, in, "supabase stop --all", "every agent's")
	fixture.expect(t, in, "supabase stack destroy", "deletes a local database")
	// The payload may name the worktree through a symlink (/var and /private/var).
	fixture.expect(t, filepath.Join(fixture.raw, "wt", "feat-a"), "supabase start", up)
	// The desktop is probed once per call, and not at all outside managed roots.
	fixture.probes = 0
	fixture.judge(in, "supabase status; supabase migration up --local; supabase gen types typescript --local")
	if fixture.probes != 1 {
		t.Fatalf("probed the desktop %d times in one call", fixture.probes)
	}
	fixture.probes = 0
	fixture.judge(fixture.linked, "supabase start --runtime native")
	fixture.judge(fixture.legacy, "supabase stop --all")
	if fixture.probes != 0 {
		t.Fatalf("probed the desktop %d times for unmanaged commands", fixture.probes)
	}
}

func TestSupabaseManagedModeWaitsForTheBranchStack(t *testing.T) {
	fixture := newSupabaseFixture(t)
	in := fixture.managed
	fixture.steering.roots[0].stackReady = false
	for _, command := range []string{"supabase db diff", "supabase db pull", "supabase migration squash", "supabase db schema declarative sync", "supabase db diff --linked"} {
		fixture.expect(t, in, command, "no running local stack yet", "operation up")
	}
	for _, command := range []string{"supabase db schema declarative generate --linked", "supabase migration up --local", "supabase gen types typescript --local"} {
		fixture.expect(t, in, command)
	}
	// Ready, until the worktree moves to another branch.
	fixture.steering.roots[0].stackReady = true
	fixture.expect(t, in, "supabase db diff")
	write(t, filepath.Join(fixture.managed, ".git", "HEAD"), "ref: refs/heads/feat-c\n")
	fixture.expect(t, in, "supabase db diff", "no running local stack yet")
	write(t, filepath.Join(fixture.managed, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n")
	fixture.expect(t, in, "supabase db diff", "no running local stack yet")
	fixture.steering.roots[0].branchContext = "detached"
	fixture.expect(t, in, "supabase db diff")
	// An unreadable HEAD is no reason to block.
	write(t, filepath.Join(fixture.managed, ".git", "HEAD"), "garbage\n")
	fixture.expect(t, in, "supabase db diff")
}

func TestSupabaseManagedModeMatchesTheProjectAndTheRepository(t *testing.T) {
	fixture := newSupabaseFixture(t)
	nested := filepath.Join(fixture.managed, "apps", "other")
	write(t, filepath.Join(nested, "supabase", "config.toml"), "[experimental]\nstack = true\n")
	// Another project inside a managed root is not the root's own.
	fixture.expect(t, nested, "supabase start", "without `--runtime native`")
	fixture.expect(t, nested, "supabase start --runtime native")
	// A linked worktree may run the CLI from its repository's main checkout.
	fixture.steering.roots = append(fixture.steering.roots, steeringRoot{
		worktreeRoot: fixture.linked, projectRoot: fixture.linked, branchContext: "refs/heads/feat-b", stackReady: true, runner: "npx supabase",
	})
	fixture.expect(t, fixture.linked, "supabase start", "rndevtools supabase --operation up --worktree "+fixture.linked, "`npx supabase … --local`")
	fixture.expect(t, fixture.linked, fixture.repo+"/node_modules/.bin/supabase migration up --local")
	fixture.expect(t, fixture.linked, fixture.legacy+"/node_modules/.bin/supabase migration up --local", "Run `npx supabase` from this worktree")
	fixture.expect(t, fixture.linked, "supabase db diff")
}

func TestSupabaseManagedModeNeedsALiveDesktop(t *testing.T) {
	fixture := newSupabaseFixture(t)
	in := fixture.managed
	// A desktop that does not answer left its file behind: fallback rules.
	fixture.reachable = false
	fixture.expect(t, in, "supabase start", "without `--runtime native`", "`supabase start --runtime native`")
	fixture.expect(t, in, "supabase start --runtime native")
	fixture.expect(t, in, "supabase stop")
	// So does a file older than three minutes, without a probe.
	fixture.reachable = true
	fixture.probes = 0
	fixture.now = fixture.steering.writtenAt.Add(steeringFreshFor + time.Second)
	fixture.expect(t, in, "supabase start", "without `--runtime native`")
	if fixture.probes != 0 {
		t.Fatalf("probed the desktop %d times for a stale file", fixture.probes)
	}
	fixture.now = fixture.steering.writtenAt.Add(-2 * time.Minute)
	fixture.expect(t, in, "supabase start", "without `--runtime native`")
	fixture.now = fixture.steering.writtenAt.Add(time.Minute)
	fixture.expect(t, in, "supabase start", "operation up")
}

func TestSupabaseSteeringFileThroughTheHook(t *testing.T) {
	fixture := newSupabaseFixture(t)
	// Unix socket paths are short on macOS, so use a short private directory.
	directory, err := os.MkdirTemp("", "rdt-steer-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	file := filepath.Join(directory, steeringFileName)
	socket := filepath.Join(directory, "rndevtools.sock")
	environment := supabaseEnvironment{
		steering:  func() (steeringState, bool) { return readSteering(directory) },
		reachable: func() bool { return client.Reachable(socket, desktopProbeTimeout) },
		now:       time.Now,
		home:      func() string { return fixture.home },
		getenv:    func(string) string { return "" },
	}
	judge := func(cwd string, command string) HookDecision {
		return evaluateShellCallWith(shellCall{command: command, cwd: cwd}, environment)
	}
	content := fmt.Sprintf(`{"version":1,"writtenAt":%d,"desktopPid":4242,"supabase":{"enabled":true,"roots":[`+
		`{"worktreeRoot":%q,"projectRoot":%q,"mode":"managed","branchContext":"refs/heads/feat-a","stackReady":true,"runner":"pnpm exec supabase"}]}}`,
		time.Now().UnixMilli(), fixture.managed, fixture.managed)
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	// No desktop listens: a crash left the file, so the fallback rules apply.
	if decision := judge(fixture.managed, "supabase start"); !decision.Block || !strings.Contains(decision.Reason, "without `--runtime native`") {
		t.Fatalf("dead desktop: %+v", decision)
	}
	// A desktop listening on its socket manages the root.
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	if err := os.Chmod(socket, 0o600); err != nil {
		t.Fatal(err)
	}
	if decision := judge(fixture.managed, "supabase start"); !decision.Block || !strings.Contains(decision.Reason, "operation up") {
		t.Fatalf("live desktop: %+v", decision)
	}
	if !judge(fixture.legacy, "supabase stop --all").Block {
		t.Fatal("a valid file turns the rules on")
	}
	// A file anyone else could have written turns every Supabase rule off.
	if err := os.Chmod(file, 0o620); err != nil {
		t.Fatal(err)
	}
	if decision := judge(fixture.legacy, "supabase stop --all"); decision.Block {
		t.Fatalf("a group-writable file must be ignored: %q", decision.Reason)
	}
	if err := os.Chmod(file, 0o600); err != nil {
		t.Fatal(err)
	}
	// So does a symlink in its place, or garbage.
	real := filepath.Join(directory, "real.json")
	if err := os.Rename(file, real); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, file); err != nil {
		t.Fatal(err)
	}
	if decision := judge(fixture.legacy, "supabase stop --all"); decision.Block {
		t.Fatalf("a symlinked file must be ignored: %q", decision.Reason)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if decision := judge(fixture.legacy, "supabase stop --all"); decision.Block {
		t.Fatalf("an invalid file must be ignored: %q", decision.Reason)
	}
	// Simulator rules never depend on the file.
	if !judge(fixture.legacy, "xcrun simctl shutdown all").Block {
		t.Fatal("simctl rules run regardless of steering")
	}
}

func TestSupabaseRulesFailOpen(t *testing.T) {
	broken := supabaseEnvironment{
		steering:  func() (steeringState, bool) { panic("unreadable") },
		reachable: func() bool { return true },
		now:       time.Now,
		home:      func() string { return "/Users/example" },
		getenv:    func(string) string { return "" },
	}
	if decision := evaluateShellCallWith(shellCall{command: "supabase stop --all", cwd: "/w"}, broken); decision.Block {
		t.Fatalf("a failing rule must fail open: %q", decision.Reason)
	}
	fixture := newSupabaseFixture(t)
	for _, command := range []string{
		"supabase", "supabase ''", "npx", "pnpm exec", "pnpm", "yarn dlx", "npm exec --", "bun",
		`supabase "unterminated`, "supabase $(", "cd", "kill", "xargs kill", "supabase --workdir",
		"supabase stop --workdir", "SUPABASE_WORKDIR= supabase stop", "npx -c 'supabase start'",
		"pnpm exec -c 'supabase start'", "supabase-cli start", "supabase.sh start",
	} {
		fixture.expect(t, fixture.linked, command)
	}
}
