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
		if !oneOf(value.Operation, "status", "preview", "doctor", "verify") {
			return errors.New("slimming operation must be status, preview, doctor, or verify")
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
		case "doctor":
			if len(value.UDIDs) == 0 {
				return errors.New("slimming doctor requires udids")
			}
			if value.ProfileID != nil {
				return errors.New("slimming doctor inspects current state and does not accept profileId")
			}
			return nil
		default:
			if len(value.UDIDs) == 0 || value.ProfileID == nil {
				return errors.New("slimming preview and verify require udids and profileId")
			}
			return validateIdentifier(*value.ProfileID, "profileId")
		}
	default:
		return fmt.Errorf("unsupported command %q", expectedKind)
	}
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
