package command

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

const (
	maxShortText = 4 * 1024
	maxQueryText = 8 * 1024
)

var (
	identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)
	udidPattern       = regexp.MustCompile(`(?i)^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$`)
	safeActions       = map[string]struct{}{
		"components.activate":            {},
		"components.focus":               {},
		"components.highlight":           {},
		"components.scroll":              {},
		"components.setText":             {},
		"components.waitForElement":      {},
		"components.waitForScreenChange": {},
		"network.clearProfile":           {},
		"network.setProfile":             {},
		"performance.start":              {},
		"performance.stop":               {},
		"routes.navigate":                {},
	}
)

type Target struct {
	UDID     string `json:"udid,omitempty"`
	DeviceID string `json:"deviceId,omitempty"`
}

type ConnectedAction struct {
	Tool    string         `json:"tool"`
	Command string         `json:"command"`
	Payload map[string]any `json:"payload"`
}

type WaitCondition struct {
	Kind       string `json:"kind"`
	ElementID  string `json:"elementId,omitempty"`
	ScreenHash string `json:"screenHash,omitempty"`
	JobID      string `json:"jobId,omitempty"`
	QuietMS    *int   `json:"quietMs,omitempty"`
}

func Validate(encoded json.RawMessage, expectedKind protocol.Command) error {
	if err := rejectUnsupportedNulls(encoded, expectedKind); err != nil {
		return err
	}
	switch expectedKind {
	case protocol.CommandDoctor:
		var value struct {
			Kind string `json:"kind"`
		}
		return decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind))
	case protocol.CommandSimulators:
		var value struct {
			Kind               string `json:"kind"`
			IncludeUnavailable *bool  `json:"includeUnavailable,omitempty"`
		}
		return decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind))
	case protocol.CommandApps:
		var value struct {
			Kind string `json:"kind"`
			UDID string `json:"udid"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		return validateUDID(value.UDID)
	case protocol.CommandScreen:
		var value struct {
			Kind   string `json:"kind"`
			Target Target `json:"target"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		return value.Target.validate()
	case protocol.CommandElements:
		var value struct {
			Kind   string  `json:"kind"`
			Target Target  `json:"target"`
			Query  *string `json:"query,omitempty"`
			Limit  *int    `json:"limit,omitempty"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		if err := value.Target.validate(); err != nil {
			return err
		}
		if value.Query != nil && utf8.RuneCountInString(*value.Query) > maxQueryText {
			return fmt.Errorf("query exceeds %d characters", maxQueryText)
		}
		if value.Limit != nil && (*value.Limit < 1 || *value.Limit > 500) {
			return errors.New("limit must be between 1 and 500")
		}
		return nil
	case protocol.CommandAct:
		var value struct {
			Kind   string          `json:"kind"`
			Target Target          `json:"target"`
			Action ConnectedAction `json:"action"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		if err := value.Target.validate(); err != nil {
			return err
		}
		return value.Action.validate()
	case protocol.CommandWait:
		var value struct {
			Kind      string        `json:"kind"`
			Target    *Target       `json:"target,omitempty"`
			Condition WaitCondition `json:"condition"`
			TimeoutMS *int          `json:"timeoutMs,omitempty"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		if value.Target != nil {
			if err := value.Target.validate(); err != nil {
				return err
			}
		}
		if err := value.Condition.validate(); err != nil {
			return err
		}
		if value.TimeoutMS != nil && (*value.TimeoutMS < 100 || *value.TimeoutMS > 600_000) {
			return errors.New("timeoutMs must be between 100 and 600000")
		}
		return nil
	case protocol.CommandCapture:
		var value struct {
			Kind   string  `json:"kind"`
			UDID   string  `json:"udid"`
			Format *string `json:"format,omitempty"`
			Name   *string `json:"name,omitempty"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		if err := validateUDID(value.UDID); err != nil {
			return err
		}
		if value.Format != nil && *value.Format != "png" && *value.Format != "jpeg" {
			return errors.New("format must be png or jpeg")
		}
		return validateOptionalShortText(value.Name, "name")
	case protocol.CommandRecord:
		var value struct {
			Kind      string  `json:"kind"`
			UDID      string  `json:"udid"`
			Operation string  `json:"operation"`
			Codec     *string `json:"codec,omitempty"`
			Name      *string `json:"name,omitempty"`
			JobID     *string `json:"jobId,omitempty"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		if err := validateUDID(value.UDID); err != nil {
			return err
		}
		if value.Operation != "start" && value.Operation != "stop" {
			return errors.New("operation must be start or stop")
		}
		if value.Codec != nil && *value.Codec != "h264" && *value.Codec != "hevc" {
			return errors.New("codec must be h264 or hevc")
		}
		if err := validateOptionalShortText(value.Name, "name"); err != nil {
			return err
		}
		return validateOptionalIdentifier(value.JobID, "jobId")
	case protocol.CommandNetwork:
		var value struct {
			Kind      string  `json:"kind"`
			Target    Target  `json:"target"`
			Operation string  `json:"operation"`
			ProfileID *string `json:"profileId,omitempty"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		if err := value.Target.validate(); err != nil {
			return err
		}
		if value.Operation != "status" && value.Operation != "set" && value.Operation != "clear" {
			return errors.New("operation must be status, set, or clear")
		}
		if (value.Operation == "set") != (value.ProfileID != nil) {
			return errors.New("only network set requires profileId")
		}
		return validateOptionalIdentifier(value.ProfileID, "profileId")
	case protocol.CommandRecipe:
		var value struct {
			Kind      string   `json:"kind"`
			Operation string   `json:"operation"`
			RecipeID  *string  `json:"recipeId,omitempty"`
			RunID     *string  `json:"runId,omitempty"`
			UDIDs     []string `json:"udids,omitempty"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		if !oneOf(value.Operation, "list", "get", "run", "cancel", "status") {
			return errors.New("operation must be list, get, run, cancel, or status")
		}
		if err := validateOptionalIdentifier(value.RecipeID, "recipeId"); err != nil {
			return err
		}
		if err := validateOptionalIdentifier(value.RunID, "runId"); err != nil {
			return err
		}
		return validateUDIDs(value.UDIDs)
	case protocol.CommandJobs:
		var value struct {
			Kind      string  `json:"kind"`
			Operation string  `json:"operation"`
			JobID     *string `json:"jobId,omitempty"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		if !oneOf(value.Operation, "list", "get", "cancel") {
			return errors.New("operation must be list, get, or cancel")
		}
		return validateOptionalIdentifier(value.JobID, "jobId")
	case protocol.CommandSlimming:
		var value struct {
			Kind      string   `json:"kind"`
			Operation string   `json:"operation"`
			UDIDs     []string `json:"udids,omitempty"`
			ProfileID *string  `json:"profileId,omitempty"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		if !oneOf(value.Operation, "status", "preview", "doctor", "verify", "apply", "undo", "restore") {
			return errors.New("slimming operation must be status, preview, doctor, verify, apply, undo, or restore")
		}
		if err := validateUDIDs(value.UDIDs); err != nil {
			return err
		}
		switch value.Operation {
		case "status":
			if value.UDIDs != nil || value.ProfileID != nil {
				return errors.New("slimming status does not accept udids or profileId")
			}
			return nil
		case "doctor", "undo", "restore":
			if len(value.UDIDs) == 0 {
				return fmt.Errorf("slimming %s requires udids", value.Operation)
			}
			if value.ProfileID != nil {
				return fmt.Errorf("slimming %s does not accept profileId", value.Operation)
			}
			return nil
		default:
			if len(value.UDIDs) == 0 || value.ProfileID == nil {
				return errors.New("slimming preview, verify, and apply require udids and profileId")
			}
			return validateIdentifier(*value.ProfileID, "profileId")
		}
	case protocol.CommandLane:
		var value struct {
			Kind          string             `json:"kind"`
			Operation     string             `json:"operation"`
			WorktreePath  *string            `json:"worktreePath,omitempty"`
			UDID          *string            `json:"udid,omitempty"`
			Environment   *string            `json:"environment,omitempty"`
			PreferredPort *int               `json:"preferredPort,omitempty"`
			Launch        *bool              `json:"launch,omitempty"`
			SlimProfileID *string            `json:"slimProfileId,omitempty"`
			LaneID        *string            `json:"laneId,omitempty"`
			URL           *string            `json:"url,omitempty"`
			MaxCharacters *int               `json:"maxCharacters,omitempty"`
			Agent         *map[string]string `json:"agent,omitempty"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		return validateLane(value.Operation, value.WorktreePath, value.UDID, value.Environment,
			value.PreferredPort, value.Launch, value.SlimProfileID, value.LaneID, value.URL, value.MaxCharacters, value.Agent)
	case protocol.CommandAgents:
		var value struct {
			Kind string `json:"kind"`
		}
		return decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind))
	case protocol.CommandClaim, protocol.CommandRelease:
		var value struct {
			Kind string  `json:"kind"`
			UDID *string `json:"udid,omitempty"`
			Note *string `json:"note,omitempty"`
			All  *bool   `json:"all,omitempty"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		if value.All != nil {
			if expectedKind != protocol.CommandRelease {
				return errors.New("claim does not accept all")
			}
			if value.UDID != nil {
				return errors.New("release takes exactly one of udid or all")
			}
			if !*value.All {
				return errors.New("all must be true when given")
			}
			return nil
		}
		if value.UDID == nil {
			if expectedKind == protocol.CommandRelease {
				return errors.New("release requires udid or all")
			}
			return fmt.Errorf("%s requires udid", expectedKind)
		}
		if err := validateUDID(*value.UDID); err != nil {
			return err
		}
		if value.Note != nil {
			if expectedKind == protocol.CommandRelease {
				return errors.New("release does not accept note")
			}
			if utf8.RuneCountInString(*value.Note) > 4096 {
				return errors.New("note must be at most 4096 characters")
			}
		}
		return nil
	case protocol.CommandInput:
		var value struct {
			Kind  string `json:"kind"`
			Input *struct {
				Kind                 string   `json:"kind"`
				UDID                 string   `json:"udid"`
				X                    *float64 `json:"x,omitempty"`
				Y                    *float64 `json:"y,omitempty"`
				FromX                *float64 `json:"fromX,omitempty"`
				FromY                *float64 `json:"fromY,omitempty"`
				ToX                  *float64 `json:"toX,omitempty"`
				ToY                  *float64 `json:"toY,omitempty"`
				HoldMilliseconds     *int     `json:"holdMilliseconds,omitempty"`
				DurationMilliseconds *int     `json:"durationMilliseconds,omitempty"`
				Steps                *int     `json:"steps,omitempty"`
				Text                 *string  `json:"text,omitempty"`
				Usage                *int     `json:"usage,omitempty"`
				Modifiers            []string `json:"modifiers,omitempty"`
				Button               *string  `json:"button,omitempty"`
			} `json:"input"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		if value.Input == nil {
			return errors.New("input requires --udid and --kind")
		}
		return validateSimulatorInput(value.Input.Kind, value.Input.UDID, value.Input.X, value.Input.Y,
			value.Input.FromX, value.Input.FromY, value.Input.ToX, value.Input.ToY,
			value.Input.HoldMilliseconds, value.Input.DurationMilliseconds, value.Input.Steps,
			value.Input.Text, value.Input.Usage, value.Input.Modifiers, value.Input.Button)
	case protocol.CommandNative:
		var value struct {
			Kind          string  `json:"kind"`
			Operation     string  `json:"operation"`
			WorktreePath  *string `json:"worktreePath,omitempty"`
			UDID          *string `json:"udid,omitempty"`
			Configuration *string `json:"configuration,omitempty"`
		}
		if err := decodeAndCheckKind(encoded, expectedKind, &value, valueKind(&value.Kind)); err != nil {
			return err
		}
		if !oneOf(value.Operation, "plan", "install") {
			return errors.New("native operation must be plan or install")
		}
		if value.WorktreePath == nil || !strings.HasPrefix(*value.WorktreePath, "/") || len(*value.WorktreePath) < 2 || len(*value.WorktreePath) > 1024 || strings.ContainsRune(*value.WorktreePath, 0) {
			return errors.New("native requires an absolute worktreePath")
		}
		if value.UDID != nil {
			if err := validateUDID(*value.UDID); err != nil {
				return err
			}
		} else if value.Operation == "install" {
			return errors.New("native install requires udid")
		}
		if value.Configuration != nil && !oneOf(*value.Configuration, "Debug", "Release") {
			return errors.New("configuration must be Debug or Release")
		}
		return nil
	default:
		return fmt.Errorf("unsupported command %q", expectedKind)
	}
}

var (
	laneIDPattern          = regexp.MustCompile(`(?i)^lane-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)
	laneEnvironmentPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
)

func validateLane(
	operation string,
	worktreePath, udid, environment *string,
	preferredPort *int,
	launch *bool,
	slimProfileID, laneID, url *string,
	maxCharacters *int,
	agent *map[string]string,
) error {
	if !oneOf(operation, "up", "down", "ls", "launch", "log") {
		return errors.New("lane operation must be up, down, ls, launch, or log")
	}
	if worktreePath != nil {
		if !strings.HasPrefix(*worktreePath, "/") || len(*worktreePath) < 2 || len(*worktreePath) > 1024 || strings.ContainsRune(*worktreePath, 0) {
			return errors.New("worktreePath must be an absolute path")
		}
	}
	if udid != nil {
		if err := validateUDID(*udid); err != nil {
			return err
		}
	}
	if environment != nil && !laneEnvironmentPattern.MatchString(*environment) {
		return errors.New("environment must be a lowercase slug")
	}
	if preferredPort != nil && (*preferredPort < 1024 || *preferredPort > 65535) {
		return errors.New("preferredPort must be between 1024 and 65535")
	}
	if slimProfileID != nil {
		if err := validateIdentifier(*slimProfileID, "slimProfileId"); err != nil {
			return err
		}
	}
	if laneID != nil && !laneIDPattern.MatchString(*laneID) {
		return errors.New("laneId is invalid")
	}
	if url != nil && (len(*url) == 0 || utf8.RuneCountInString(*url) > 2048) {
		return errors.New("url must contain 1..2048 characters")
	}
	if maxCharacters != nil && (*maxCharacters < 256 || *maxCharacters > 64000) {
		return errors.New("maxCharacters must be between 256 and 64000")
	}
	if agent != nil {
		kind := (*agent)["kind"]
		if !oneOf(kind, "claude", "codex", "other") {
			return errors.New("agent kind must be claude, codex, or other")
		}
		if err := validateIdentifier((*agent)["sessionId"], "agent.sessionId"); err != nil {
			return err
		}
		if len(*agent) != 2 {
			return errors.New("agent accepts only kind and sessionId")
		}
	}
	targetsLane := (laneID != nil) != (worktreePath != nil)
	switch operation {
	case "up":
		if worktreePath == nil {
			return errors.New("lane up requires worktreePath")
		}
		if laneID != nil || url != nil || maxCharacters != nil {
			return errors.New("lane up does not accept laneId, url, or maxCharacters")
		}
	case "ls":
		if worktreePath != nil || udid != nil || environment != nil || preferredPort != nil ||
			launch != nil || slimProfileID != nil || laneID != nil || url != nil || maxCharacters != nil || agent != nil {
			return errors.New("lane ls does not accept other fields")
		}
	case "down":
		if !targetsLane || udid != nil || environment != nil || preferredPort != nil || launch != nil || slimProfileID != nil || url != nil || maxCharacters != nil || agent != nil {
			return errors.New("lane down takes exactly one of laneId or worktreePath")
		}
	case "launch":
		if !targetsLane || udid != nil || environment != nil || preferredPort != nil || launch != nil || slimProfileID != nil || maxCharacters != nil {
			return errors.New("lane launch takes exactly one of laneId or worktreePath, plus an optional url")
		}
	case "log":
		if !targetsLane || udid != nil || environment != nil || preferredPort != nil || launch != nil || slimProfileID != nil || url != nil || agent != nil {
			return errors.New("lane log takes exactly one of laneId or worktreePath, plus an optional maxCharacters")
		}
	}
	return nil
}

func ratioOK(value *float64) bool {
	return value != nil && *value >= 0 && *value <= 1
}

func validateSimulatorInput(
	kind, udid string,
	x, y, fromX, fromY, toX, toY *float64,
	hold, duration, steps *int,
	text *string, usage *int, modifiers []string, button *string,
) error {
	if err := validateUDID(udid); err != nil {
		return err
	}
	coords := x != nil || y != nil
	swipeCoords := fromX != nil || fromY != nil || toX != nil || toY != nil
	switch kind {
	case "tap":
		if !ratioOK(x) || !ratioOK(y) {
			return errors.New("tap requires --x and --y between 0 and 1")
		}
		if hold != nil && (*hold < 0 || *hold > 10000) {
			return errors.New("hold-ms must be between 0 and 10000")
		}
		if swipeCoords || duration != nil || steps != nil || text != nil || usage != nil || modifiers != nil || button != nil {
			return errors.New("tap accepts only --x, --y, and --hold-ms")
		}
	case "swipe":
		if !ratioOK(fromX) || !ratioOK(fromY) || !ratioOK(toX) || !ratioOK(toY) {
			return errors.New("swipe requires --from-x, --from-y, --to-x, and --to-y between 0 and 1")
		}
		if duration != nil && (*duration < 1 || *duration > 10000) {
			return errors.New("duration-ms must be between 1 and 10000")
		}
		if steps != nil && (*steps < 2 || *steps > 120) {
			return errors.New("steps must be between 2 and 120")
		}
		if coords || hold != nil || text != nil || usage != nil || modifiers != nil || button != nil {
			return errors.New("swipe accepts only its coordinates, --duration-ms, and --steps")
		}
	case "text":
		if text == nil || *text == "" || utf8.RuneCountInString(*text) > 2048 {
			return errors.New("text requires --text with 1..2048 characters")
		}
		for _, r := range *text {
			if !(r == '\n' || r == '\t' || (r >= 0x20 && r <= 0x7e)) {
				return errors.New("text must be printable ASCII (plus newline and tab)")
			}
		}
		if coords || swipeCoords || hold != nil || duration != nil || steps != nil || usage != nil || modifiers != nil || button != nil {
			return errors.New("text accepts only --text")
		}
	case "key":
		if usage == nil || *usage < 0x04 || *usage > 0xE7 {
			return errors.New("key requires --usage, a USB HID keyboard usage between 4 and 231")
		}
		for _, modifier := range modifiers {
			if !oneOf(modifier, "shift", "control", "option", "command") {
				return errors.New("modifiers may only contain shift, control, option, and command")
			}
		}
		if coords || swipeCoords || hold != nil || duration != nil || steps != nil || text != nil || button != nil {
			return errors.New("key accepts only --usage and --modifiers")
		}
	case "button":
		if button == nil || !oneOf(*button, "home", "lock", "siri", "volume-up", "volume-down", "apple-pay") {
			return errors.New("button requires --button: home, lock, siri, volume-up, volume-down, or apple-pay")
		}
		if coords || swipeCoords || hold != nil || duration != nil || steps != nil || text != nil || usage != nil || modifiers != nil {
			return errors.New("button accepts only --button")
		}
	default:
		return errors.New("input kind must be tap, swipe, text, key, or button")
	}
	return nil
}

func rejectUnsupportedNulls(encoded json.RawMessage, kind protocol.Command) error {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return fmt.Errorf("decode command: %w", err)
	}
	return walkNulls(value, nil, kind)
}

func walkNulls(value any, path []string, kind protocol.Command) error {
	if value == nil {
		if kind == protocol.CommandAct && len(path) >= 3 &&
			path[0] == "action" && path[1] == "payload" {
			return nil
		}
		return fmt.Errorf("%s must not be null", strings.Join(path, "."))
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if err := walkNulls(child, append(path, key), kind); err != nil {
				return err
			}
		}
	case []any:
		for index, child := range typed {
			if err := walkNulls(child, append(path, fmt.Sprint(index)), kind); err != nil {
				return err
			}
		}
	}
	return nil
}

type kindPointer func() string

func valueKind(value *string) kindPointer {
	return func() string { return *value }
}

func decodeAndCheckKind(
	encoded json.RawMessage,
	expectedKind protocol.Command,
	destination any,
	kind kindPointer,
) error {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("invalid %s command: %w", expectedKind, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("command contains more than one JSON value")
	}
	if kind() != string(expectedKind) {
		return fmt.Errorf("command kind must be %q", expectedKind)
	}
	return nil
}

func (target Target) validate() error {
	if (target.UDID == "") == (target.DeviceID == "") {
		return errors.New("target must contain exactly one of udid or deviceId")
	}
	if target.UDID != "" {
		return validateUDID(target.UDID)
	}
	return validateIdentifier(target.DeviceID, "deviceId")
}

func (action ConnectedAction) validate() error {
	if strings.TrimSpace(action.Tool) == "" || utf8.RuneCountInString(action.Tool) > 64 {
		return errors.New("action tool must contain 1..64 characters")
	}
	if strings.TrimSpace(action.Command) == "" || utf8.RuneCountInString(action.Command) > 64 {
		return errors.New("action command must contain 1..64 characters")
	}
	if _, ok := safeActions[strings.TrimSpace(action.Tool)+"."+strings.TrimSpace(action.Command)]; !ok {
		return errors.New("action is not permitted through the unattended CLI")
	}
	if action.Payload == nil {
		return errors.New("action payload is required")
	}
	for key := range action.Payload {
		if utf8.RuneCountInString(key) > 128 {
			return errors.New("action payload key exceeds 128 characters")
		}
	}
	return nil
}

func (condition WaitCondition) validate() error {
	switch condition.Kind {
	case "element":
		if condition.ScreenHash != "" || condition.JobID != "" || condition.QuietMS != nil {
			return errors.New("element condition accepts only elementId")
		}
		return validateIdentifier(condition.ElementID, "elementId")
	case "screen-change":
		if condition.ElementID != "" || condition.JobID != "" || condition.QuietMS != nil {
			return errors.New("screen-change condition accepts only screenHash")
		}
		return validateIdentifier(condition.ScreenHash, "screenHash")
	case "job":
		if condition.ElementID != "" || condition.ScreenHash != "" || condition.QuietMS != nil {
			return errors.New("job condition accepts only jobId")
		}
		return validateIdentifier(condition.JobID, "jobId")
	case "network-idle":
		if condition.ElementID != "" || condition.ScreenHash != "" || condition.JobID != "" {
			return errors.New("network-idle condition accepts only quietMs")
		}
		if condition.QuietMS != nil && (*condition.QuietMS < 100 || *condition.QuietMS > 60_000) {
			return errors.New("quietMs must be between 100 and 60000")
		}
		return nil
	default:
		return errors.New("condition kind must be element, screen-change, job, or network-idle")
	}
}

func validateUDID(value string) error {
	if !udidPattern.MatchString(value) {
		return errors.New("udid is invalid")
	}
	return nil
}

func validateUDIDs(values []string) error {
	if values == nil {
		return nil
	}
	if len(values) == 0 || len(values) > 20 {
		return errors.New("udids must contain between 1 and 20 values")
	}
	for _, value := range values {
		if err := validateUDID(value); err != nil {
			return err
		}
	}
	return nil
}

func validateOptionalIdentifier(value *string, field string) error {
	if value == nil {
		return nil
	}
	return validateIdentifier(*value, field)
}

func validateIdentifier(value string, field string) error {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) == 0 || len(trimmed) > 256 || !identifierPattern.MatchString(trimmed) {
		return fmt.Errorf("%s is not a valid identifier", field)
	}
	return nil
}

func validateOptionalShortText(value *string, field string) error {
	if value != nil && utf8.RuneCountInString(*value) > maxShortText {
		return fmt.Errorf("%s exceeds %d characters", field, maxShortText)
	}
	return nil
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
