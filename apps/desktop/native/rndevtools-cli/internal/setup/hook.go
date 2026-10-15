package setup

import (
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// HookDecision is what a PreToolUse hook tells Claude Code.
type HookDecision struct {
	// Block is true when the tool call must not run. Claude Code maps this to
	// exit status 2 and shows Reason to the model.
	Block  bool
	Reason string
}

// steeredVerbs are the simctl subcommands that mutate a Simulator or launch
// into it, and the rndevtools operation that replaces each. Observing verbs
// (list, getenv, get_app_container, diagnose, help) stay allowed: an agent
// orienting itself is not the problem; two agents booting the same device is.
var steeredVerbs = map[string]string{
	"boot":       "`lane` (operation up) boots the Simulator the lane needs, or ask the user which device to use",
	"shutdown":   "`lane` (operation down) stops a lane; leave other agents' Simulators running",
	"erase":      "RN Devtools owns device state; ask the user before erasing a Simulator",
	"delete":     "RN Devtools owns device state; ask the user before deleting a Simulator",
	"openurl":    "`lane` (operation launch, url) opens deep links through the lane's scheme",
	"install":    "`native` (operation install) installs the cached dev client; `native` plan tells you whether a build is needed",
	"uninstall":  "ask the user before removing apps from a managed Simulator",
	"launch":     "`lane` (operation launch) opens the dev client against the lane's Metro",
	"terminate":  "`lane` (operation down) stops the lane; use `input` button home to leave an app",
	"io":         "`capture` takes screenshots and `record` records video through RN Devtools",
	"privacy":    "RN Devtools' permissions panel grants and resets privacy permissions",
	"push":       "ask the user; push payloads are not part of the agent surface",
	"keychain":   "ask the user before touching a Simulator keychain",
	"status_bar": "ask the user before overriding the status bar on a shared device",
	"spawn":      "RN Devtools does not expose arbitrary processes on a Simulator",
	"addmedia":   "ask the user before adding media to a shared Simulator",
	"clone":      "RN Devtools' slimming and lanes manage device copies; ask the user",
}

var (
	simctlPattern = regexp.MustCompile(`(?:^|[\s;&|(])(?:xcrun\s+)?simctl\s+([a-z_]+)`)
	metroPattern  = regexp.MustCompile(`(?:^|[\s;&|(])(?:npx\s+|yarn\s+|pnpm\s+(?:exec\s+)?|bunx?\s+)?(?:expo\s+start|react-native\s+start)\b`)
)

// EvaluateClaudePreToolUse reads Claude Code's PreToolUse JSON and decides
// whether the Bash command should run. Any input that is not a Bash call, or
// that cannot be parsed, is allowed: a hook that fails must fail open, since
// exit status 2 on a parse error would lock the model out of Bash entirely.
func EvaluateClaudePreToolUse(input io.Reader) HookDecision {
	var payload struct {
		ToolName  string `json:"tool_name"`
		ToolInput struct {
			Command string `json:"command"`
		} `json:"tool_input"`
	}
	if err := json.NewDecoder(io.LimitReader(input, 1<<20)).Decode(&payload); err != nil {
		return HookDecision{}
	}
	if payload.ToolName != "Bash" {
		return HookDecision{}
	}
	return EvaluateShellCommand(payload.ToolInput.Command)
}

// EvaluateShellCommand applies the steering rules to one shell command line.
func EvaluateShellCommand(command string) HookDecision {
	for _, match := range simctlPattern.FindAllStringSubmatch(command, -1) {
		verb := match[1]
		if replacement, steered := steeredVerbs[verb]; steered {
			return HookDecision{
				Block: true,
				Reason: fmt.Sprintf(
					"Blocked `simctl %s`: Simulators on this Mac are managed by RN Devtools and shared with other agents. Use the rndevtools MCP tools or CLI instead: %s. `simctl list` and other read-only verbs are still allowed.",
					verb, replacement),
			}
		}
	}
	if metroPattern.MatchString(command) && !strings.Contains(command, "rndevtools") {
		return HookDecision{
			Block:  true,
			Reason: "Blocked starting Metro by hand: port 8081 is shared with other agents. Use the rndevtools `lane` tool (operation up, with this worktree's absolute path) and RN Devtools will start Metro on a leased port and open the dev client against it.",
		}
	}
	return HookDecision{}
}
