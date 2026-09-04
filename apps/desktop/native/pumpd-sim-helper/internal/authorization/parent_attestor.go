package authorization

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	expectedBrokerName       = "pumpd-native-host"
	expectedBrokerIdentifier = "pumpd-native-host"
	expectedHelperIdentifier = "pumpd-sim-helper"
	expectedTeamIdentifier   = "434X69L4Z5"
)

type SystemParentAttestor struct{}

func (SystemParentAttestor) Attest(ctx context.Context, parentPID int) error {
	if runtime.GOOS != "darwin" {
		return errors.New("mutation broker attestation is supported only on macOS")
	}
	if parentPID <= 1 || os.Getppid() != parentPID {
		return errors.New("parent identity changed before attestation")
	}

	helperPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve helper executable: %w", err)
	}
	helperPath, err = filepath.EvalSymlinks(helperPath)
	if err != nil {
		return fmt.Errorf("canonicalize helper executable: %w", err)
	}

	attestationContext, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	parentPath, err := processPath(attestationContext, parentPID)
	if err != nil {
		return err
	}
	parentPath, err = filepath.EvalSymlinks(parentPath)
	if err != nil {
		return fmt.Errorf("canonicalize broker executable: %w", err)
	}
	if filepath.Base(parentPath) != expectedBrokerName || filepath.Dir(parentPath) != filepath.Dir(helperPath) {
		return errors.New("parent is not the packaged sibling mutation broker")
	}
	parentBefore, err := os.Stat(parentPath)
	if err != nil || !parentBefore.Mode().IsRegular() {
		return errors.New("broker executable is not a regular file")
	}

	if err := verifyLiveCode(attestationContext, parentPID, expectedBrokerIdentifier, execCombinedOutput); err != nil {
		return fmt.Errorf("verify live broker signature: %w", err)
	}
	if err := verifyLiveCode(attestationContext, os.Getpid(), expectedHelperIdentifier, execCombinedOutput); err != nil {
		return fmt.Errorf("verify live helper signature: %w", err)
	}
	if os.Getppid() != parentPID {
		return errors.New("parent identity changed during attestation")
	}
	confirmedPath, err := processPath(attestationContext, parentPID)
	if err != nil {
		return err
	}
	confirmedPath, err = filepath.EvalSymlinks(confirmedPath)
	if err != nil || confirmedPath != parentPath {
		return errors.New("parent executable changed during attestation")
	}
	parentAfter, err := os.Stat(parentPath)
	if err != nil || !os.SameFile(parentBefore, parentAfter) {
		return errors.New("broker executable identity changed during attestation")
	}
	return nil
}

func processPath(ctx context.Context, pid int) (string, error) {
	output, err := exec.CommandContext(ctx, "/bin/ps", "-ww", "-p", fmt.Sprint(pid), "-o", "comm=").Output()
	if err != nil {
		return "", fmt.Errorf("read parent executable: %w", err)
	}
	path := strings.TrimSpace(string(output))
	if !filepath.IsAbs(path) || strings.ContainsRune(path, '\n') {
		return "", errors.New("parent executable path is invalid")
	}
	return path, nil
}

type combinedOutputRunner func(context.Context, string, ...string) ([]byte, error)

func execCombinedOutput(ctx context.Context, executable string, arguments ...string) ([]byte, error) {
	return exec.CommandContext(ctx, executable, arguments...).CombinedOutput()
}

func verifyLiveCode(ctx context.Context, pid int, identifier string, run combinedOutputRunner) error {
	if pid <= 1 || (identifier != expectedBrokerIdentifier && identifier != expectedHelperIdentifier) {
		return errors.New("live code identity is invalid")
	}
	requirement := fmt.Sprintf(
		`anchor apple generic and identifier %q and certificate leaf[subject.OU] = %q`,
		identifier,
		expectedTeamIdentifier,
	)
	output, err := run(
		ctx,
		"/usr/bin/codesign",
		"--verify",
		"--strict",
		"--verbose=2",
		"-R="+requirement,
		"+"+strconv.Itoa(pid),
	)
	if err != nil {
		return fmt.Errorf("live codesign requirement failed: %s", strings.TrimSpace(string(output)))
	}
	return nil
}
