package setup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("%s: %v\n%s", path, err, raw)
	}
	return document
}

func write(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func actions(report Report) map[string]string {
	out := map[string]string{}
	for _, change := range report.Changes {
		out[filepath.Base(filepath.Dir(change.Path))+"/"+filepath.Base(change.Path)] = change.Action
	}
	return out
}

func TestApplyInstallsEverythingAndIsIdempotent(t *testing.T) {
	home := t.TempDir()
	executable := filepath.Join(home, "RN Devtools.app", "rndevtools")
	write(t, executable, "#!/bin/sh\n")
	// Pre-existing configuration that must survive untouched.
	write(t, filepath.Join(home, ".claude.json"), `{"mcpServers":{"other":{"command":"other"}},"theme":"dark"}`)
	write(t, filepath.Join(home, ".claude", "settings.json"), `{"model":"opus","hooks":{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"say done"}]}]}}`)
	write(t, filepath.Join(home, ".codex", "config.toml"), "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other\"\n\n[mcp_servers.other.env]\nX = \"1\"\n")
	if err := os.MkdirAll(filepath.Join(home, ".kiro", "settings"), 0o755); err != nil {
		t.Fatal(err)
	}

	first, err := Apply(Options{Home: home, Executable: executable})
	if err != nil {
		t.Fatal(err)
	}
	got := actions(first)
	for key, want := range map[string]string{
		"bin/rndevtools": "create",
		home[len(filepath.Dir(home))+1:] + "/.claude.json": "update",
		".claude/settings.json":                            "update",
		".codex/config.toml":                               "update",
		".codex/hooks.json":                                "create",
		"settings/mcp.json":                                "create",
		"skills/rndevtools-lanes":                          "create",
	} {
		if got[key] != want {
			t.Fatalf("%s: action %q, want %q (all: %v)", key, got[key], want, got)
		}
	}
	if _, ok := got[".cursor/mcp.json"]; ok {
		t.Fatal("Cursor must not be configured when ~/.cursor does not exist")
	}

	claude := readJSON(t, filepath.Join(home, ".claude.json"))
	if claude["theme"] != "dark" {
		t.Fatal("unrelated Claude settings were lost")
	}
	servers := claude["mcpServers"].(map[string]any)
	if _, ok := servers["other"]; !ok {
		t.Fatal("other MCP server was lost")
	}
	entry := servers["rndevtools"].(map[string]any)
	if entry["command"] != executable || entry["args"].([]any)[0] != "mcp" || entry["type"] != "stdio" {
		t.Fatalf("claude entry: %v", entry)
	}

	settings := readJSON(t, filepath.Join(home, ".claude", "settings.json"))
	if settings["model"] != "opus" {
		t.Fatal("unrelated Claude settings.json keys were lost")
	}
	hooks := settings["hooks"].(map[string]any)
	if len(hooks["Stop"].([]any)) != 1 {
		t.Fatal("existing Stop hook was lost")
	}
	pre := hooks["PreToolUse"].([]any)
	if len(pre) != 1 || pre[0].(map[string]any)["matcher"] != "Bash" {
		t.Fatalf("PreToolUse hook: %v", pre)
	}
	if !strings.Contains(pre[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)["command"].(string), "hook pre-tool-use") {
		t.Fatalf("hook command: %v", pre[0])
	}
	end := hooks["SessionEnd"].([]any)
	if len(end) != 1 || !strings.Contains(end[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)["command"].(string), "hook session-end") {
		t.Fatalf("SessionEnd hook: %v", end)
	}
	if end[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)["timeout"] != float64(3) {
		t.Fatalf("SessionEnd must fit Codex's 3 s cap: %v", end[0])
	}

	// Codex gets the same two hooks in its own file, and setup says they need trusting.
	codexHooks := readJSON(t, filepath.Join(home, ".codex", "hooks.json"))["hooks"].(map[string]any)
	if len(codexHooks["PreToolUse"].([]any)) != 1 || len(codexHooks["SessionEnd"].([]any)) != 1 {
		t.Fatalf("codex hooks: %v", codexHooks)
	}
	if !first.CodexHooksNeedTrust {
		t.Fatal("setup must report that Codex hooks need trusting")
	}
	for _, change := range first.Changes {
		if strings.HasSuffix(change.Path, ".codex/hooks.json") && !strings.Contains(change.Detail, "/hooks") {
			t.Fatalf("codex hook change must mention /hooks: %+v", change)
		}
	}

	codex, _ := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if !strings.Contains(string(codex), "model = \"gpt-5\"") || !strings.Contains(string(codex), "[mcp_servers.other.env]\nX = \"1\"") {
		t.Fatalf("codex config lost content:\n%s", codex)
	}
	if !strings.Contains(string(codex), "[mcp_servers.rndevtools]\ncommand = \""+executable+"\"\nargs = [\"mcp\"]\ntool_timeout_sec = 240\n") {
		t.Fatalf("codex config lacks rndevtools block with the raised tool timeout:\n%s", codex)
	}

	kiro := readJSON(t, filepath.Join(home, ".kiro", "settings", "mcp.json"))
	kiroEntry := kiro["mcpServers"].(map[string]any)["rndevtools"].(map[string]any)
	if kiroEntry["disabled"] != false || len(kiroEntry["autoApprove"].([]any)) == 0 {
		t.Fatalf("kiro entry: %v", kiroEntry)
	}
	for _, approved := range kiroEntry["autoApprove"].([]any) {
		if approved == "input" || approved == "lane" {
			t.Fatal("mutating tools must not be auto-approved")
		}
	}

	link, err := os.Readlink(filepath.Join(home, ".local", "bin", "rndevtools"))
	if err != nil || link != executable {
		t.Fatalf("symlink: %q %v", link, err)
	}
	for _, directory := range []string{".claude", ".agents", ".kiro"} {
		for _, name := range []string{SkillName, "rndevtools-supabase"} {
			skill, err := os.ReadFile(filepath.Join(home, directory, "skills", name, "SKILL.md"))
			if err != nil || !strings.Contains(string(skill), "name: "+name+"\n") {
				t.Fatalf("%s %s skill: %v", directory, name, err)
			}
		}
	}
	for _, change := range first.Changes {
		if strings.HasSuffix(change.Path, filepath.Join(".claude", "settings.json")) && !strings.Contains(change.Detail, "local Supabase") {
			t.Fatalf("the hook change must say what the Supabase rules do: %+v", change)
		}
	}

	second, err := Apply(Options{Home: home, Executable: executable})
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range second.Changes {
		if change.Action != "unchanged" {
			t.Fatalf("second apply changed %s (%s: %s)", change.Path, change.Action, change.Detail)
		}
	}
	if second.CodexHooksNeedTrust {
		t.Fatal("unchanged hooks need no new trust")
	}
}

func TestApplyRepointsAndRefusesForeignFiles(t *testing.T) {
	home := t.TempDir()
	old := filepath.Join(home, "old", "rndevtools")
	current := filepath.Join(home, "new", "rndevtools")
	write(t, old, "")
	write(t, current, "")
	if _, err := Apply(Options{Home: home, Executable: old, Agents: []Agent{AgentClaude}, SkipHook: true}); err != nil {
		t.Fatal(err)
	}
	report, err := Apply(Options{Home: home, Executable: current, Agents: []Agent{AgentClaude}, SkipHook: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.Changes[0].Action != "update" || !strings.Contains(report.Changes[0].Detail, old) {
		t.Fatalf("link change: %+v", report.Changes[0])
	}
	link, _ := os.Readlink(filepath.Join(home, ".local", "bin", "rndevtools"))
	if link != current {
		t.Fatalf("symlink not repointed: %s", link)
	}
	servers := readJSON(t, filepath.Join(home, ".claude.json"))["mcpServers"].(map[string]any)
	if servers["rndevtools"].(map[string]any)["command"] != current {
		t.Fatal("MCP registration not repointed")
	}

	// A real file in the way is left alone and reported.
	if err := os.Remove(filepath.Join(home, ".local", "bin", "rndevtools")); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(home, ".local", "bin", "rndevtools"), "someone else's")
	report, err = Apply(Options{Home: home, Executable: current, Agents: []Agent{AgentClaude}, SkipHook: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.Changes[0].Action != "skip" {
		t.Fatalf("foreign file: %+v", report.Changes[0])
	}
	content, _ := os.ReadFile(filepath.Join(home, ".local", "bin", "rndevtools"))
	if string(content) != "someone else's" {
		t.Fatal("foreign file was overwritten")
	}
}

func TestInvalidJSONIsSkippedNotClobbered(t *testing.T) {
	home := t.TempDir()
	executable := filepath.Join(home, "rndevtools")
	write(t, executable, "")
	write(t, filepath.Join(home, ".claude.json"), "{not json")
	report, err := Apply(Options{Home: home, Executable: executable, Agents: []Agent{AgentClaude}, SkipLink: true, SkipHook: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.Changes[0].Action != "skip" {
		t.Fatalf("expected skip for invalid JSON: %+v", report.Changes[0])
	}
	content, _ := os.ReadFile(filepath.Join(home, ".claude.json"))
	if string(content) != "{not json" {
		t.Fatal("invalid file was rewritten")
	}
}

func TestCodexBlockIsReplacedInPlace(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".codex", "config.toml")
	write(t, path, "[mcp_servers.rndevtools]\ncommand = \"/stale/rndevtools\"\nargs = [\"mcp\"]\n\n[mcp_servers.rndevtools.env]\nA = \"b\"\n\n[other]\nkeep = true\n")
	report, err := Apply(Options{Home: home, Executable: "/fresh/rndevtools", Agents: []Agent{AgentCodex}, SkipLink: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.Changes[0].Action != "update" {
		t.Fatalf("%+v", report.Changes[0])
	}
	content, _ := os.ReadFile(path)
	text := string(content)
	if strings.Contains(text, "/stale/") || strings.Contains(text, "A = \"b\"") {
		t.Fatalf("stale rndevtools tables survived:\n%s", text)
	}
	if !strings.Contains(text, "[other]\nkeep = true") || strings.Count(text, "[mcp_servers.rndevtools]") != 1 {
		t.Fatalf("unexpected codex config:\n%s", text)
	}
	if strings.Count(text, "tool_timeout_sec = 240") != 1 {
		t.Fatalf("an upgraded block must carry the raised tool timeout once:\n%s", text)
	}
	// A block written before the timeout existed counts as stale and is
	// upgraded; a current one is left alone.
	again, err := Apply(Options{Home: home, Executable: "/fresh/rndevtools", Agents: []Agent{AgentCodex}, SkipLink: true})
	if err != nil {
		t.Fatal(err)
	}
	if again.Changes[0].Action != "unchanged" {
		t.Fatalf("a current block must be unchanged: %+v", again.Changes[0])
	}
}

func TestProjectModeInstallsSkillAndAgentsBlock(t *testing.T) {
	home := t.TempDir()
	project := filepath.Join(home, "repo")
	write(t, filepath.Join(project, "AGENTS.md"), "# My app\n\nExisting guidance.\n")
	report, err := Apply(Options{Home: home, Executable: "/x/rndevtools", Project: project, Agents: []Agent{AgentClaude, AgentCodex}, SkipLink: true, SkipHook: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{".claude", ".agents"} {
		if _, err := os.Stat(filepath.Join(project, directory, "skills", SkillName, "SKILL.md")); err != nil {
			t.Fatalf("%s project skill missing: %v", directory, err)
		}
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "skills")); err == nil {
		t.Fatal("project mode must not install user-level skills")
	}
	agents, _ := os.ReadFile(filepath.Join(project, "AGENTS.md"))
	text := string(agents)
	if !strings.HasPrefix(text, "# My app\n\nExisting guidance.\n\n<!-- rndevtools:start -->") || !strings.Contains(text, "Never run `xcrun simctl boot`") {
		t.Fatalf("AGENTS.md:\n%s", text)
	}
	if !strings.Contains(report.AgentsBlock, "rndevtools:start") {
		t.Fatal("report must carry the block for manual installs")
	}

	// Editing the block later replaces between the markers rather than appending twice.
	write(t, filepath.Join(project, "AGENTS.md"), strings.Replace(text, "Never run", "NEVER EVER run", 1))
	if _, err := Apply(Options{Home: home, Executable: "/x/rndevtools", Project: project, Agents: []Agent{AgentClaude}, SkipLink: true, SkipHook: true}); err != nil {
		t.Fatal(err)
	}
	agents, _ = os.ReadFile(filepath.Join(project, "AGENTS.md"))
	if strings.Count(string(agents), "rndevtools:start") != 1 || strings.Contains(string(agents), "NEVER EVER") {
		t.Fatalf("block not replaced in place:\n%s", agents)
	}
}

func TestEveryEmbeddedSkillIsInstalled(t *testing.T) {
	names := skillNames()
	if len(names) != 2 || names[0] != "rndevtools-lanes" || names[1] != "rndevtools-supabase" {
		t.Fatalf("embedded skills: %v", names)
	}
	for _, name := range names {
		content, err := skillFiles.ReadFile("skills/" + name + "/SKILL.md")
		if err != nil {
			t.Fatal(err)
		}
		text := string(content)
		if !strings.HasPrefix(text, "---\nname: "+name+"\ndescription: >\n") {
			t.Fatalf("%s: front matter must name the skill and describe it", name)
		}
	}
	supabase, _ := skillFiles.ReadFile("skills/rndevtools-supabase/SKILL.md")
	for _, phrase := range []string{
		"Supabase", "local database", "Postgres", "migration", "seed", "reset", "Studio", "logs",
		`rndevtools supabase --operation up --worktree "$PWD"`, "lane up", "--local",
		"--runtime native", "release --all", "Create or switch to your git branch first",
		"Never start or stop Supabase by hand while RN Devtools manages",
	} {
		if !strings.Contains(string(supabase), phrase) {
			t.Fatalf("the Supabase skill lacks %q", phrase)
		}
	}
	lanes, _ := skillFiles.ReadFile("skills/rndevtools-lanes/SKILL.md")
	for _, phrase := range []string{"--backend auto|off|required", "Never start Supabase by hand for a lane"} {
		if !strings.Contains(string(lanes), phrase) {
			t.Fatalf("the lanes skill lacks %q", phrase)
		}
	}

	home := t.TempDir()
	report, err := Apply(Options{Home: home, Executable: "/x/rndevtools", Agents: []Agent{AgentCodex}, SkipLink: true, SkipHook: true})
	if err != nil {
		t.Fatal(err)
	}
	installed := 0
	for _, change := range report.Changes {
		if strings.Contains(change.Path, filepath.Join(".agents", "skills")) {
			installed++
			if change.Action != "create" || !strings.Contains(change.Detail, filepath.Base(change.Path)) {
				t.Fatalf("skill change: %+v", change)
			}
		}
	}
	if installed != len(names) {
		t.Fatalf("%d of %d skills installed", installed, len(names))
	}
}

func TestAgentsBlockAddsLocalSupabaseOnlyForSupabaseProjects(t *testing.T) {
	home := t.TempDir()
	plain := filepath.Join(home, "plain")
	write(t, filepath.Join(plain, "AGENTS.md"), "# Plain\n")
	if _, err := Apply(Options{Home: home, Executable: "/x/rndevtools", Project: plain, Agents: []Agent{AgentClaude}, SkipLink: true, SkipHook: true}); err != nil {
		t.Fatal(err)
	}
	text, _ := os.ReadFile(filepath.Join(plain, "AGENTS.md"))
	if strings.Contains(string(text), "Local Supabase") || !strings.Contains(string(text), "## iOS Simulators") {
		t.Fatalf("a project without supabase/config.toml gets the Simulator block only:\n%s", text)
	}
	if strings.Contains(AgentsBlock(""), "Local Supabase") {
		t.Fatal("the block for manual installs has no project, so no Supabase paragraph")
	}

	for lockfile, runner := range map[string]string{
		"pnpm-lock.yaml":    "pnpm exec supabase",
		"yarn.lock":         "yarn supabase",
		"bun.lock":          "bunx supabase",
		"package-lock.json": "npx supabase",
		"":                  "npx supabase",
	} {
		project := filepath.Join(home, "app-"+strings.ReplaceAll(lockfile, ".", "-"))
		write(t, filepath.Join(project, "supabase", "config.toml"), "[experimental]\nstack = true\n")
		if lockfile != "" {
			write(t, filepath.Join(project, lockfile), "")
		}
		report, err := Apply(Options{Home: home, Executable: "/x/rndevtools", Project: project, Agents: []Agent{AgentClaude}, SkipLink: true, SkipHook: true})
		if err != nil {
			t.Fatal(err)
		}
		agents, _ := os.ReadFile(filepath.Join(project, "AGENTS.md"))
		block := string(agents)
		for _, phrase := range []string{"## iOS Simulators", "## Local Supabase", "`" + runner + " start --runtime native`", "`supabase stop --all`", "`supabase status --env`", "`lane up`"} {
			if !strings.Contains(block, phrase) {
				t.Fatalf("%s: AGENTS.md lacks %q:\n%s", lockfile, phrase, block)
			}
		}
		if report.AgentsBlock != block {
			t.Fatalf("%s: the report must carry the block it wrote", lockfile)
		}
		if strings.Count(block, "<!-- rndevtools:start -->") != 1 || !strings.HasSuffix(block, "<!-- rndevtools:end -->\n") {
			t.Fatalf("%s: the paragraph belongs inside the markers:\n%s", lockfile, block)
		}
	}
}

func TestPlanWritesNothing(t *testing.T) {
	home := t.TempDir()
	report, err := Plan(Options{Home: home, Executable: "/x/rndevtools", Agents: []Agent{AgentClaude, AgentCodex, AgentKiro}})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Changes) == 0 {
		t.Fatal("plan must list changes")
	}
	entries, _ := os.ReadDir(home)
	if len(entries) != 0 {
		t.Fatalf("plan wrote files: %v", entries)
	}
}
