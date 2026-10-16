package setup

import (
	"strings"
	"testing"
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
	if payload.SessionID != "thr_123" || payload.Reason != "other" {
		t.Fatalf("payload %+v", payload)
	}
	if ReadSessionEnd(strings.NewReader("garbage")).SessionID != "" {
		t.Fatal("unparseable input must yield an empty session id")
	}
}
