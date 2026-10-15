package command

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

const testUDID = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"

func TestValidateMatchesServerCommandUnion(t *testing.T) {
	tests := map[protocol.Command]string{
		protocol.CommandDoctor:     `{"kind":"doctor"}`,
		protocol.CommandSimulators: `{"kind":"simulators","includeUnavailable":true}`,
		protocol.CommandApps:       `{"kind":"apps","udid":"` + testUDID + `"}`,
		protocol.CommandScreen:     `{"kind":"screen","target":{"deviceId":"device-1"}}`,
		protocol.CommandElements:   `{"kind":"elements","target":{"udid":"` + testUDID + `"},"query":"button","limit":10}`,
		protocol.CommandAct:        `{"kind":"act","target":{"deviceId":"device-1"},"action":{"tool":"routes","command":"navigate","payload":{"path":null}}}`,
		protocol.CommandWait:       `{"kind":"wait","condition":{"kind":"network-idle","quietMs":500},"timeoutMs":30000}`,
		protocol.CommandCapture:    `{"kind":"capture","udid":"` + testUDID + `","format":"png"}`,
		protocol.CommandRecord:     `{"kind":"record","udid":"` + testUDID + `","operation":"start","codec":"h264"}`,
		protocol.CommandNetwork:    `{"kind":"network","target":{"deviceId":"device-1"},"operation":"set","profileId":"slow-3g"}`,
		protocol.CommandRecipe:     `{"kind":"recipe","operation":"run","recipeId":"smoke","udids":["` + testUDID + `"]}`,
		protocol.CommandJobs:       `{"kind":"jobs","operation":"cancel","jobId":"job-1"}`,
		protocol.CommandSlimming:   `{"kind":"slimming","operation":"verify","udids":["` + testUDID + `"],"profileId":"rndevtools-development"}`,
		protocol.CommandLane:       `{"kind":"lane","operation":"up","worktreePath":"/Users/dev/app","udid":"` + testUDID + `","environment":"development","launch":true,"slimProfileId":"rndevtools-development","agent":{"kind":"claude","sessionId":"session-1"}}`,
		protocol.CommandNative:     `{"kind":"native","operation":"install","worktreePath":"/Users/dev/app","udid":"` + testUDID + `","configuration":"Release"}`,
		protocol.CommandAgents:     `{"kind":"agents"}`,
		protocol.CommandClaim:      `{"kind":"claim","udid":"` + testUDID + `","note":"checkout flow"}`,
		protocol.CommandRelease:    `{"kind":"release","udid":"` + testUDID + `"}`,
		protocol.CommandInput:      `{"kind":"input","input":{"kind":"swipe","udid":"` + testUDID + `","fromX":0.5,"fromY":0.9,"toX":0.5,"toY":0.2,"durationMilliseconds":300,"steps":20}}`,
	}
	for kind, encoded := range tests {
		t.Run(string(kind), func(t *testing.T) {
			if err := Validate(json.RawMessage(encoded), kind); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestValidateRejectsMutationUnknownFieldsAndNullOptionals(t *testing.T) {
	tests := []struct {
		kind    protocol.Command
		encoded string
	}{
		{protocol.CommandSlimming, `{"kind":"slimming","operation":"apply","udids":["` + testUDID + `"]}`},
		{protocol.CommandDoctor, `{"kind":"doctor","shell":"whoami"}`},
		{protocol.CommandCapture, `{"kind":"capture","udid":"` + testUDID + `","format":null}`},
		{protocol.CommandNetwork, `{"kind":"network","target":{"deviceId":"device-1"},"operation":"status","profileId":"unexpected"}`},
		{protocol.CommandSlimming, `{"kind":"slimming","operation":"status","udids":["` + testUDID + `"]}`},
		{protocol.CommandSlimming, `{"kind":"slimming","operation":"doctor","udids":["` + testUDID + `"],"profileId":"ignored-profile"}`},
		{protocol.CommandSlimming, `{"kind":"slimming","operation":"preview","udids":["` + testUDID + `"]}`},
		{protocol.CommandScreen, `{"kind":"screen","target":{"udid":"` + testUDID + `","deviceId":"device-1"}}`},
		{protocol.CommandAct, `{"kind":"act","target":{"deviceId":"device-1"},"action":{"tool":"storage","command":"set","payload":{}}}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"up","udid":"` + testUDID + `"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"up","worktreePath":"relative","udid":"` + testUDID + `"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"ls","laneId":"lane-11111111-2222-4333-8444-555555555555"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"launch","laneId":"lane-11111111-2222-4333-8444-555555555555","worktreePath":"/Users/dev/app"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"down"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"log","laneId":"lane-11111111-2222-4333-8444-555555555555","url":"x"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"up","worktreePath":"/Users/dev/app","udid":"` + testUDID + `","agent":{"kind":"gpt","sessionId":"s"}}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"up","worktreePath":"/Users/dev/app","udid":"` + testUDID + `","shell":"whoami"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"up","worktreePath":"/Users/dev/app","udid":"` + testUDID + `","slimProfileId":"../escape"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"launch","laneId":"lane-11111111-2222-4333-8444-555555555555","slimProfileId":"rndevtools-development"}`},
		{protocol.CommandNative, `{"kind":"native","operation":"install","worktreePath":"/Users/dev/app"}`},
		{protocol.CommandNative, `{"kind":"native","operation":"plan","worktreePath":"relative"}`},
		{protocol.CommandNative, `{"kind":"native","operation":"build","worktreePath":"/Users/dev/app"}`},
		{protocol.CommandNative, `{"kind":"native","operation":"plan","worktreePath":"/Users/dev/app","configuration":"debug"}`},
		{protocol.CommandClaim, `{"kind":"claim"}`},
		{protocol.CommandRelease, `{"kind":"release","udid":"` + testUDID + `","note":"x"}`},
		{protocol.CommandAgents, `{"kind":"agents","udid":"` + testUDID + `"}`},
		{protocol.CommandInput, `{"kind":"input","input":{"kind":"tap","udid":"` + testUDID + `","x":1.5,"y":0.5}}`},
		{protocol.CommandInput, `{"kind":"input","input":{"kind":"tap","udid":"booted","x":0.5,"y":0.5}}`},
		{protocol.CommandInput, `{"kind":"input","input":{"kind":"tap","udid":"` + testUDID + `","x":0.5,"y":0.5,"button":"home"}}`},
		{protocol.CommandInput, `{"kind":"input","input":{"kind":"text","udid":"` + testUDID + `","text":"héllo"}}`},
		{protocol.CommandInput, `{"kind":"input","input":{"kind":"key","udid":"` + testUDID + `","usage":3}}`},
		{protocol.CommandInput, `{"kind":"input","input":{"kind":"button","udid":"` + testUDID + `","button":"power"}}`},
		{protocol.CommandInput, `{"kind":"input"}`},
	}
	for _, test := range tests {
		if err := Validate(json.RawMessage(test.encoded), test.kind); err == nil {
			t.Fatalf("expected rejection: %s", test.encoded)
		}
	}
}

func TestValidateAllowsOnlyAppScopedNetworkProfileActions(t *testing.T) {
	for _, action := range []string{
		`{"kind":"act","target":{"deviceId":"device-1"},"action":{"tool":"network","command":"setProfile","payload":{"profileId":"lte"}}}`,
		`{"kind":"act","target":{"deviceId":"device-1"},"action":{"tool":"network","command":"clearProfile","payload":{}}}`,
	} {
		if err := Validate(json.RawMessage(action), protocol.CommandAct); err != nil {
			t.Fatalf("safe app-scoped network action was rejected: %v", err)
		}
	}
	if err := Validate(
		json.RawMessage(`{"kind":"act","target":{"deviceId":"device-1"},"action":{"tool":"network","command":"clear","payload":{}}}`),
		protocol.CommandAct,
	); err == nil {
		t.Fatal("captured-network-log clearing must not be available through unattended act")
	}
}

func TestParseMergesDistinctFlagsAndStdin(t *testing.T) {
	parsed, err := Parse(
		protocol.CommandSlimming,
		[]string{"--operation", "preview", "--udids", testUDID, "--request-timeout-ms", "45000"},
		strings.NewReader(`{"profileId":"rndevtools-development"}`),
		true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Timeout.Milliseconds() != 45_000 {
		t.Fatalf("timeout = %s", parsed.Timeout)
	}
	var command map[string]any
	if err := json.Unmarshal(parsed.Command, &command); err != nil {
		t.Fatal(err)
	}
	if command["kind"] != "slimming" || command["operation"] != "preview" || command["profileId"] != "rndevtools-development" {
		t.Fatalf("unexpected command: %#v", command)
	}
}

func TestParseDerivesWaitSocketDeadlineBeyondServerGrace(t *testing.T) {
	parsed, err := Parse(
		protocol.CommandWait,
		[]string{"--timeout-ms", "600000", "--condition", "network-idle", "--quiet-ms", "500"},
		strings.NewReader(""),
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Timeout != 610*time.Second {
		t.Fatalf("timeout = %s, want 610s", parsed.Timeout)
	}
}

func TestParseRejectsAmbiguityAndOversizedInput(t *testing.T) {
	if _, err := Parse(
		protocol.CommandJobs,
		[]string{"--operation", "list"},
		strings.NewReader(`{"operation":"get","jobId":"job-1"}`),
		true,
	); err == nil {
		t.Fatal("expected duplicate field rejection")
	}
	if _, err := Parse(
		protocol.CommandDoctor,
		nil,
		strings.NewReader(strings.Repeat("x", protocol.MaxRequestBytes+1)),
		true,
	); err == nil {
		t.Fatal("expected oversized stdin rejection")
	}
}

func TestParseStructuredNestedActionFlags(t *testing.T) {
	parsed, err := Parse(
		protocol.CommandAct,
		[]string{
			"--device-id", "device-1",
			"--tool", "routes",
			"--action-command", "navigate",
			"--action-payload", `{"path":"/settings"}`,
		},
		strings.NewReader(""),
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(parsed.Command), `"command":"navigate"`) {
		t.Fatalf("unexpected command: %s", parsed.Command)
	}
}

func TestLaneFlagsBuildOperationSpecificCommands(t *testing.T) {
	parsed, err := Parse(protocol.CommandLane, []string{
		"--operation", "launch",
		"--lane-id", "lane-11111111-2222-4333-8444-555555555555",
		"--url", "checkout",
	}, strings.NewReader(""), false)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(parsed.Command, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["operation"] != "launch" || decoded["url"] != "checkout" {
		t.Fatalf("unexpected command: %s", parsed.Command)
	}
	if parsed.Timeout < 240*time.Second {
		t.Fatalf("lane commands need a long socket deadline, got %s", parsed.Timeout)
	}
}

func TestLaneAttributionComesFromAgentEnvironment(t *testing.T) {
	env := map[string]string{"CLAUDE_CODE_SESSION_ID": "session-abc"}
	lookup := func(key string) string { return env[key] }
	parsed, err := ParseWithEnvironment(protocol.CommandLane, []string{
		"--operation", "up",
		"--worktree", "/Users/dev/app",
		"--udid", testUDID,
	}, strings.NewReader(""), false, lookup)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Agent map[string]string `json:"agent"`
	}
	if err := json.Unmarshal(parsed.Command, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Agent["kind"] != "claude" || decoded.Agent["sessionId"] != "session-abc" {
		t.Fatalf("expected claude attribution, got %s", parsed.Command)
	}

	// Explicit stdin attribution wins over the environment.
	parsed, err = ParseWithEnvironment(protocol.CommandLane, []string{
		"--operation", "up", "--worktree", "/Users/dev/app", "--udid", testUDID,
	}, strings.NewReader(`{"agent":{"kind":"codex","sessionId":"thread-9"}}`), true, lookup)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(parsed.Command, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Agent["kind"] != "codex" {
		t.Fatalf("stdin attribution should win, got %s", parsed.Command)
	}

	// Operations that do not accept attribution never receive it.
	parsed, err = ParseWithEnvironment(protocol.CommandLane, []string{"--operation", "ls"},
		strings.NewReader(""), false, lookup)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(parsed.Command), "agent") {
		t.Fatalf("ls must not carry attribution: %s", parsed.Command)
	}

	// Malformed identifiers are dropped rather than forwarded.
	bad := func(string) string { return "has spaces" }
	parsed, err = ParseWithEnvironment(protocol.CommandLane, []string{
		"--operation", "up", "--worktree", "/Users/dev/app", "--udid", testUDID,
	}, strings.NewReader(""), false, bad)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(parsed.Command), "agent") {
		t.Fatalf("invalid session ids must be ignored: %s", parsed.Command)
	}
}
