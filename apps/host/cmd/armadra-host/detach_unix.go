//go:build darwin || linux || freebsd || openbsd || netbsd || dragonfly

package main

import (
	"os/exec"
	"syscall"
)

func setDetached(command *exec.Cmd) { command.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
