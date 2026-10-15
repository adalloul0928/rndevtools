package command

import (
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/client"
	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

// Field describes one argument a command accepts, in the vocabulary a JSON
// Schema consumer (the MCP server) needs. It is derived from the same table
// the CLI builds its flags from, so the two surfaces cannot drift.
type Field struct {
	// Name is the flag name without dashes, e.g. "hold-ms".
	Name string
	// Path is where the value lands in the command object, e.g. ["input","holdMilliseconds"].
	Path []string
	// Type is a JSON Schema type: string, integer, number, boolean, array, or object.
	Type string
	// Items is the array item type when Type is "array".
	Items string
	Usage string
}

// Describe lists a command's fields in declaration order.
func Describe(kind protocol.Command) ([]Field, bool) {
	specs, ok := commandFields[kind]
	if !ok {
		return nil, false
	}
	fields := make([]Field, 0, len(specs))
	for _, spec := range specs {
		field := Field{Name: spec.flagName, Path: spec.path, Usage: spec.usage}
		switch spec.kind {
		case fieldString:
			field.Type = "string"
		case fieldInteger:
			field.Type = "integer"
		case fieldNumber:
			field.Type = "number"
		case fieldBoolean:
			field.Type = "boolean"
		case fieldCSV:
			field.Type = "array"
			field.Items = "string"
		case fieldObject:
			field.Type = "object"
		}
		fields = append(fields, field)
	}
	return fields, true
}

// Build assembles and validates a command from already-typed arguments keyed
// by field name, the way a tool call delivers them. It applies the same
// placement, agent attribution, timeout derivation, and validation as the
// flag parser, so a request built here is indistinguishable to the desktop
// from one typed at a shell.
func Build(kind protocol.Command, arguments map[string]any, lookup func(string) string) (Parsed, error) {
	specs, ok := commandFields[kind]
	if !ok {
		return Parsed{}, fmt.Errorf("unsupported command %q", kind)
	}
	byName := make(map[string]fieldSpec, len(specs))
	for _, spec := range specs {
		byName[spec.flagName] = spec
	}
	names := make([]string, 0, len(arguments))
	for name := range arguments {
		names = append(names, name)
	}
	sort.Strings(names)

	command := map[string]any{"kind": string(kind)}
	for _, name := range names {
		spec, known := byName[name]
		if !known {
			return Parsed{}, fmt.Errorf("unknown argument %q", name)
		}
		value, err := coerceArgument(spec.kind, arguments[name])
		if err != nil {
			return Parsed{}, fmt.Errorf("%s: %w", name, err)
		}
		if err := setPath(command, spec.path, value); err != nil {
			return Parsed{}, fmt.Errorf("%s: %w", name, err)
		}
	}
	attachAgent(kind, command, lookup)

	encoded, err := json.Marshal(command)
	if err != nil {
		return Parsed{}, fmt.Errorf("encode command: %w", err)
	}
	if err := Validate(encoded, kind); err != nil {
		return Parsed{}, err
	}
	return Parsed{Command: encoded, Timeout: deriveTimeout(kind, command, client.DefaultTimeout, false)}, nil
}

// coerceArgument accepts the value shapes JSON decoding produces (float64 for
// every number, []any for arrays) and checks them against the field's kind.
func coerceArgument(kind fieldKind, raw any) (any, error) {
	switch kind {
	case fieldString:
		value, ok := raw.(string)
		if !ok {
			return nil, fmt.Errorf("must be a string")
		}
		return value, nil
	case fieldInteger:
		switch value := raw.(type) {
		case float64:
			if value != float64(int(value)) {
				return nil, fmt.Errorf("must be an integer")
			}
			return int(value), nil
		case int:
			return value, nil
		case json.Number:
			integer, err := value.Int64()
			if err != nil {
				return nil, fmt.Errorf("must be an integer")
			}
			return int(integer), nil
		}
		return nil, fmt.Errorf("must be an integer")
	case fieldNumber:
		switch value := raw.(type) {
		case float64:
			return value, nil
		case int:
			return float64(value), nil
		case json.Number:
			number, err := value.Float64()
			if err != nil {
				return nil, fmt.Errorf("must be a number")
			}
			return number, nil
		}
		return nil, fmt.Errorf("must be a number")
	case fieldBoolean:
		value, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("must be a boolean")
		}
		return value, nil
	case fieldCSV:
		items, ok := raw.([]any)
		if !ok {
			return nil, fmt.Errorf("must be an array of strings")
		}
		parts := make([]string, 0, len(items))
		for _, item := range items {
			part, ok := item.(string)
			if !ok || part == "" {
				return nil, fmt.Errorf("must be an array of non-empty strings")
			}
			parts = append(parts, part)
		}
		if len(parts) == 0 {
			return nil, fmt.Errorf("must not be empty")
		}
		return parts, nil
	case fieldObject:
		object, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("must be an object")
		}
		return object, nil
	}
	return nil, fmt.Errorf("unsupported field type")
}

// attachAgent embeds the owning agent session into lane up/launch commands when
// the caller did not already provide one. Every request also carries the agent
// on its envelope; this copy is what the lane itself records.
func attachAgent(kind protocol.Command, command map[string]any, lookup func(string) string) {
	if kind != protocol.CommandLane {
		return
	}
	operation, _ := command["operation"].(string)
	if _, provided := command["agent"]; !provided && (operation == "up" || operation == "launch") {
		if agent := AgentFromEnvironment(lookup); agent != nil {
			command["agent"] = agent
		}
	}
}

// deriveTimeout gives the long-running commands (lane, native, wait) the
// socket headroom they need unless the caller set one explicitly.
func deriveTimeout(kind protocol.Command, command map[string]any, timeout time.Duration, explicit bool) time.Duration {
	if explicit {
		return timeout
	}
	switch kind {
	case protocol.CommandLane, protocol.CommandNative:
		// Booting a Simulator and waiting for Metro, or fingerprinting a
		// worktree with Expo's tooling, can exceed the default deadline.
		if derived := 240 * time.Second; derived > timeout {
			return derived
		}
	case protocol.CommandWait:
		waitMilliseconds := 30_000
		if value, ok := command["timeoutMs"]; ok {
			switch typed := value.(type) {
			case int:
				waitMilliseconds = typed
			case float64:
				waitMilliseconds = int(typed)
			}
		}
		if derived := time.Duration(waitMilliseconds+10_000) * time.Millisecond; derived > timeout {
			return derived
		}
	}
	return timeout
}
