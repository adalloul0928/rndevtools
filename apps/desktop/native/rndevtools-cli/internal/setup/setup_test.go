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
	if !strings.Contains(pre[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)["command"].(string), "hook claude-pre-tool-use") {
		t.Fatalf("hook command: %v", pre[0])
	}

	codex, _ := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if !strings.Contains(string(codex), "model = \"gpt-5\"") || !strings.Contains(string(codex), "[mcp_servers.other.env]\nX = \"1\"") {
		t.Fatalf("codex config lost content:\n%s", codex)
	}
	if !strings.Contains(string(codex), "[mcp_servers.rndevtools]\ncommand = \""+executable+"\"\nargs = [\"mcp\"]\n") {
		t.Fatalf("codex config lacks rndevtools block:\n%s", codex)
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
		skill, err := os.ReadFile(filepath.Join(home, directory, "skills", SkillName, "SKILL.md"))
		if err != nil || !strings.Contains(string(skill), "name: rndevtools-lanes") {
			t.Fatalf("%s skill: %v", directory, err)
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
