package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/avadtechnologies/pumpd-devtools-cli/internal/client"
	"github.com/avadtechnologies/pumpd-devtools-cli/internal/command"
	"github.com/avadtechnologies/pumpd-devtools-cli/internal/protocol"
)

const (
	ExitSuccess     = 0
	ExitUsage       = 2
	ExitUnavailable = 3
	ExitTimeout     = 4
	ExitTransport   = 5
	ExitRejected    = 6
	ExitInternal    = 7
)

type Config struct {
	Version        string
	BuildCommit    string
	Arguments      []string
	Stdin          io.Reader
	StdinAvailable bool
	Stdout         io.Writer
	Stderr         io.Writer
	SocketPath     string
}

func Run(config Config) int {
	if len(config.Arguments) == 0 {
		fmt.Fprint(config.Stdout, RootUsage())
		return ExitUsage
	}
	if len(config.Arguments) == 1 &&
		(config.Arguments[0] == "--help" || config.Arguments[0] == "help") {
		fmt.Fprint(config.Stdout, RootUsage())
		return ExitSuccess
	}
	if len(config.Arguments) == 1 && config.Arguments[0] == "--version" {
		writeJSON(config.Stdout, map[string]string{
			"name":        "pumpd-devtools",
			"version":     config.Version,
			"buildCommit": config.BuildCommit,
		})
		return ExitSuccess
	}
	requestID, err := newRequestID()
	if err != nil {
		writeLocalError(config.Stderr, "internal_error", err.Error(), false, "", "")
		return ExitInternal
	}

	kind, err := protocol.ParseCommand(config.Arguments[0])
	if err != nil {
		writeLocalError(
			config.Stderr,
			"invalid_arguments",
			err.Error(),
			false,
			"Run pumpd-devtools --help for the command list.",
			requestID,
		)
		return ExitUsage
	}
	parsed, err := command.Parse(
		kind,
		config.Arguments[1:],
		config.Stdin,
		config.StdinAvailable,
	)
	if errors.Is(err, command.ErrHelp) {
		fmt.Fprint(config.Stdout, command.Usage(kind))
		return ExitSuccess
	}
	if err != nil {
		writeLocalError(
			config.Stderr,
			"invalid_arguments",
			err.Error(),
			false,
			fmt.Sprintf("Run pumpd-devtools %s --help for command flags.", kind),
			requestID,
		)
		return ExitUsage
	}

	socketPath := config.SocketPath
	if socketPath == "" {
		socketPath, err = client.DefaultSocketPath()
		if err != nil {
			writeLocalError(config.Stderr, "internal_error", err.Error(), false, "", requestID)
			return ExitInternal
		}
	}
	localClient, err := client.New(socketPath, parsed.Timeout)
	if err != nil {
		writeLocalError(config.Stderr, "internal_error", err.Error(), false, "", requestID)
		return ExitInternal
	}
	request := protocol.Request{
		Protocol: protocol.Name,
		ID:       requestID,
		Command:  parsed.Command,
	}
	if _, err := protocol.EncodeRequest(request); err != nil {
		writeLocalError(
			config.Stderr,
			"invalid_arguments",
			err.Error(),
			false,
			"Reduce the JSON payload so the complete request fits within 256 KiB.",
			requestID,
		)
		return ExitUsage
	}
	response, err := localClient.Do(context.Background(), request)
	if err != nil {
		return writeClientError(config.Stderr, requestID, err)
	}
	writeJSON(config.Stdout, response)
	if !response.OK {
		return ExitRejected
	}
	return ExitSuccess
}

func RootUsage() string {
	var builder strings.Builder
	builder.WriteString("Usage: pumpd-devtools <command> [flags]\n\nCommands:\n")
	for _, name := range protocol.Commands() {
		fmt.Fprintf(&builder, "  %s\n", name)
	}
	builder.WriteString("\nEach command accepts structured flags and an optional bounded JSON object on stdin.\n")
	builder.WriteString("Output is one compact pumpd-devtools/1 JSON response.\n")
	return builder.String()
}

func writeClientError(writer io.Writer, requestID string, err error) int {
	var clientError *client.ClientError
	if !errors.As(err, &clientError) {
		writeLocalError(writer, "internal_error", err.Error(), false, "", requestID)
		return ExitInternal
	}
	switch clientError.Kind {
	case client.ErrorUnavailable:
		writeLocalError(
			writer,
			"desktop_unavailable",
			clientError.Error(),
			true,
			"Start PUMPD Devtools and retry. A stale socket is never removed by the CLI.",
			requestID,
		)
		return ExitUnavailable
	case client.ErrorTimeout:
		writeLocalError(
			writer,
			"request_timeout",
			clientError.Error(),
			true,
			"Retry or increase --request-timeout-ms up to 660000.",
			requestID,
		)
		return ExitTimeout
	case client.ErrorProtocol:
		writeLocalError(writer, "invalid_response", clientError.Error(), false, "", requestID)
		return ExitTransport
	default:
		writeLocalError(writer, "transport_error", clientError.Error(), true, "", requestID)
		return ExitTransport
	}
}

func writeLocalError(
	writer io.Writer,
	code string,
	message string,
	retryable bool,
	recovery string,
	requestID string,
) {
	response := protocol.Response{
		Protocol: protocol.Name,
		ID:       requestID,
		OK:       false,
		Error: &protocol.RemoteError{
			Code:      code,
			Message:   message,
			Retryable: retryable,
			Recovery:  recovery,
		},
	}
	writeJSON(writer, response)
}

func writeJSON(writer io.Writer, value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		fmt.Fprintf(os.Stderr, "{\"protocol\":%q,\"id\":\"\",\"ok\":false,\"error\":{\"code\":\"internal_error\",\"message\":%q,\"retryable\":false}}\n", protocol.Name, err.Error())
		return
	}
	_, _ = writer.Write(append(encoded, '\n'))
}

func newRequestID() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate request id: %w", err)
	}
	return "cli-" + hex.EncodeToString(random), nil
}
