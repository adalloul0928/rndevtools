package authorization

import (
	"context"
	"slices"
	"strings"
	"testing"
)

func TestLiveCodeVerificationPinsPIDIdentifierTeamAndAppleAnchor(t *testing.T) {
	var executable string
	var arguments []string
	runner := func(_ context.Context, command string, values ...string) ([]byte, error) {
		executable = command
		arguments = append([]string(nil), values...)
		return nil, nil
	}
	if err := verifyLiveCode(context.Background(), 42, expectedBrokerIdentifier, runner); err != nil {
		t.Fatal(err)
	}
	if executable != "/usr/bin/codesign" {
		t.Fatalf("unexpected verifier executable %q", executable)
	}
	expectedPrefix := []string{"--verify", "--strict", "--verbose=2"}
	if !slices.Equal(arguments[:len(expectedPrefix)], expectedPrefix) {
		t.Fatalf("unexpected verifier arguments %#v", arguments)
	}
	requirement := arguments[3]
	for _, required := range []string{
		"-R=anchor apple generic",
		`identifier "pumpd-native-host"`,
		`certificate leaf[subject.OU] = "434X69L4Z5"`,
	} {
		if !strings.Contains(requirement, required) {
			t.Fatalf("requirement %q does not pin %q", requirement, required)
		}
	}
	if arguments[4] != "+42" {
		t.Fatalf("codesign did not target the live process: %#v", arguments)
	}
}

func TestLiveCodeVerificationRejectsUnapprovedIdentityBeforeExecution(t *testing.T) {
	called := false
	runner := func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		called = true
		return nil, nil
	}
	if err := verifyLiveCode(context.Background(), 42, "forged-host", runner); err == nil {
		t.Fatal("forged live-code identity unexpectedly accepted")
	}
	if called {
		t.Fatal("codesign was invoked for an unapproved identity")
	}
}
