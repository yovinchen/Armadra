package worker

import (
	"context"
	"os"
)

// A command-mode Worker must be attached before its first handshake. Stop and
// Wait concern only this client's owned process tree, never a PID from a DB.
type containment interface {
	Attach(*os.Process) error
	Stop() error
	Wait(context.Context) error
	Close() error
}
