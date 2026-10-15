package mcp

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/client"
	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

const udid = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"

type recorded struct {
	request protocol.Request
	timeout time.Duration
}

func newTestServer(t *testing.T, respond func(protocol.Request) (protocol.Response, error), files map[string][]byte, env map[string]string) (*Server, *[]recorded) {
	t.Helper()
	var calls []recorded
	server := New(Config{
		Version: "test",
		Transport: func(_ context.Context, request protocol.Request, timeout time.Duration) (protocol.Response, error) {
			calls = append(calls, recorded{request: request, timeout: timeout})
			return respond(request)
		},
		Lookup: func(name string) string { return env[name] },
		ReadFile: func(path string) ([]byte, error) {
			if data, ok := files[path]; ok {
				return data, nil
			}
			return nil, errors.New("missing")
		},
	})
	return server, &calls
}

func exchange(t *testing.T, server *Server, messages ...string) []map[string]any {
	t.Helper()
	var output bytes.Buffer
	if err := server.Serve(context.Background(), strings.NewReader(strings.Join(messages, "\n")+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	var responses []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
		if line == "" {
			continue
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(line), &decoded); err != nil {
			t.Fatalf("invalid response line %q: %v", line, err)
		}
		responses = append(responses, decoded)
	}
	return responses
}

func okResponse(request protocol.Request, result string) (protocol.Response, error) {
	return protocol.Response{Protocol: protocol.Name, ID: request.ID, OK: true, Result: json.RawMessage(result)}, nil
}

func TestInitializeAndListTools(t *testing.T) {
	server, _ := newTestServer(t, func(r protocol.Request) (protocol.Response, error) { return okResponse(r, `{}`) }, nil, nil)
	responses := exchange(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"claude-code","version":"1"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"ping"}`,
	)
	if len(responses) != 3 {
		t.Fatalf("expected 3 responses (notification is silent), got %d", len(responses))
	}
	init := responses[0]["result"].(map[string]any)
	if init["protocolVersion"] != ProtocolVersion {
		t.Fatalf("protocol version %v", init["protocolVersion"])
	}
	if !strings.Contains(init["instructions"].(string), "xcrun simctl") {
		t.Fatal("instructions must warn against raw simctl")
	}
	tools := responses[1]["result"].(map[string]any)["tools"].([]any)
	if len(tools) != len(protocol.Commands()) {
		t.Fatalf("%d tools for %d commands", len(tools), len(protocol.Commands()))
	}
	first := tools[0].(map[string]any)
	if first["name"] != "lane" {
		t.Fatalf("lane must be listed first, got %v", first["name"])
	}
	schema := first["inputSchema"].(map[string]any)
	if schema["additionalProperties"] != false {
		t.Fatal("schemas must close additional properties")
	}
	properties := schema["properties"].(map[string]any)
	if properties["preferred-port"].(map[string]any)["type"] != "integer" {
		t.Fatalf("preferred-port type: %v", properties["preferred-port"])
	}
	for _, raw := range tools {
		tool := raw.(map[string]any)
		if tool["description"] == "" || tool["title"] == "" {
			t.Fatalf("tool %v lacks description or title", tool["name"])
		}
		if _, ok := tool["annotations"].(map[string]any)["readOnlyHint"]; !ok {
			t.Fatalf("tool %v lacks annotations", tool["name"])
		}
	}
}

func TestToolCallBuildsValidatesAndAttributes(t *testing.T) {
	server, calls := newTestServer(t, func(r protocol.Request) (protocol.Response, error) {
		return okResponse(r, `{"udid":"`+udid+`","kind":"tap","messages":2,"elapsedMilliseconds":9,"transport":"indigo"}`)
	}, nil, map[string]string{"CLAUDE_CODE_SESSION_ID": "sess-1"})
	responses := exchange(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"input","arguments":{"udid":"`+udid+`","kind":"tap","x":0.39,"y":0.92}}}`,
	)
	result := responses[0]["result"].(map[string]any)
	if result["isError"] != false {
		t.Fatalf("unexpected error: %v", result)
	}
	if len(*calls) != 1 {
		t.Fatalf("%d socket calls", len(*calls))
	}
	request := (*calls)[0].request
	if request.Agent["kind"] != "claude" || request.Agent["sessionId"] != "sess-1" {
		t.Fatalf("agent not attributed from the environment: %v", request.Agent)
	}
	if !strings.HasPrefix(request.ID, "mcp-") {
		t.Fatalf("request id %q", request.ID)
	}
	var sent map[string]any
	_ = json.Unmarshal(request.Command, &sent)
	input := sent["input"].(map[string]any)
	if input["x"] != 0.39 || input["kind"] != "tap" || sent["kind"] != "input" {
		t.Fatalf("command shape: %s", request.Command)
	}
	structured := result["structuredContent"].(map[string]any)
	if structured["transport"] != "indigo" {
		t.Fatalf("structured content missing: %v", structured)
	}
}

func TestToolCallFallsBackToClientNameForAttribution(t *testing.T) {
	server, calls := newTestServer(t, func(r protocol.Request) (protocol.Response, error) { return okResponse(r, `{"simulators":[]}`) }, nil, nil)
	exchange(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"Codex CLI","version":"1"}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"simulators","arguments":{}}}`,
	)
	agent := (*calls)[0].request.Agent
	if agent["kind"] != "codex" || agent["sessionId"] != "mcp-Codex-CLI" {
		t.Fatalf("fallback attribution: %v", agent)
	}
}

func TestInvalidArgumentsAreToolErrorsNotProtocolErrors(t *testing.T) {
	server, calls := newTestServer(t, func(r protocol.Request) (protocol.Response, error) { return okResponse(r, `{}`) }, nil, nil)
	responses := exchange(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"input","arguments":{"udid":"`+udid+`","kind":"tap","x":2,"y":0.5}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"teleport","arguments":{}}}`,
	)
	if len(*calls) != 0 {
		t.Fatal("invalid calls must not reach the socket")
	}
	bad := responses[0]["result"].(map[string]any)
	if bad["isError"] != true {
		t.Fatalf("expected isError for out-of-range tap: %v", bad)
	}
	text := bad["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "invalid_arguments") || !strings.Contains(text, "input schema") {
		t.Fatalf("tool error text: %q", text)
	}
	if responses[1]["error"].(map[string]any)["code"].(float64) != codeInvalidParams {
		t.Fatalf("unknown tool should be a protocol error: %v", responses[1])
	}
}

func TestRemoteAndTransportErrorsCarryRecovery(t *testing.T) {
	server, _ := newTestServer(t, func(r protocol.Request) (protocol.Response, error) {
		return protocol.Response{Protocol: protocol.Name, ID: r.ID, OK: false, Error: &protocol.RemoteError{Code: "target_not_found", Message: "no such device", Retryable: true, Recovery: "Run simulators."}}, nil
	}, nil, nil)
	responses := exchange(t, server, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capture","arguments":{"udid":"`+udid+`"}}}`)
	result := responses[0]["result"].(map[string]any)
	text := result["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "target_not_found") || !strings.Contains(text, "Recovery: Run simulators.") {
		t.Fatalf("remote error text: %q", text)
	}

	down, _ := newTestServer(t, func(protocol.Request) (protocol.Response, error) {
		return protocol.Response{}, &client.ClientError{Kind: client.ErrorUnavailable, Cause: errors.New("connect: no such file")}
	}, nil, nil)
	responses = exchange(t, down, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"simulators","arguments":{}}}`)
	text = responses[0]["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "desktop_unavailable") || !strings.Contains(text, "start the RN Devtools app") {
		t.Fatalf("unavailable text: %q", text)
	}
}

func TestCaptureEmbedsTheImage(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', 1, 2, 3}
	server, _ := newTestServer(t, func(r protocol.Request) (protocol.Response, error) {
		return okResponse(r, `{"job":{"id":"j"},"capture":{"id":"c","mimeType":"image/png","bytes":7},"path":"/captures/c.png"}`)
	}, map[string][]byte{"/captures/c.png": png}, nil)
	responses := exchange(t, server, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capture","arguments":{"udid":"`+udid+`"}}}`)
	content := responses[0]["result"].(map[string]any)["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("expected text + image, got %d blocks", len(content))
	}
	image := content[1].(map[string]any)
	if image["type"] != "image" || image["mimeType"] != "image/png" {
		t.Fatalf("image block: %v", image)
	}
	decoded, _ := base64.StdEncoding.DecodeString(image["data"].(string))
	if !bytes.Equal(decoded, png) {
		t.Fatal("image bytes differ")
	}
}

func TestResources(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G'}
	server, calls := newTestServer(t, func(r protocol.Request) (protocol.Response, error) {
		if strings.Contains(string(r.Command), `"capture"`) {
			return okResponse(r, `{"capture":{"id":"c","mimeType":"image/png"},"path":"/captures/c.png"}`)
		}
		return okResponse(r, `{"lanes":[]}`)
	}, map[string][]byte{"/captures/c.png": png}, nil)
	responses := exchange(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"resources/list"}`,
		`{"jsonrpc":"2.0","id":2,"method":"resources/templates/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"rndevtools://lanes"}}`,
		`{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"rndevtools://screen/`+strings.ToLower(udid)+`"}}`,
		`{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"rndevtools://screen/booted"}}`,
	)
	if len(responses[0]["result"].(map[string]any)["resources"].([]any)) != 3 {
		t.Fatal("expected three static resources")
	}
	if len(responses[1]["result"].(map[string]any)["resourceTemplates"].([]any)) != 1 {
		t.Fatal("expected the screen template")
	}
	lanes := responses[2]["result"].(map[string]any)["contents"].([]any)[0].(map[string]any)
	if lanes["text"] != `{"lanes":[]}` {
		t.Fatalf("lanes resource: %v", lanes)
	}
	if !strings.Contains(string((*calls)[0].request.Command), `"operation":"ls"`) {
		t.Fatalf("lanes resource must run lane ls: %s", (*calls)[0].request.Command)
	}
	screen := responses[3]["result"].(map[string]any)["contents"].([]any)[0].(map[string]any)
	if screen["mimeType"] != "image/png" || screen["blob"] != base64.StdEncoding.EncodeToString(png) {
		// The fixture capture reports PNG, so the resource echoes that mime type.
		t.Fatalf("screen resource: %v", screen)
	}
	if !strings.Contains(string((*calls)[1].request.Command), strings.ToUpper(udid)) {
		t.Fatal("screen resource must canonicalise the UDID")
	}
	if !strings.Contains(string((*calls)[1].request.Command), `"format":"jpeg"`) {
		t.Fatal("screen resource must request JPEG to keep the frame small")
	}
	if responses[4]["error"] == nil {
		t.Fatal("non-UDID screen resource must be rejected")
	}
}

func TestMalformedInputIsAnsweredNotFatal(t *testing.T) {
	server, _ := newTestServer(t, func(r protocol.Request) (protocol.Response, error) { return okResponse(r, `{}`) }, nil, nil)
	responses := exchange(t, server, `not json`, `{"jsonrpc":"1.0","id":1,"method":"ping"}`, `{"jsonrpc":"2.0","id":2,"method":"wat"}`)
	if responses[0]["error"].(map[string]any)["code"].(float64) != codeParse {
		t.Fatalf("parse error code: %v", responses[0])
	}
	if responses[1]["error"].(map[string]any)["code"].(float64) != codeInvalidRequest {
		t.Fatalf("invalid request code: %v", responses[1])
	}
	if responses[2]["error"].(map[string]any)["code"].(float64) != codeMethodNotFound {
		t.Fatalf("method not found code: %v", responses[2])
	}
}
