// Package mcp serves the rndevtools commands to coding agents as a Model
// Context Protocol server over stdio. Every tool call is assembled, validated,
// and sent through exactly the path the CLI uses, so the desktop sees one kind
// of peer; this package adds only the JSON-RPC framing, the tool and resource
// catalog, and image embedding for screenshots.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/client"
	"github.com/adalloul0928/rndevtools-cli/internal/command"
	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

const (
	// ProtocolVersion is the MCP revision this server speaks.
	ProtocolVersion = "2025-06-18"
	serverName      = "rndevtools"
	// maxLineBytes bounds one incoming JSON-RPC message. Tool arguments are
	// small; anything larger is not a legitimate client.
	maxLineBytes = 1 << 20
	// maxImageBytes bounds a screenshot embedded in a response. Larger
	// captures are returned by path only.
	maxImageBytes = 8 << 20
)

// Transport sends one rndevtools request and returns the response. The
// production transport is the socket client; tests substitute a recorder.
type Transport func(ctx context.Context, request protocol.Request, timeout time.Duration) (protocol.Response, error)

// Config wires the server to its process environment.
type Config struct {
	Version   string
	Transport Transport
	// Lookup reads environment variables (os.Getenv). Agent attribution comes
	// from it: Claude Code and Codex pass their session identifiers to the
	// MCP servers they spawn.
	Lookup func(string) string
	// ReadFile loads a capture for embedding; defaults to os.ReadFile.
	ReadFile func(string) ([]byte, error)
	Logger   io.Writer
}

// Server is one stdio MCP session.
type Server struct {
	config      Config
	clientName  string
	initialized bool
	writeLock   sync.Mutex
}

// New builds a server with defaults filled in.
func New(config Config) *Server {
	if config.Lookup == nil {
		config.Lookup = os.Getenv
	}
	if config.ReadFile == nil {
		config.ReadFile = os.ReadFile
	}
	if config.Logger == nil {
		config.Logger = io.Discard
	}
	return &Server{config: config}
}

// SocketTransport sends requests over the desktop's private socket.
func SocketTransport(socketPath string) Transport {
	return func(ctx context.Context, request protocol.Request, timeout time.Duration) (protocol.Response, error) {
		localClient, err := client.New(socketPath, timeout)
		if err != nil {
			return protocol.Response{}, err
		}
		return localClient.Do(ctx, request)
	}
}

// Serve reads newline-delimited JSON-RPC messages from `reader` until EOF and
// writes responses to `writer`. Requests are handled sequentially: the desktop
// serializes Simulator work anyway, and ordering keeps a swipe's steps and a
// subsequent screenshot in the order the agent issued them.
func (server *Server) Serve(ctx context.Context, reader io.Reader, writer io.Writer) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), maxLineBytes)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		if response := server.handle(ctx, line); response != nil {
			if err := server.write(writer, response); err != nil {
				return err
			}
		}
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

type rpcRequest struct {
	Version string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	Version string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

const (
	codeParse          = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternal       = -32603
)

func (server *Server) handle(ctx context.Context, line []byte) *rpcResponse {
	var request rpcRequest
	if err := json.Unmarshal(line, &request); err != nil {
		return &rpcResponse{Version: "2.0", ID: json.RawMessage("null"), Error: &rpcError{Code: codeParse, Message: "invalid JSON"}}
	}
	if request.Version != "2.0" || request.Method == "" {
		return &rpcResponse{Version: "2.0", ID: idOrNull(request.ID), Error: &rpcError{Code: codeInvalidRequest, Message: "expected a JSON-RPC 2.0 request"}}
	}
	isNotification := len(request.ID) == 0 || string(request.ID) == "null"
	result, rpcErr := server.dispatch(ctx, request)
	if isNotification {
		return nil
	}
	response := &rpcResponse{Version: "2.0", ID: request.ID}
	if rpcErr != nil {
		response.Error = rpcErr
	} else {
		response.Result = result
	}
	return response
}

func idOrNull(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}

func (server *Server) dispatch(ctx context.Context, request rpcRequest) (any, *rpcError) {
	switch request.Method {
	case "initialize":
		return server.initialize(request.Params)
	case "notifications/initialized":
		server.initialized = true
		return nil, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": Tools()}, nil
	case "tools/call":
		return server.callTool(ctx, request.Params)
	case "resources/list":
		return map[string]any{"resources": staticResources()}, nil
	case "resources/templates/list":
		return map[string]any{"resourceTemplates": resourceTemplates()}, nil
	case "resources/read":
		return server.readResource(ctx, request.Params)
	case "prompts/list":
		return map[string]any{"prompts": []any{}}, nil
	default:
		if strings.HasPrefix(request.Method, "notifications/") {
			return nil, nil
		}
		return nil, &rpcError{Code: codeMethodNotFound, Message: fmt.Sprintf("method %q is not supported", request.Method)}
	}
}

func (server *Server) initialize(params json.RawMessage) (any, *rpcError) {
	var request struct {
		ClientInfo struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"clientInfo"`
	}
	_ = json.Unmarshal(params, &request)
	server.clientName = request.ClientInfo.Name
	return map[string]any{
		"protocolVersion": ProtocolVersion,
		"capabilities": map[string]any{
			"tools":     map[string]any{"listChanged": false},
			"resources": map[string]any{"subscribe": false, "listChanged": false},
		},
		"serverInfo":   map[string]any{"name": serverName, "version": server.config.Version},
		"instructions": instructions,
	}, nil
}

// instructions is what the client shows its model about this server as a
// whole. It carries the rules a tool description cannot: when to reach for
// these tools at all, and what never to do instead.
const instructions = `RN Devtools controls the iOS Simulators on this Mac. Use these tools for anything ` +
	`involving a Simulator: booting one for a git worktree or branch, starting Metro without ` +
	`colliding with another agent, launching the dev client, reading or driving the running app, ` +
	`tapping or typing on the device, taking screenshots, and cleaning up. Do not run xcrun simctl ` +
	`boot, shutdown, openurl, install, launch, or io directly, and do not start Metro by hand: ` +
	`several agents share these Simulators and the desktop app owns their ports and claims. ` +
	`A Simulator is free or held: held while a lane runs on it or a session claimed it, and only ` +
	`the holder may boot, drive, slim, or stop it (anything else fails with device_held, naming ` +
	`the holder). Start with lane (operation "up") for a worktree; leave udid out and the desktop picks a ` +
	`free device, or parks a deviceRequest for the user when none is free (then poll lane ls). ` +
	`When your task is done, call release with all=true so your devices go back ` +
	`to the pool. Errors carry "recovery" text and native plan carries a "recommendation"; ` +
	`follow them before improvising.`

// Tool is one MCP tool entry.
type Tool struct {
	Name        string         `json:"name"`
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations,omitempty"`
}

// Tools lists every rndevtools command as an MCP tool, with input schemas
// generated from the CLI's own field table so the two cannot drift.
func Tools() []Tool {
	tools := make([]Tool, 0, len(toolOrder))
	for _, kind := range toolOrder {
		fields, ok := command.Describe(kind)
		if !ok {
			continue
		}
		properties := map[string]any{}
		for _, field := range fields {
			property := map[string]any{"type": field.Type, "description": field.Usage}
			if field.Type == "array" {
				property["items"] = map[string]any{"type": field.Items}
			}
			properties[field.Name] = property
		}
		schema := map[string]any{
			"type":                 "object",
			"properties":           properties,
			"additionalProperties": false,
		}
		if required := requiredFields[kind]; len(required) > 0 {
			schema["required"] = required
		}
		meta := toolMeta[kind]
		tools = append(tools, Tool{
			Name:        string(kind),
			Title:       meta.title,
			Description: meta.description,
			InputSchema: schema,
			Annotations: map[string]any{
				"readOnlyHint":    meta.readOnly,
				"destructiveHint": meta.destructive,
				"idempotentHint":  meta.readOnly,
				"openWorldHint":   false,
			},
		})
	}
	return tools
}

func (server *Server) callTool(ctx context.Context, params json.RawMessage) (any, *rpcError) {
	var call struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(params, &call); err != nil {
		return nil, &rpcError{Code: codeInvalidParams, Message: "tools/call needs name and arguments"}
	}
	kind, err := protocol.ParseCommand(call.Name)
	if err != nil {
		return nil, &rpcError{Code: codeInvalidParams, Message: fmt.Sprintf("unknown tool %q", call.Name)}
	}
	if call.Arguments == nil {
		call.Arguments = map[string]any{}
	}
	parsed, err := command.Build(kind, call.Arguments, server.config.Lookup)
	if err != nil {
		// Argument problems are reported as a tool error, not a protocol error,
		// so the model sees the message and can correct the call.
		return toolError("invalid_arguments", err.Error(), false, fmt.Sprintf("Check the %s tool's input schema.", kind)), nil
	}
	response, err := server.send(ctx, parsed)
	if err != nil {
		return toolError(classifyTransportError(err)), nil
	}
	if !response.OK {
		remote := response.Error
		return toolError(remote.Code, remote.Message, remote.Retryable, remote.Recovery), nil
	}
	return server.toolSuccess(kind, response.Result), nil
}

func (server *Server) send(ctx context.Context, parsed command.Parsed) (protocol.Response, error) {
	requestID, err := newRequestID()
	if err != nil {
		return protocol.Response{}, err
	}
	request := protocol.Request{Protocol: protocol.Name, ID: requestID, Command: parsed.Command}
	if agent := server.agent(); agent != nil {
		request.Agent = agent
	}
	if _, err := protocol.EncodeRequest(request); err != nil {
		return protocol.Response{}, err
	}
	return server.config.Transport(ctx, request, parsed.Timeout)
}

// agent attributes requests to the coding-agent session that spawned this
// server. The session variables win; failing those, the MCP client's name
// identifies at least which agent product is calling.
func (server *Server) agent() map[string]any {
	if agent := command.AgentFromEnvironment(server.config.Lookup); agent != nil {
		return agent
	}
	if server.clientName != "" {
		kind := "other"
		lower := strings.ToLower(server.clientName)
		switch {
		case strings.Contains(lower, "claude"):
			kind = "claude"
		case strings.Contains(lower, "codex"):
			kind = "codex"
		}
		return map[string]any{"kind": kind, "sessionId": "mcp-" + sanitizeSession(server.clientName)}
	}
	return nil
}

func sanitizeSession(value string) string {
	var builder strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			builder.WriteRune(r)
		default:
			builder.WriteRune('-')
		}
		if builder.Len() >= 100 {
			break
		}
	}
	if builder.Len() == 0 {
		return "client"
	}
	return builder.String()
}

// toolSuccess renders a result. Screenshots are embedded as an image content
// block alongside the JSON so the model can look at the device directly.
func (server *Server) toolSuccess(kind protocol.Command, result json.RawMessage) map[string]any {
	content := []any{map[string]any{"type": "text", "text": compact(result)}}
	if kind == protocol.CommandCapture {
		if image := server.embeddedCapture(result); image != nil {
			content = append(content, image)
		}
	}
	return map[string]any{"content": content, "structuredContent": json.RawMessage(result), "isError": false}
}

func (server *Server) embeddedCapture(result json.RawMessage) map[string]any {
	var capture struct {
		Path    string `json:"path"`
		Capture struct {
			MimeType string `json:"mimeType"`
		} `json:"capture"`
	}
	if err := json.Unmarshal(result, &capture); err != nil || capture.Path == "" {
		return nil
	}
	if !strings.HasPrefix(capture.Capture.MimeType, "image/") {
		return nil
	}
	data, err := server.config.ReadFile(filepath.Clean(capture.Path))
	if err != nil || len(data) == 0 || len(data) > maxImageBytes {
		return nil
	}
	return map[string]any{
		"type":     "image",
		"data":     base64.StdEncoding.EncodeToString(data),
		"mimeType": capture.Capture.MimeType,
	}
}

func toolError(code string, message string, retryable bool, recovery string) map[string]any {
	text := fmt.Sprintf("%s: %s", code, message)
	if recovery != "" {
		text += " Recovery: " + recovery
	}
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": text}},
		"structuredContent": map[string]any{
			"error": map[string]any{"code": code, "message": message, "retryable": retryable, "recovery": recovery},
		},
		"isError": true,
	}
}

func classifyTransportError(err error) (string, string, bool, string) {
	var clientError *client.ClientError
	if errors.As(err, &clientError) {
		switch clientError.Kind {
		case client.ErrorUnavailable:
			return "desktop_unavailable", clientError.Error(), true,
				"RN Devtools is not running. Ask the user to start the RN Devtools app, then retry."
		case client.ErrorTimeout:
			return "request_timeout", clientError.Error(), true, "Retry once; long operations may still be completing."
		case client.ErrorProtocol:
			return "invalid_response", clientError.Error(), false, ""
		}
		return "transport_error", clientError.Error(), true, ""
	}
	return "internal_error", err.Error(), false, ""
}

func compact(raw json.RawMessage) string {
	var buffer bytes.Buffer
	if err := json.Compact(&buffer, raw); err != nil {
		return string(raw)
	}
	return buffer.String()
}

func (server *Server) write(writer io.Writer, response *rpcResponse) error {
	encoded, err := json.Marshal(response)
	if err != nil {
		return err
	}
	server.writeLock.Lock()
	defer server.writeLock.Unlock()
	_, err = writer.Write(append(encoded, '\n'))
	return err
}

func newRequestID() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate request id: %w", err)
	}
	return "mcp-" + hex.EncodeToString(random), nil
}
