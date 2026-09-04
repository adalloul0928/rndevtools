package client

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/avadtechnologies/pumpd-devtools-cli/internal/protocol"
)

const testID = "cli-0123456789abcdef0123456789abcdef"

func TestClientRoundTrip(t *testing.T) {
	socketPath, serverErrors := testServer(t, func(connection net.Conn) error {
		defer connection.Close()
		line, err := bufio.NewReader(connection).ReadString('\n')
		if err != nil {
			return err
		}
		var request protocol.Request
		if err := json.Unmarshal([]byte(strings.TrimSuffix(line, "\n")), &request); err != nil {
			return err
		}
		_, err = connection.Write([]byte(
			`{"protocol":"pumpd-devtools/1","id":"` + request.ID + `","ok":true,"result":{"healthy":true}}` + "\n",
		))
		return err
	})
	localClient, err := New(socketPath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	response, err := localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	if err != nil || !response.OK {
		t.Fatalf("Do() = %#v, %v", response, err)
	}
	if err := <-serverErrors; err != nil {
		t.Fatal(err)
	}
}

func TestClientHalfClosesAfterExactlyOneRequestBeforeReadingResponse(t *testing.T) {
	socketPath, serverErrors := testServer(t, func(connection net.Conn) error {
		defer connection.Close()
		if _, err := bufio.NewReader(connection).ReadString('\n'); err != nil {
			return err
		}
		if err := connection.SetReadDeadline(time.Now().Add(25 * time.Millisecond)); err != nil {
			return err
		}
		buffer := make([]byte, 1)
		_, err := connection.Read(buffer)
		if !errors.Is(err, io.EOF) {
			return fmt.Errorf("expected the client write half to close: %w", err)
		}
		return writeAllForTest(connection, []byte(
			`{"protocol":"pumpd-devtools/1","id":"`+testID+`","ok":true,"result":{}}`+"\n",
		))
	})
	localClient, err := New(socketPath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	response, err := localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	if err != nil || !response.OK {
		t.Fatalf("Do() = %#v, %v", response, err)
	}
	if err := <-serverErrors; err != nil {
		t.Fatal(err)
	}
}

func TestClientRejectsPublicOrNonSocketPaths(t *testing.T) {
	directory := t.TempDir()
	filePath := filepath.Join(directory, "not-a-socket")
	if err := os.WriteFile(filePath, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	localClient, _ := New(filePath, time.Second)
	_, err := localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	assertClientError(t, err, ErrorUnavailable)

	socketPath, _ := testServer(t, func(connection net.Conn) error {
		return connection.Close()
	})
	if err := os.Chmod(socketPath, 0o666); err != nil {
		t.Fatal(err)
	}
	localClient, _ = New(socketPath, time.Second)
	_, err = localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	assertClientError(t, err, ErrorUnavailable)

	socketPath, _ = testServer(t, func(connection net.Conn) error {
		return connection.Close()
	})
	symlinkPath := filepath.Join(filepath.Dir(socketPath), "linked.sock")
	if err := os.Symlink(socketPath, symlinkPath); err != nil {
		t.Fatal(err)
	}
	localClient, _ = New(symlinkPath, time.Second)
	_, err = localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	assertClientError(t, err, ErrorUnavailable)

	socketPath, _ = testServer(t, func(connection net.Conn) error {
		return connection.Close()
	})
	if err := os.Chmod(filepath.Dir(socketPath), 0o755); err != nil {
		t.Fatal(err)
	}
	localClient, _ = New(socketPath, time.Second)
	_, err = localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	assertClientError(t, err, ErrorUnavailable)
}

func TestClientReportsStaleSocketAndTimeout(t *testing.T) {
	directory := shortTempDir(t)
	stalePath := filepath.Join(directory, "stale.sock")
	address := &net.UnixAddr{Name: stalePath, Net: "unix"}
	listener, err := net.ListenUnix("unix", address)
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	if err := os.Chmod(stalePath, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	localClient, _ := New(stalePath, time.Second)
	_, err = localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	assertClientError(t, err, ErrorUnavailable)

	socketPath, _ := testServer(t, func(connection net.Conn) error {
		defer connection.Close()
		time.Sleep(500 * time.Millisecond)
		return nil
	})
	localClient, _ = New(socketPath, 50*time.Millisecond)
	_, err = localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	assertClientError(t, err, ErrorTimeout)
}

func testServer(t *testing.T, handler func(net.Conn) error) (string, <-chan error) {
	t.Helper()
	socketPath := filepath.Join(shortTempDir(t), "pumpd-devtools.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	errors_ := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			if !errors.Is(err, net.ErrClosed) {
				errors_ <- err
			}
			return
		}
		errors_ <- handler(connection)
	}()
	return socketPath, errors_
}

func shortTempDir(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("", "pd-cli-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	return directory
}

func assertClientError(t *testing.T, err error, kind ErrorKind) {
	t.Helper()
	var clientError *ClientError
	if !errors.As(err, &clientError) || clientError.Kind != kind {
		t.Fatalf("error = %v, want kind %s", err, kind)
	}
}

func writeAllForTest(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		written, err := writer.Write(data)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		data = data[written:]
	}
	return nil
}
