//go:build !windows

package servicedef

import (
	"os"
	"strconv"
)

// The two facts about the current process that a registration depends on, on
// Unix. The plan itself is built on every platform — the same reason the
// definition renderers are: a developer on any machine can assert what a
// launchd or systemd registration would run.

// currentUID is the user a `gui/<uid>` launchd domain names.
func currentUID() string { return strconv.Itoa(os.Getuid()) }

// Elevated reports whether this process could register a system service. It
// answers the question and never acts on it: this command does not re-run
// itself under sudo, because a program that elevates itself is a program that
// decided for the operator.
func Elevated() bool { return os.Geteuid() == 0 }
