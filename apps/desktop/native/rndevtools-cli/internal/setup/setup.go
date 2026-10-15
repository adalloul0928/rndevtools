// Package setup installs rndevtools into the coding agents on this Mac: the
// CLI on PATH, the MCP server in each agent's configuration, the lanes skill
// where each agent discovers skills, a Claude Code hook that steers raw
// `simctl` back to rndevtools, and a block for a project's AGENTS.md.
//
// Everything is idempotent and additive. Existing configuration is read,
// merged, and written back through a temporary file and rename; unknown keys
// are preserved; files we did not create are never deleted. `Plan` reports
// what would change so the caller can preview before `Apply`.
package setup

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

//go:embed skills/rndevtools-lanes/SKILL.md
var skillFiles embed.FS

// SkillName is the directory name the skill installs under.
const SkillName = "rndevtools-lanes"

// Agent identifies one coding agent whose configuration setup edits.
type Agent string

const (
	AgentClaude Agent = "claude"
	AgentCodex  Agent = "codex"
	AgentCursor Agent = "cursor"
	AgentKiro   Agent = "kiro"
)

// AllAgents lists every agent setup knows, in report order.
var AllAgents = []Agent{AgentClaude, AgentCodex, AgentCursor, AgentKiro}

// Options select what to install.
type Options struct {
	// Home is the user's home directory; defaults to os.UserHomeDir.
	Home string
	// Executable is the absolute path of the verified rndevtools binary the
	// symlink and the MCP registrations point at.
	Executable string
	// Agents to configure. Empty means every agent whose configuration
	// directory already exists (so setup never creates ~/.cursor on a Mac
	// without Cursor), plus Claude and Codex always.
	Agents []Agent
	// Project, when set, receives .agents/skills, .claude/skills, and an
	// AGENTS.md block instead of the user-level locations.
	Project string
	// SkipLink leaves PATH alone.
	SkipLink bool
	// SkipHook leaves Claude Code's hooks alone.
	SkipHook bool
}

// Change is one filesystem edit setup makes or would make.
type Change struct {
	Path   string `json:"path"`
	Action string `json:"action"` // create, update, unchanged, skip
	Detail string `json:"detail,omitempty"`
}

// Report is the outcome of Plan or Apply.
type Report struct {
	Executable string   `json:"executable"`
	Changes    []Change `json:"changes"`
	// AgentsBlock is the text to paste into a project's AGENTS.md or CLAUDE.md
	// when setup did not write one.
	AgentsBlock string `json:"agentsBlock"`
}

// Plan computes the edits without writing anything.
func Plan(options Options) (Report, error) {
	return run(options, false)
}

// Apply performs the edits.
func Apply(options Options) (Report, error) {
	return run(options, true)
}

func run(options Options, write bool) (Report, error) {
	if options.Home == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return Report{}, fmt.Errorf("resolve home directory: %w", err)
		}
		options.Home = home
	}
	if !filepath.IsAbs(options.Executable) {
		return Report{}, errors.New("the rndevtools executable path must be absolute")
	}
	agents := options.Agents
	if len(agents) == 0 {
		agents = detectAgents(options.Home)
	}
	report := Report{Executable: options.Executable, AgentsBlock: AgentsBlock()}
	record := func(change Change, err error) error {
		if err != nil {
			return err
		}
		report.Changes = append(report.Changes, change)
		return nil
	}

	if !options.SkipLink {
		if err := record(linkExecutable(options, write)); err != nil {
			return report, err
		}
	}
	for _, agent := range agents {
		switch agent {
		case AgentClaude:
			if err := record(writeJSONServers(filepath.Join(options.Home, ".claude.json"), "mcpServers", options.Executable, nil, write)); err != nil {
				return report, err
			}
			if !options.SkipHook {
				if err := record(installClaudeHook(filepath.Join(options.Home, ".claude", "settings.json"), options.Executable, write)); err != nil {
					return report, err
				}
			}
		case AgentCodex:
			if err := record(writeCodexServer(filepath.Join(options.Home, ".codex", "config.toml"), options.Executable, write)); err != nil {
				return report, err
			}
		case AgentCursor:
			if err := record(writeJSONServers(filepath.Join(options.Home, ".cursor", "mcp.json"), "mcpServers", options.Executable, nil, write)); err != nil {
				return report, err
			}
		case AgentKiro:
			extra := map[string]any{"disabled": false, "autoApprove": readOnlyTools()}
			if err := record(writeJSONServers(filepath.Join(options.Home, ".kiro", "settings", "mcp.json"), "mcpServers", options.Executable, extra, write)); err != nil {
				return report, err
			}
		default:
			return report, fmt.Errorf("unknown agent %q", agent)
		}
	}
	for _, directory := range skillDirectories(options, agents) {
		if err := record(installSkill(directory, write)); err != nil {
			return report, err
		}
	}
	if options.Project != "" {
		if err := record(installAgentsBlock(filepath.Join(options.Project, "AGENTS.md"), write)); err != nil {
			return report, err
		}
	}
	return report, nil
}

// detectAgents returns Claude and Codex unconditionally (their configuration
// lives in files setup can create) plus any other agent whose directory exists.
func detectAgents(home string) []Agent {
	agents := []Agent{AgentClaude, AgentCodex}
	if exists(filepath.Join(home, ".cursor")) {
		agents = append(agents, AgentCursor)
	}
	if exists(filepath.Join(home, ".kiro")) {
		agents = append(agents, AgentKiro)
	}
	return agents
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// MARK: - PATH

func linkExecutable(options Options, write bool) (Change, error) {
	directory := filepath.Join(options.Home, ".local", "bin")
	link := filepath.Join(directory, "rndevtools")
	change := Change{Path: link}
	if existing, err := os.Readlink(link); err == nil {
		if existing == options.Executable {
			change.Action = "unchanged"
			change.Detail = "symlink already points at this build"
			return change, nil
		}
		change.Action = "update"
		change.Detail = fmt.Sprintf("re-point symlink from %s", existing)
	} else if exists(link) {
		change.Action = "skip"
		change.Detail = "a file that is not a symlink is already installed there; remove it to let setup link the CLI"
		return change, nil
	} else {
		change.Action = "create"
		change.Detail = "symlink to the verified CLI (add ~/.local/bin to PATH if it is not already)"
	}
	if !write {
		return change, nil
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return change, err
	}
	temporary := link + ".tmp"
	_ = os.Remove(temporary)
	if err := os.Symlink(options.Executable, temporary); err != nil {
		return change, err
	}
	if err := os.Rename(temporary, link); err != nil {
		_ = os.Remove(temporary)
		return change, err
	}
	return change, nil
}

// MARK: - MCP registrations

func serverEntry(executable string, extra map[string]any) map[string]any {
	entry := map[string]any{
		"type":    "stdio",
		"command": executable,
		"args":    []any{"mcp"},
	}
	for key, value := range extra {
		entry[key] = value
	}
	return entry
}

// readOnlyTools lists the tools Kiro may run without a prompt: everything
// that only observes. Tools that drive a device still ask.
func readOnlyTools() []any {
	return []any{"simulators", "apps", "screen", "elements", "wait", "capture", "agents", "jobs", "slimming", "doctor"}
}

func writeJSONServers(path string, key string, executable string, extra map[string]any, write bool) (Change, error) {
	change := Change{Path: path}
	document := map[string]any{}
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		if len(bytes.TrimSpace(raw)) > 0 {
			if err := json.Unmarshal(raw, &document); err != nil {
				change.Action = "skip"
				change.Detail = "not valid JSON; fix it by hand, then rerun setup"
				return change, nil
			}
		}
		change.Action = "update"
	case errors.Is(err, fs.ErrNotExist):
		change.Action = "create"
	default:
		return change, err
	}
	servers, _ := document[key].(map[string]any)
	if servers == nil {
		servers = map[string]any{}
	}
	wanted := serverEntry(executable, extra)
	if existing, ok := servers["rndevtools"]; ok && jsonEqual(existing, wanted) {
		change.Action = "unchanged"
		change.Detail = "rndevtools MCP server already registered"
		return change, nil
	}
	change.Detail = "register the rndevtools MCP server (" + executable + " mcp)"
	servers["rndevtools"] = wanted
	document[key] = servers
	if !write {
		return change, nil
	}
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return change, err
	}
	return change, writeFileAtomically(path, append(encoded, '\n'), 0o600)
}

func jsonEqual(a any, b any) bool {
	left, errA := json.Marshal(a)
	right, errB := json.Marshal(b)
	return errA == nil && errB == nil && bytes.Equal(left, right)
}

var codexServerBlock = regexp.MustCompile(`(?ms)^\[mcp_servers\.rndevtools(?:\.[A-Za-z0-9_]+)?\]\n(?:[^\[\n][^\n]*\n|\n)*`)

// writeCodexServer edits ~/.codex/config.toml textually: it owns only the
// `[mcp_servers.rndevtools]` table and leaves every other byte alone.
func writeCodexServer(path string, executable string, write bool) (Change, error) {
	change := Change{Path: path}
	block := fmt.Sprintf("[mcp_servers.rndevtools]\ncommand = %q\nargs = [\"mcp\"]\n", executable)
	raw, err := os.ReadFile(path)
	var content string
	switch {
	case err == nil:
		content = string(raw)
		change.Action = "update"
	case errors.Is(err, fs.ErrNotExist):
		change.Action = "create"
	default:
		return change, err
	}
	stripped := codexServerBlock.ReplaceAllString(content, "")
	if stripped != content && strings.Contains(content, block) {
		change.Action = "unchanged"
		change.Detail = "rndevtools MCP server already registered"
		return change, nil
	}
	change.Detail = "register the rndevtools MCP server (" + executable + " mcp)"
	stripped = strings.TrimRight(stripped, "\n")
	if stripped != "" {
		stripped += "\n\n"
	}
	next := stripped + block
	if !write {
		return change, nil
	}
	return change, writeFileAtomically(path, []byte(next), 0o600)
}

// MARK: - Claude Code hook

// hookCommand is the PreToolUse command. It reads the tool input from stdin,
// and when the Bash command drives a Simulator through simctl it exits 2
// with the rndevtools equivalent on stderr, which Claude Code feeds back to
// the model as the reason the call was blocked. Listing and other read-only
// simctl verbs pass.
func hookCommand(executable string) string {
	return executable + " hook claude-pre-tool-use"
}

func installClaudeHook(path string, executable string, write bool) (Change, error) {
	change := Change{Path: path}
	document := map[string]any{}
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		if len(bytes.TrimSpace(raw)) > 0 {
			if err := json.Unmarshal(raw, &document); err != nil {
				change.Action = "skip"
				change.Detail = "not valid JSON; fix it by hand, then rerun setup"
				return change, nil
			}
		}
		change.Action = "update"
	case errors.Is(err, fs.ErrNotExist):
		change.Action = "create"
	default:
		return change, err
	}
	hooks, _ := document["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	entries, _ := hooks["PreToolUse"].([]any)
	wanted := map[string]any{
		"matcher": "Bash",
		"hooks": []any{map[string]any{
			"type":    "command",
			"command": hookCommand(executable),
			"timeout": 5,
		}},
	}
	kept := make([]any, 0, len(entries)+1)
	already := false
	for _, entry := range entries {
		if isRndevtoolsHook(entry) {
			if jsonEqual(entry, wanted) {
				already = true
				kept = append(kept, entry)
			}
			continue
		}
		kept = append(kept, entry)
	}
	if already {
		change.Action = "unchanged"
		change.Detail = "PreToolUse hook already installed"
		return change, nil
	}
	change.Detail = "add a PreToolUse hook that redirects xcrun simctl boot/shutdown/openurl/install/launch/io to rndevtools"
	kept = append(kept, wanted)
	hooks["PreToolUse"] = kept
	document["hooks"] = hooks
	if !write {
		return change, nil
	}
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return change, err
	}
	return change, writeFileAtomically(path, append(encoded, '\n'), 0o600)
}

func isRndevtoolsHook(entry any) bool {
	object, ok := entry.(map[string]any)
	if !ok {
		return false
	}
	hooks, _ := object["hooks"].([]any)
	for _, hook := range hooks {
		if command, ok := hook.(map[string]any)["command"].(string); ok && strings.Contains(command, "hook claude-pre-tool-use") {
			return true
		}
	}
	return false
}

// MARK: - Skill

func skillDirectories(options Options, agents []Agent) []string {
	var directories []string
	base := options.Home
	claude := filepath.Join(base, ".claude", "skills")
	agentsDirectory := filepath.Join(base, ".agents", "skills")
	if options.Project != "" {
		claude = filepath.Join(options.Project, ".claude", "skills")
		agentsDirectory = filepath.Join(options.Project, ".agents", "skills")
	}
	for _, agent := range agents {
		switch agent {
		case AgentClaude:
			directories = append(directories, claude)
		case AgentCodex:
			// Codex scans .agents/skills in the repository and $HOME/.agents/skills.
			directories = append(directories, agentsDirectory)
		case AgentKiro:
			if options.Project == "" {
				directories = append(directories, filepath.Join(base, ".kiro", "skills"))
			}
		}
	}
	sort.Strings(directories)
	return unique(directories)
}

func unique(values []string) []string {
	out := values[:0]
	for index, value := range values {
		if index == 0 || value != values[index-1] {
			out = append(out, value)
		}
	}
	return out
}

func installSkill(skillsDirectory string, write bool) (Change, error) {
	target := filepath.Join(skillsDirectory, SkillName)
	change := Change{Path: target}
	content, err := skillFiles.ReadFile("skills/rndevtools-lanes/SKILL.md")
	if err != nil {
		return change, err
	}
	existing, err := os.ReadFile(filepath.Join(target, "SKILL.md"))
	switch {
	case err == nil && bytes.Equal(existing, content):
		change.Action = "unchanged"
		change.Detail = "skill already current"
		return change, nil
	case err == nil:
		change.Action = "update"
		change.Detail = "refresh SKILL.md to this build's version"
	case errors.Is(err, fs.ErrNotExist):
		change.Action = "create"
		change.Detail = "install the rndevtools-lanes skill"
	default:
		return change, err
	}
	if !write {
		return change, nil
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return change, err
	}
	return change, writeFileAtomically(filepath.Join(target, "SKILL.md"), content, 0o644)
}

// MARK: - AGENTS.md

const (
	agentsBlockStart = "<!-- rndevtools:start -->"
	agentsBlockEnd   = "<!-- rndevtools:end -->"
)

// AgentsBlock is the project-instruction text. It is short on purpose: the
// MCP tool descriptions and the skill carry the detail; this only has to make
// an agent reach for them.
func AgentsBlock() string {
	return agentsBlockStart + `
## iOS Simulators

Simulators on this Mac are managed by RN Devtools. Use the ` + "`rndevtools`" + ` MCP
tools (or the ` + "`rndevtools`" + ` CLI) for anything involving a Simulator: ` + "`lane up`" + ` runs
this worktree on its own Simulator with its own Metro port; ` + "`input`" + ` and
` + "`capture`" + ` drive and observe the device. Never run ` + "`xcrun simctl boot`" + `,
` + "`shutdown`" + `, ` + "`openurl`" + `, ` + "`install`" + `, ` + "`launch`" + `, or start Metro by hand: other
agents share these devices and the desktop app owns their ports and claims.
` + agentsBlockEnd + "\n"
}

var agentsBlockPattern = regexp.MustCompile(`(?s)` + regexp.QuoteMeta(agentsBlockStart) + `.*?` + regexp.QuoteMeta(agentsBlockEnd) + `\n?`)

func installAgentsBlock(path string, write bool) (Change, error) {
	change := Change{Path: path}
	block := AgentsBlock()
	raw, err := os.ReadFile(path)
	var content string
	switch {
	case err == nil:
		content = string(raw)
		change.Action = "update"
	case errors.Is(err, fs.ErrNotExist):
		change.Action = "create"
	default:
		return change, err
	}
	if strings.Contains(content, block) {
		change.Action = "unchanged"
		change.Detail = "AGENTS.md block already current"
		return change, nil
	}
	change.Detail = "add the RN Devtools Simulator block between rndevtools markers"
	var next string
	if agentsBlockPattern.MatchString(content) {
		next = agentsBlockPattern.ReplaceAllLiteralString(content, block)
	} else {
		next = strings.TrimRight(content, "\n")
		if next != "" {
			next += "\n\n"
		}
		next += block
	}
	if !write {
		return change, nil
	}
	return change, writeFileAtomically(path, []byte(next), 0o644)
}

// MARK: - Files

func writeFileAtomically(path string, content []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if info, err := os.Stat(path); err == nil {
		// Preserve the operator's existing permissions on files we only edit.
		mode = info.Mode().Perm()
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".rndevtools-setup-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	cleanup := func() { _ = os.Remove(name) }
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		cleanup()
		return err
	}
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		cleanup()
		return err
	}
	if err := temporary.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(name, path); err != nil {
		cleanup()
		return err
	}
	return nil
}
