package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

const testID = "cli-0123456789abcdef0123456789abcdef"

func TestEncodeRequestUsesFrozenEnvelope(t *testing.T) {
	encoded, err := EncodeRequest(Request{
		Protocol: Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"protocol":"pumpd-devtools/1","id":"cli-0123456789abcdef0123456789abcdef","command":{"kind":"doctor"}}`
	if string(encoded) != want {
		t.Fatalf("encoded request = %s, want %s", encoded, want)
	}
}

func TestEncodeRequestRejectsUnknownCommandAndOversize(t *testing.T) {
	for name, request := range map[string]Request{
		"unknown": {
			Protocol: Name,
			ID:       testID,
			Command:  json.RawMessage(`{"kind":"shell"}`),
		},
		"oversize": {
			Protocol: Name,
			ID:       testID,
			Command: json.RawMessage(
				`{"kind":"doctor","padding":"` + strings.Repeat("x", MaxRequestBytes) + `"}`,
			),
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := EncodeRequest(request); err == nil {
				t.Fatal("expected request rejection")
			}
		})
	}
}

func TestDecodeResponseValidatesCorrelationAndShape(t *testing.T) {
	response, err := DecodeResponse(
		[]byte(`{"protocol":"pumpd-devtools/1","id":"`+testID+`","ok":true,"result":{"healthy":true}}`),
		testID,
	)
	if err != nil || !response.OK {
		t.Fatalf("DecodeResponse() = %#v, %v", response, err)
	}

	failures := []string{
		`{"protocol":"pumpd-devtools/1","id":"other","ok":true,"result":{}}`,
		`{"protocol":"pumpd-devtools/1","id":"` + testID + `","result":{}}`,
		`{"protocol":"pumpd-devtools/1","id":"` + testID + `","ok":false,"error":{"code":"busy","message":"busy"}}`,
		`{"protocol":"pumpd-devtools/1","id":"` + testID + `","ok":true,"result":{},"extra":true}`,
	}
	for _, encoded := range failures {
		if _, err := DecodeResponse([]byte(encoded), testID); err == nil {
			t.Fatalf("expected response rejection: %s", encoded)
		}
	}
}

func TestDecodeResponseAcceptsCorrelatedAndPreparseErrors(t *testing.T) {
	for _, id := range []string{testID, ""} {
		response, err := DecodeResponse(
			[]byte(`{"protocol":"pumpd-devtools/1","id":"`+id+`","ok":false,"error":{"code":"server_busy","message":"Busy","retryable":true,"recovery":"Retry."}}`),
			testID,
		)
		if err != nil || response.OK || !response.Error.Retryable {
			t.Fatalf("DecodeResponse() = %#v, %v", response, err)
		}
	}
}
