package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/adalloul0928/rndevtools-sim-helper/internal/protocol"
)

func TestInheritedControlPipeCancelsWithoutOSSignals(t *testing.T) {
	readPipe, writePipe, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	descriptor, err := syscall.Dup(int(readPipe.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(controlFDEnvironment, strconv.Itoa(descriptor))
	_ = readPipe.Close()
	ctx, stop := contextWithInheritedControl(context.Background(), descriptor)
	defer stop()
	if err := writePipe.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("closing the private control pipe did not cancel helper work")
	}
}

func TestInheritedControlDoesNotTouchUnmarkedDescriptors(t *testing.T) {
	t.Setenv(controlFDEnvironment, "")
	readPipe, writePipe, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer readPipe.Close()
	descriptor, err := syscall.Dup(int(readPipe.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(descriptor)
	ctx, stop := contextWithInheritedControl(context.Background(), descriptor)
	defer stop()
	_ = writePipe.Close()
	select {
	case <-ctx.Done():
		t.Fatal("an unmarked descriptor was treated as a helper control channel")
	default:
	}
}

func TestParentWatchCancelsAuthorizedWorkWhenBrokerDies(t *testing.T) {
	var parentPID atomic.Int64
	parentPID.Store(42)
	ctx, stop := contextWithParentWatch(
		context.Background(),
		42,
		func() int { return int(parentPID.Load()) },
		time.Millisecond,
	)
	defer stop()
	parentPID.Store(1)
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("authorized helper work was not cancelled after broker death")
	}
}

func TestParentWatchFailsClosedWhenBrokerAlreadyChanged(t *testing.T) {
	ctx, stop := contextWithParentWatch(
		context.Background(), 42, func() int { return 41 }, time.Millisecond,
	)
	defer stop()
	select {
	case <-ctx.Done():
	default:
		t.Fatal("changed broker parent was not rejected synchronously")
	}
}

type denyingAuthorizer struct{ calls int }

func (authorizer *denyingAuthorizer) Authorize(_ context.Context, _ protocol.Request) *protocol.APIError {
	authorizer.calls++
	return protocol.NewError("mutation_authorization_required", "trusted broker required", false)
}

func TestRunDeniesEveryDirectMutationBeforeSimulatorAccess(t *testing.T) {
	tests := map[string]string{
		"clone_simulator": `{"simulatorId":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","name":"Clone"}`,
		"disk_cleanup":    `{"simulatorId":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","categoryIds":["caches"],"confirmation":"CLEAN_SIMULATOR_DISK"}`,
		"apply_profile":   `{"simulatorId":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","profileId":"rndevtools-development","checkpointToken":"prepared","confirmation":"APPLY_EXPERIMENTAL_PROFILE","acknowledgement":"EXPERIMENTAL"}`,
		"restore_managed": `{"simulatorId":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","checkpointToken":"prepared","confirmation":"RESTORE_ALL_MANAGED_SERVICES","acknowledgement":"EXPERIMENTAL"}`,
		"undo_last":       `{"simulatorId":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","preparedCheckpointToken":"prepared","checkpointToken":"target","confirmation":"UNDO_EXPERIMENTAL_MUTATION","acknowledgement":"EXPERIMENTAL"}`,
	}
	for operation, payload := range tests {
		t.Run(operation, func(t *testing.T) {
			authorizer := &denyingAuthorizer{}
			input := `{"protocolVersion":2,"requestId":"direct","operation":"` + operation + `","payload":` + payload + `}`
			var output bytes.Buffer
			if exitCode := runWithIO([]string{"rndevtools-sim-helper"}, strings.NewReader(input), &output, authorizer); exitCode != 1 {
				t.Fatalf("exit code = %d, want 1", exitCode)
			}
			if authorizer.calls != 1 {
				t.Fatalf("authorizer calls = %d, want 1", authorizer.calls)
			}
			var response protocol.Response
			if err := json.Unmarshal(output.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if response.Error == nil || response.Error.Code != "mutation_authorization_required" {
				t.Fatalf("unexpected response: %#v", response)
			}
		})
	}
}

func TestRunPreservesDirectReadOnlyHandshake(t *testing.T) {
	authorizer := &denyingAuthorizer{}
	input := `{"protocolVersion":2,"requestId":"read","operation":"handshake","payload":{}}`
	var output bytes.Buffer
	if exitCode := runWithIO([]string{"rndevtools-sim-helper"}, strings.NewReader(input), &output, authorizer); exitCode != 0 {
		t.Fatalf("exit code = %d, want 0: %s", exitCode, output.String())
	}
	if authorizer.calls != 0 {
		t.Fatalf("read-only request called authorizer %d times", authorizer.calls)
	}
}
