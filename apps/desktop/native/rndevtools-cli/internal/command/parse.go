package command

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/client"
	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

var ErrHelp = errors.New("help requested")

type Parsed struct {
	Command json.RawMessage
	Timeout time.Duration
}

type fieldKind uint8

const (
	fieldString fieldKind = iota
	fieldInteger
	fieldNumber
	fieldBoolean
	fieldCSV
	fieldObject
)

type fieldSpec struct {
	flagName string
	path     []string
	kind     fieldKind
	usage    string
}

var commandFields = map[protocol.Command][]fieldSpec{
	protocol.CommandDoctor: {},
	protocol.CommandSimulators: {
		{flagName: "include-unavailable", path: []string{"includeUnavailable"}, kind: fieldBoolean, usage: "Include unavailable runtimes and devices."},
	},
	protocol.CommandApps: {
		{flagName: "udid", path: []string{"udid"}, kind: fieldString, usage: "Simulator UDID."},
	},
	protocol.CommandScreen: targetFields(),
	protocol.CommandElements: append(targetFields(),
		fieldSpec{flagName: "query", path: []string{"query"}, kind: fieldString, usage: "Element query."},
		fieldSpec{flagName: "limit", path: []string{"limit"}, kind: fieldInteger, usage: "Maximum elements (1..500)."},
	),
	protocol.CommandAct: append(targetFields(),
		fieldSpec{flagName: "tool", path: []string{"action", "tool"}, kind: fieldString, usage: "Connected-app tool identifier."},
		fieldSpec{flagName: "action-command", path: []string{"action", "command"}, kind: fieldString, usage: "Allowlisted connected-app command."},
		fieldSpec{flagName: "action-payload", path: []string{"action", "payload"}, kind: fieldObject, usage: "Connected-app payload JSON object."},
	),
	protocol.CommandWait: append(targetFields(),
		fieldSpec{flagName: "condition", path: []string{"condition", "kind"}, kind: fieldString, usage: "element, screen-change, job, or network-idle."},
		fieldSpec{flagName: "element-id", path: []string{"condition", "elementId"}, kind: fieldString, usage: "Element condition identifier."},
		fieldSpec{flagName: "screen-hash", path: []string{"condition", "screenHash"}, kind: fieldString, usage: "Prior screen hash."},
		fieldSpec{flagName: "job-id", path: []string{"condition", "jobId"}, kind: fieldString, usage: "Job condition identifier."},
		fieldSpec{flagName: "quiet-ms", path: []string{"condition", "quietMs"}, kind: fieldInteger, usage: "Network-idle quiet period."},
		fieldSpec{flagName: "timeout-ms", path: []string{"timeoutMs"}, kind: fieldInteger, usage: "Wait timeout (100..600000)."},
	),
	protocol.CommandCapture: {
		{flagName: "udid", path: []string{"udid"}, kind: fieldString, usage: "Simulator UDID."},
		{flagName: "format", path: []string{"format"}, kind: fieldString, usage: "png or jpeg."},
		{flagName: "name", path: []string{"name"}, kind: fieldString, usage: "Capture name."},
	},
	protocol.CommandRecord: {
		{flagName: "udid", path: []string{"udid"}, kind: fieldString, usage: "Simulator UDID."},
		{flagName: "operation", path: []string{"operation"}, kind: fieldString, usage: "start or stop."},
		{flagName: "codec", path: []string{"codec"}, kind: fieldString, usage: "h264 or hevc."},
		{flagName: "name", path: []string{"name"}, kind: fieldString, usage: "Recording name."},
		{flagName: "job-id", path: []string{"jobId"}, kind: fieldString, usage: "Recording job identifier."},
	},
	protocol.CommandNetwork: append(targetFields(),
		fieldSpec{flagName: "operation", path: []string{"operation"}, kind: fieldString, usage: "status, set, or clear."},
		fieldSpec{flagName: "profile-id", path: []string{"profileId"}, kind: fieldString, usage: "Network profile for set."},
	),
	protocol.CommandRecipe: {
		{flagName: "operation", path: []string{"operation"}, kind: fieldString, usage: "list, get, run, cancel, or status."},
		{flagName: "recipe-id", path: []string{"recipeId"}, kind: fieldString, usage: "Recipe identifier."},
		{flagName: "run-id", path: []string{"runId"}, kind: fieldString, usage: "Recipe run identifier."},
		{flagName: "udids", path: []string{"udids"}, kind: fieldCSV, usage: "Comma-separated simulator UDIDs (max 20)."},
	},
	protocol.CommandJobs: {
		{flagName: "operation", path: []string{"operation"}, kind: fieldString, usage: "list, get, or cancel."},
		{flagName: "job-id", path: []string{"jobId"}, kind: fieldString, usage: "Job identifier."},
	},
	protocol.CommandSlimming: {
		{flagName: "operation", path: []string{"operation"}, kind: fieldString, usage: "status, preview, doctor, verify (read-only); apply, undo, restore (mutate the devices this session holds or that are free, while SimSlim is enabled in the desktop)."},
		{flagName: "udids", path: []string{"udids"}, kind: fieldCSV, usage: "Comma-separated simulator UDIDs (max 20)."},
		{flagName: "profile-id", path: []string{"profileId"}, kind: fieldString, usage: "Profile identifier, required for preview, verify, and apply."},
	},
	protocol.CommandLane: {
		{flagName: "operation", path: []string{"operation"}, kind: fieldString, usage: "up, down, ls, launch, or log."},
		{flagName: "worktree", path: []string{"worktreePath"}, kind: fieldString, usage: "Absolute worktree path (up; or to address a lane)."},
		{flagName: "udid", path: []string{"udid"}, kind: fieldString, usage: "Simulator UDID the lane runs on (up). Omit it to let RN Devtools pick a free iPhone; when none is free the result carries a deviceRequest for the user to settle in the app."},
		{flagName: "environment", path: []string{"environment"}, kind: fieldString, usage: "Lane environment id; selects the Metro port range (up)."},
		{flagName: "preferred-port", path: []string{"preferredPort"}, kind: fieldInteger, usage: "Specific Metro port inside the environment range (up)."},
		{flagName: "launch", path: []string{"launch"}, kind: fieldBoolean, usage: "Open the dev client once Metro is ready (up; default true)."},
		{flagName: "slim", path: []string{"slimProfileId"}, kind: fieldString, usage: "SimSlim profile to apply to the Simulator before Metro starts (up). Applied when SimSlim is enabled in RN Devtools and the device is free or yours; otherwise lane.slim says why it was skipped."},
		{flagName: "lane-id", path: []string{"laneId"}, kind: fieldString, usage: "Lane identifier (down, launch, log)."},
		{flagName: "url", path: []string{"url"}, kind: fieldString, usage: "Path or full URL to open through the lane scheme (launch)."},
		{flagName: "max-characters", path: []string{"maxCharacters"}, kind: fieldInteger, usage: "Log tail size (log; 256..64000)."},
	},
	protocol.CommandAgents: {},
	protocol.CommandClaim: {
		{flagName: "udid", path: []string{"udid"}, kind: fieldString, usage: "Simulator UDID to claim for this agent session."},
		{flagName: "note", path: []string{"note"}, kind: fieldString, usage: "Why this session needs the device (shown in the desktop)."},
	},
	protocol.CommandRelease: {
		{flagName: "udid", path: []string{"udid"}, kind: fieldString, usage: "Simulator UDID to release."},
		{flagName: "all", path: []string{"all"}, kind: fieldBoolean, usage: "Release everything this session holds: stop its lanes and drop its claims (what the session-end hook runs)."},
	},
	protocol.CommandInput: {
		{flagName: "udid", path: []string{"input", "udid"}, kind: fieldString, usage: "Booted Simulator UDID to drive."},
		{flagName: "kind", path: []string{"input", "kind"}, kind: fieldString, usage: "tap, swipe, text, key, or button."},
		{flagName: "x", path: []string{"input", "x"}, kind: fieldNumber, usage: "Tap X as a 0..1 ratio of the screen width."},
		{flagName: "y", path: []string{"input", "y"}, kind: fieldNumber, usage: "Tap Y as a 0..1 ratio of the screen height."},
		{flagName: "hold-ms", path: []string{"input", "holdMilliseconds"}, kind: fieldInteger, usage: "Tap contact time (tap; 500+ for a long press)."},
		{flagName: "from-x", path: []string{"input", "fromX"}, kind: fieldNumber, usage: "Swipe start X ratio."},
		{flagName: "from-y", path: []string{"input", "fromY"}, kind: fieldNumber, usage: "Swipe start Y ratio."},
		{flagName: "to-x", path: []string{"input", "toX"}, kind: fieldNumber, usage: "Swipe end X ratio."},
		{flagName: "to-y", path: []string{"input", "toY"}, kind: fieldNumber, usage: "Swipe end Y ratio."},
		{flagName: "duration-ms", path: []string{"input", "durationMilliseconds"}, kind: fieldInteger, usage: "Swipe duration (swipe; default 250)."},
		{flagName: "text", path: []string{"input", "text"}, kind: fieldString, usage: "Printable ASCII to type (text)."},
		{flagName: "usage", path: []string{"input", "usage"}, kind: fieldInteger, usage: "USB HID keyboard usage (key): 40 Return, 42 Delete, 41 Escape."},
		{flagName: "modifiers", path: []string{"input", "modifiers"}, kind: fieldCSV, usage: "Comma-separated shift,control,option,command (key)."},
		{flagName: "button", path: []string{"input", "button"}, kind: fieldString, usage: "home, lock, siri, volume-up, volume-down, or apple-pay (button)."},
	},
	protocol.CommandNative: {
		{flagName: "operation", path: []string{"operation"}, kind: fieldString, usage: "plan (fingerprint + cache + installed state, builds nothing) or install (put a cached binary on the Simulator)."},
		{flagName: "worktree", path: []string{"worktreePath"}, kind: fieldString, usage: "Absolute path of the Expo app directory to fingerprint."},
		{flagName: "udid", path: []string{"udid"}, kind: fieldString, usage: "Simulator UDID to check or install on (required for install)."},
		{flagName: "configuration", path: []string{"configuration"}, kind: fieldString, usage: "Debug (default) or Release."},
	},
}

// Agent attribution. Claude Code and Codex export a session identifier into
// every subprocess they spawn; the CLI forwards it so the desktop can show
// which agent holds which lane. Every request carries it on its envelope;
// lane up/launch also embed it in the command so the lane records it.
const (
	envClaudeSession  = "CLAUDE_CODE_SESSION_ID"
	envCodexThread    = "CODEX_THREAD_ID"
	envGenericSession = "RNDEVTOOLS_AGENT_SESSION_ID"
)

var agentSessionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// AgentFromEnvironment reports the coding-agent session that owns this
// process, or nil when none is detectable.
func AgentFromEnvironment(lookup func(string) string) map[string]any {
	if lookup == nil {
		return nil
	}
	for _, candidate := range []struct {
		variable string
		kind     string
	}{
		{envClaudeSession, "claude"},
		{envCodexThread, "codex"},
		{envGenericSession, "other"},
	} {
		value := strings.TrimSpace(lookup(candidate.variable))
		if value != "" && agentSessionPattern.MatchString(value) {
			return map[string]any{"kind": candidate.kind, "sessionId": value}
		}
	}
	return nil
}

func Parse(
	kind protocol.Command,
	arguments []string,
	stdin io.Reader,
	stdinAvailable bool,
) (Parsed, error) {
	return ParseWithEnvironment(kind, arguments, stdin, stdinAvailable, nil)
}

// ParseWithEnvironment is Parse plus agent attribution read from `lookup`
// (normally os.Getenv). Attribution is attached only to lane commands that
// accept it and only when the caller did not already provide one.
func ParseWithEnvironment(
	kind protocol.Command,
	arguments []string,
	stdin io.Reader,
	stdinAvailable bool,
	lookup func(string) string,
) (Parsed, error) {
	specs, ok := commandFields[kind]
	if !ok {
		return Parsed{}, fmt.Errorf("unsupported command %q", kind)
	}
	flags := flag.NewFlagSet(string(kind), flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	values := make(map[string]*optionValue, len(specs))
	for _, spec := range specs {
		value := &optionValue{kind: spec.kind}
		values[spec.flagName] = value
		flags.Var(value, spec.flagName, spec.usage)
	}
	requestTimeout := &optionValue{kind: fieldInteger}
	flags.Var(requestTimeout, "request-timeout-ms", "CLI socket deadline (100..660000).")
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return Parsed{}, ErrHelp
		}
		return Parsed{}, err
	}
	if flags.NArg() > 0 {
		return Parsed{}, fmt.Errorf("unexpected positional arguments: %s", strings.Join(flags.Args(), " "))
	}

	command := map[string]any{}
	if stdinAvailable {
		input, err := readInputObject(stdin)
		if err != nil {
			return Parsed{}, err
		}
		command = input
	}
	if existingKind, exists := command["kind"]; exists {
		if existingKind != string(kind) {
			return Parsed{}, fmt.Errorf("stdin kind must be %q", kind)
		}
	} else {
		command["kind"] = string(kind)
	}
	for _, spec := range specs {
		value := values[spec.flagName]
		if !value.set {
			continue
		}
		if err := setPath(command, spec.path, value.value); err != nil {
			return Parsed{}, fmt.Errorf("--%s: %w", spec.flagName, err)
		}
	}

	attachAgent(kind, command, lookup)

	timeout := client.DefaultTimeout
	if requestTimeout.set {
		milliseconds := requestTimeout.value.(int)
		if milliseconds < 100 || milliseconds > 660_000 {
			return Parsed{}, errors.New("request-timeout-ms must be between 100 and 660000")
		}
		timeout = time.Duration(milliseconds) * time.Millisecond
	}
	timeout = deriveTimeout(kind, command, timeout, requestTimeout.set)
	encoded, err := json.Marshal(command)
	if err != nil {
		return Parsed{}, fmt.Errorf("encode command: %w", err)
	}
	if err := Validate(encoded, kind); err != nil {
		return Parsed{}, err
	}
	return Parsed{Command: encoded, Timeout: timeout}, nil
}

func Usage(kind protocol.Command) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "Usage: rndevtools %s [flags]\n", kind)
	builder.WriteString("Accepts an optional JSON command object on stdin. Flags and stdin may\n")
	builder.WriteString("supply different fields; defining the same field twice is rejected.\n\nFlags:\n")
	for _, spec := range commandFields[kind] {
		fmt.Fprintf(&builder, "  --%-22s %s\n", spec.flagName, spec.usage)
	}
	builder.WriteString("  --request-timeout-ms   CLI socket deadline (100..660000).\n")
	return builder.String()
}

func targetFields() []fieldSpec {
	return []fieldSpec{
		{flagName: "udid", path: []string{"target", "udid"}, kind: fieldString, usage: "Simulator UDID target."},
		{flagName: "device-id", path: []string{"target", "deviceId"}, kind: fieldString, usage: "Connected app device target."},
	}
}

type optionValue struct {
	kind  fieldKind
	set   bool
	value any
}

func (value *optionValue) String() string {
	if !value.set {
		return ""
	}
	return fmt.Sprint(value.value)
}

func (value *optionValue) IsBoolFlag() bool {
	return value.kind == fieldBoolean
}

func (value *optionValue) Set(raw string) error {
	if value.set {
		return errors.New("flag may be provided only once")
	}
	parsed, err := parseOptionValue(value.kind, raw)
	if err != nil {
		return err
	}
	value.value = parsed
	value.set = true
	return nil
}

func parseOptionValue(kind fieldKind, raw string) (any, error) {
	switch kind {
	case fieldString:
		return raw, nil
	case fieldInteger:
		value, err := strconv.Atoi(raw)
		if err != nil {
			return nil, errors.New("value must be an integer")
		}
		return value, nil
	case fieldNumber:
		value, err := strconv.ParseFloat(raw, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, errors.New("value must be a finite number")
		}
		return value, nil
	case fieldBoolean:
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return nil, errors.New("value must be true or false")
		}
		return value, nil
	case fieldCSV:
		if raw == "" {
			return nil, errors.New("value must not be empty")
		}
		parts := strings.Split(raw, ",")
		for _, part := range parts {
			if part == "" || part != strings.TrimSpace(part) {
				return nil, errors.New("comma-separated values must be non-empty and unpadded")
			}
		}
		return parts, nil
	case fieldObject:
		var object map[string]any
		decoder := json.NewDecoder(strings.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&object); err != nil || object == nil {
			return nil, errors.New("value must be a JSON object")
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			return nil, errors.New("value must contain one JSON object")
		}
		return object, nil
	default:
		return nil, errors.New("unsupported flag type")
	}
}

func readInputObject(reader io.Reader) (map[string]any, error) {
	limited := &io.LimitedReader{R: reader, N: protocol.MaxRequestBytes + 1}
	encoded, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("read stdin: %w", err)
	}
	if len(encoded) > protocol.MaxRequestBytes {
		return nil, fmt.Errorf("stdin exceeds %d bytes", protocol.MaxRequestBytes)
	}
	if len(bytes.TrimSpace(encoded)) == 0 {
		return map[string]any{}, nil
	}
	var object map[string]any
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	if err := decoder.Decode(&object); err != nil || object == nil {
		return nil, errors.New("stdin must contain one JSON object")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("stdin must contain one JSON object")
	}
	return object, nil
}

func setPath(object map[string]any, path []string, value any) error {
	cursor := object
	for _, segment := range path[:len(path)-1] {
		existing, ok := cursor[segment]
		if !ok {
			nested := map[string]any{}
			cursor[segment] = nested
			cursor = nested
			continue
		}
		nested, ok := existing.(map[string]any)
		if !ok {
			return fmt.Errorf("%s is already a non-object stdin field", segment)
		}
		cursor = nested
	}
	leaf := path[len(path)-1]
	if _, exists := cursor[leaf]; exists {
		return fmt.Errorf("%s is already defined by stdin", strings.Join(path, "."))
	}
	cursor[leaf] = value
	return nil
}
