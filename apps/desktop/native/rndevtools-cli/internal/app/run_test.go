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

func TestRunServesMCPOverStdio(t *testing.T) {
	socketPath := appTestServer(t, func(id string) string {
		return `{"protocol":"rndevtools/1","id":"` + id + `","ok":true,"result":{"healthy":true}}`
	})
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := Run(Config{
		Version:   "test",
		Arguments: []string{"mcp"},
		Stdin: strings.NewReader(
			`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test"}}}` + "\n" +
				`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"doctor","arguments":{}}}` + "\n"),
		Stdout:     &stdout,
		Stderr:     &stderr,
		SocketPath: socketPath,
	})
	if exitCode != ExitSuccess {
		t.Fatalf("exit = %d; stderr=%s", exitCode, stderr.String())
	}
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected two JSON-RPC responses, got %q", stdout.String())
	}
	if !strings.Contains(lines[0], `"serverInfo":{"name":"rndevtools","version":"test"}`) {
		t.Fatalf("initialize response: %s", lines[0])
	}
	if !strings.Contains(lines[1], `"healthy":true`) || !strings.Contains(lines[1], `"isError":false`) {
		t.Fatalf("tool response: %s", lines[1])
	}
	if !strings.Contains(RootUsage(), "  mcp\n") {
		t.Fatal("root usage must list mcp")
	}
	var usage bytes.Buffer
	if Run(Config{Arguments: []string{"mcp", "--help"}, Stdout: &usage, Stderr: &stderr}) != ExitSuccess {
		t.Fatal("mcp --help should succeed")
	}
	if Run(Config{Arguments: []string{"mcp", "--bogus"}, Stdout: &usage, Stderr: &stderr}) != ExitUsage {
		t.Fatal("mcp with flags should be a usage error")
	}
}

func TestRunSetupDryRunAndHook(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	socketPath := appTestServer(t, func(id string) string {
		return `{"protocol":"rndevtools/1","id":"` + id + `","ok":true,"result":{"healthy":true}}`
	})
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := Run(Config{
		Version:    "test",
		Arguments:  []string{"setup", "--dry-run", "--agents", "claude", "--executable", "/opt/rndevtools"},
		Stdin:      strings.NewReader(""),
		Stdout:     &stdout,
		Stderr:     &stderr,
		SocketPath: socketPath,
	})
	if exitCode != ExitSuccess {
		t.Fatalf("exit = %d; stderr=%s", exitCode, stderr.String())
	}
	var report map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("report is not JSON: %s", stdout.String())
	}
	if report["dryRun"] != true || report["executable"] != "/opt/rndevtools" {
		t.Fatalf("report: %v", report)
	}
	if report["doctor"].(map[string]any)["ok"] != true {
		t.Fatalf("doctor should have reached the fixture socket: %v", report["doctor"])
	}
	if entries, _ := os.ReadDir(home); len(entries) != 0 {
		t.Fatalf("dry run wrote into HOME: %v", entries)
	}

	stdout.Reset()
	stderr.Reset()
	exitCode = Run(Config{
		Arguments: []string{"hook", "claude-pre-tool-use"},
		Stdin:     strings.NewReader(`{"tool_name":"Bash","tool_input":{"command":"xcrun simctl boot 727CE7B2-CCBA-47A5-8803-1D61DCEBCF44"}}`),
		Stdout:    &stdout,
		Stderr:    &stderr,
	})
	if exitCode != 2 || !strings.Contains(stderr.String(), "rndevtools") {
		t.Fatalf("hook exit %d stderr %q", exitCode, stderr.String())
	}
	exitCode = Run(Config{
		Arguments: []string{"hook", "claude-pre-tool-use"},
		Stdin:     strings.NewReader(`{"tool_name":"Bash","tool_input":{"command":"xcrun simctl list"}}`),
		Stdout:    &stdout,
		Stderr:    &stderr,
	})
	if exitCode != ExitSuccess {
		t.Fatalf("read-only simctl must pass, exit %d", exitCode)
	}
}
