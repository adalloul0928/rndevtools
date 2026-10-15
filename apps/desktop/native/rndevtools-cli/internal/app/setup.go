package app

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/adalloul0928/rndevtools-cli/internal/client"
	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
	"github.com/adalloul0928/rndevtools-cli/internal/setup"
)

const setupUsage = `Usage: rndevtools setup [flags]

Installs rndevtools into the coding agents on this Mac so they use RN Devtools
for Simulators instead of raw simctl:

  * symlinks this CLI into ~/.local/bin
  * registers the MCP server (rndevtools mcp) with Claude Code (~/.claude.json),
    Codex (~/.codex/config.toml), Cursor (~/.cursor/mcp.json), and Kiro
    (~/.kiro/settings/mcp.json)
  * installs the rndevtools-lanes skill where each agent discovers skills
  * adds a Claude Code PreToolUse hook that redirects simctl boot/shutdown/
    openurl/install/launch/io and hand-started Metro to rndevtools
  * with --project, also installs the skill into that repository and adds an
    "iOS Simulators" block to its AGENTS.md

Everything is idempotent and additive; unknown configuration is preserved.
Finishes with the doctor check so a mis-registered path shows up now.

Flags:
  --agents claude,codex,cursor,kiro  Agents to configure (default: Claude and
                                     Codex, plus Cursor/Kiro when installed).
  --project <dir>                    Repository to receive the skill and the
                                     AGENTS.md block.
  --dry-run                          Print the plan; change nothing.
  --no-link                          Do not touch ~/.local/bin.
  --no-hook                          Do not install the Claude Code hook.
  --executable <path>                Register this binary instead of the
                                     running one (for packaged installs).
`

func runSetup(config Config) int {
	flags := flag.NewFlagSet("setup", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	agents := flags.String("agents", "", "")
	project := flags.String("project", "", "")
	dryRun := flags.Bool("dry-run", false, "")
	noLink := flags.Bool("no-link", false, "")
	noHook := flags.Bool("no-hook", false, "")
	executable := flags.String("executable", "", "")
	help := flags.Bool("help", false, "")
	if err := flags.Parse(config.Arguments[1:]); err != nil || flags.NArg() > 0 {
		if err == flag.ErrHelp || *help {
			fmt.Fprint(config.Stdout, setupUsage)
			return ExitSuccess
		}
		writeLocalError(config.Stderr, "invalid_arguments", "unrecognised setup flags", false, "Run rndevtools setup --help.", "")
		return ExitUsage
	}
	if *help {
		fmt.Fprint(config.Stdout, setupUsage)
		return ExitSuccess
	}
	options := setup.Options{SkipLink: *noLink, SkipHook: *noHook}
	if *agents != "" {
		for _, name := range strings.Split(*agents, ",") {
			options.Agents = append(options.Agents, setup.Agent(strings.TrimSpace(name)))
		}
	}
	if *project != "" {
		absolute, err := filepath.Abs(*project)
		if err != nil {
			writeLocalError(config.Stderr, "invalid_arguments", err.Error(), false, "", "")
			return ExitUsage
		}
		options.Project = absolute
	}
	resolved := *executable
	if resolved == "" {
		path, err := os.Executable()
		if err != nil {
			writeLocalError(config.Stderr, "internal_error", err.Error(), false, "", "")
			return ExitInternal
		}
		if real, err := filepath.EvalSymlinks(path); err == nil {
			path = real
		}
		resolved = path
	}
	options.Executable = resolved

	var report setup.Report
	var err error
	if *dryRun {
		report, err = setup.Plan(options)
	} else {
		report, err = setup.Apply(options)
	}
	if err != nil {
		writeLocalError(config.Stderr, "setup_failed", err.Error(), false, "", "")
		return ExitInternal
	}
	health := setupDoctor(config)
	writeJSON(config.Stdout, map[string]any{
		"dryRun":      *dryRun,
		"executable":  report.Executable,
		"changes":     report.Changes,
		"agentsBlock": report.AgentsBlock,
		"doctor":      health,
	})
	return ExitSuccess
}

// setupDoctor runs the doctor command and reports its outcome, so a user
// sees immediately whether the desktop app is running and reachable.
func setupDoctor(config Config) map[string]any {
	socketPath := config.SocketPath
	if socketPath == "" {
		resolved, err := client.DefaultSocketPath()
		if err != nil {
			return map[string]any{"ok": false, "message": err.Error()}
		}
		socketPath = resolved
	}
	localClient, err := client.New(socketPath, client.DefaultTimeout)
	if err != nil {
		return map[string]any{"ok": false, "message": err.Error()}
	}
	requestID, err := newRequestID()
	if err != nil {
		return map[string]any{"ok": false, "message": err.Error()}
	}
	response, err := localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       requestID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	if err != nil {
		return map[string]any{
			"ok":       false,
			"message":  "RN Devtools is not reachable: " + err.Error(),
			"recovery": "Start the RN Devtools app. Agents will get desktop_unavailable until it is running.",
		}
	}
	if !response.OK {
		return map[string]any{"ok": false, "message": response.Error.Message}
	}
	return map[string]any{"ok": true, "result": response.Result}
}

// runHook dispatches `rndevtools hook <event>`, the entry point the installed
// agent hooks call. Decisions are communicated the way each agent expects:
// Claude Code reads exit status 2 as "block" and shows stderr to the model.
func runHook(config Config) int {
	if len(config.Arguments) < 2 || config.Arguments[1] != "claude-pre-tool-use" {
		fmt.Fprint(config.Stdout, "Usage: rndevtools hook claude-pre-tool-use\n\nReads a Claude Code PreToolUse payload on stdin and exits 2 when the Bash command should be redirected to rndevtools.\n")
		if len(config.Arguments) >= 2 && (config.Arguments[1] == "--help" || config.Arguments[1] == "help") {
			return ExitSuccess
		}
		return ExitUsage
	}
	decision := setup.EvaluateClaudePreToolUse(config.Stdin)
	if decision.Block {
		fmt.Fprintln(config.Stderr, decision.Reason)
		return 2
	}
	return ExitSuccess
}
