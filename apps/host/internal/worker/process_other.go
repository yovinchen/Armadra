//go:build !windows

package worker

import "os/exec"

func configureProcess(_ *exec.Cmd) {}
