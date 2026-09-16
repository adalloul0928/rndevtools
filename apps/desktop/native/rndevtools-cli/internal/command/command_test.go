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
