package app

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

func TestRunEmitsCompactSuccessAndRejectedResponses(t *testing.T) {
	for name, serverResponse := range map[string]func(string) string{
		"success": func(id string) string {
			return `{"protocol":"rndevtools/1","id":"` + id + `","ok":true,"result":{"healthy":true}}`
		},
		"rejected": func(id string) string {
			return `{"protocol":"rndevtools/1","id":"` + id + `","ok":false,"error":{"code":"approval_required","message":"Approve in the app.","retryable":false,"recovery":"Open RN Devtools."}}`
		},
	} {
		t.Run(name, func(t *testing.T) {
			socketPath := appTestServer(t, serverResponse)
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			exitCode := Run(Config{
				Version:     "test",
				BuildCommit: "fixture",
				Arguments:   []string{"doctor"},
				Stdin:       strings.NewReader(""),
				Stdout:      &stdout,
				Stderr:      &stderr,
				SocketPath:  socketPath,
			})
			wantExit := ExitSuccess
			if name == "rejected" {
				wantExit = ExitRejected
			}
			if exitCode != wantExit {
				t.Fatalf("exit = %d, want %d; stderr=%s", exitCode, wantExit, stderr.String())
			}
			if strings.Count(stdout.String(), "\n") != 1 || !json.Valid(bytes.TrimSpace(stdout.Bytes())) {
				t.Fatalf("stdout is not one compact JSON line: %q", stdout.String())
			}
		})
	}
}

func TestRunUsesStableExitCodesForLocalFailures(t *testing.T) {
	for name, fixture := range map[string]struct {
		arguments  []string
		socketPath string
		wantExit   int
		wantCode   string
	}{
		"invalid": {
			arguments: []string{"slimming", "--operation", "apply"},
			wantExit:  ExitUsage,
			wantCode:  "invalid_arguments",
		},
		"unavailable": {
			arguments:  []string{"doctor"},
			socketPath: filepath.Join(t.TempDir(), "missing.sock"),
			wantExit:   ExitUnavailable,
			wantCode:   "desktop_unavailable",
		},
	} {
		t.Run(name, func(t *testing.T) {
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			exitCode := Run(Config{
				Arguments:  fixture.arguments,
				Stdin:      strings.NewReader(""),
				Stdout:     &stdout,
				Stderr:     &stderr,
				SocketPath: fixture.socketPath,
			})
			if exitCode != fixture.wantExit || !strings.Contains(stderr.String(), `"code":"`+fixture.wantCode+`"`) {
				t.Fatalf("exit=%d stdout=%q stderr=%q", exitCode, stdout.String(), stderr.String())
			}
		})
	}
}

func TestRunClassifiesOversizedEnvelopeAsInvalidArguments(t *testing.T) {
	payload := strings.Repeat("x", protocol.MaxRequestBytes-150)
	stdin := `{"target":{"deviceId":"device-1"},"action":{"tool":"routes","command":"navigate","payload":{"path":"` + payload + `"}}}`
	if len(stdin) > protocol.MaxRequestBytes {
		t.Fatalf("test stdin unexpectedly exceeds the input limit: %d", len(stdin))
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := Run(Config{
		Arguments:      []string{"act"},
		Stdin:          strings.NewReader(stdin),
		StdinAvailable: true,
		Stdout:         &stdout,
		Stderr:         &stderr,
	})
	if exitCode != ExitUsage || !strings.Contains(stderr.String(), "complete request fits within 256 KiB") {
		t.Fatalf("exit=%d stdout=%q stderr=%q", exitCode, stdout.String(), stderr.String())
	}
}

func appTestServer(t *testing.T, response func(string) string) string {
	t.Helper()
	directory, err := os.MkdirTemp("", "pd-app-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	socketPath := filepath.Join(directory, "rndevtools.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		line, err := bufio.NewReader(connection).ReadString('\n')
		if err != nil {
			return
		}
		var request protocol.Request
		if json.Unmarshal([]byte(strings.TrimSuffix(line, "\n")), &request) != nil {
			return
		}
		_, _ = connection.Write([]byte(response(request.ID) + "\n"))
	}()
	return socketPath
}
