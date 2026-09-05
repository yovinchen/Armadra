package servicedef

import "golang.org/x/sys/windows"

// currentUID has no meaning on Windows: there is no `gui/<uid>` launchd domain,
// and user-level services do not exist, so the only scope that ever reaches a
// plan here is the system one.
func currentUID() string { return "" }

// Elevated reports whether this process is running with administrator rights.
// Like its Unix counterpart it only answers the question: an operator who needs
// elevation is told to re-run the command elevated, because a program that
// elevates itself is a program that decided for them.
func Elevated() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}
