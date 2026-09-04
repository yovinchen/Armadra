package main

import (
	"os/exec"
	"syscall"
)

func setDetached(command *exec.Cmd) {
	const detachedProcess = 0x00000008
	const newProcessGroup = 0x00000200
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess | newProcessGroup, HideWindow: true}
}
