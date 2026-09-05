package servicedef

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"time"
)

// The registrar that actually runs a service manager.
//
// It is one small type on purpose: everything that decides *whether* to run
// something lives in register.go, where it can be tested without a service
// manager, and this file only runs what it is handed. The program name comes
// from a fixed list in that file, never from an operator's input, and there is
// no shell — an argument that looks like a shell operator is an argument.

// registerTimeout bounds one service-manager call. `systemctl enable --now`
// waits for the unit to start, so it is the longest of them.
const registerTimeout = 60 * time.Second

// maxManagerOutput caps what a service manager may print back at us.
const maxManagerOutput = 64 << 10

// SystemRegistrar runs launchctl, systemctl or sc.exe.
type SystemRegistrar struct{}

// Run executes one command with a deadline and no shell, returning what the
// manager wrote. Output is capped; a manager that floods is not buffered.
func (SystemRegistrar) Run(parent context.Context, command Command) (string, string, error) {
	if command.Program == "" {
		return "", "", fmt.Errorf("%w: no program to run", ErrRegister)
	}
	// Only the three managers this package knows how to talk to may be
	// launched. The plan builders are the only callers, but a program name is
	// the one field where a mistake becomes arbitrary execution.
	switch command.Program {
	case "launchctl", "systemctl", "sc.exe":
	default:
		return "", "", fmt.Errorf("%w: %s is not a service manager this command runs", ErrRegister, command.Program)
	}
	ctx, cancel := context.WithTimeout(parent, registerTimeout)
	defer cancel()
	process := exec.CommandContext(ctx, command.Program, command.Args...)
	process.Stdin = nil
	var out, errorOut bytes.Buffer
	process.Stdout = &limitedWriter{writer: &out, remaining: maxManagerOutput}
	process.Stderr = &limitedWriter{writer: &errorOut, remaining: maxManagerOutput}
	err := process.Run()
	return out.String(), errorOut.String(), err
}
