package servicedef

import "os"

// verifyOwner is not used on Windows: file ownership there is an ACL question
// that os.FileInfo does not answer, and claiming otherwise would be worse than
// saying nothing. VerifyCandidate skips the Unix permission checks on this
// platform and the operator's own directory ACLs remain the control.
func verifyOwner(os.FileInfo) error { return nil }

// probeEnvironment keeps the candidate's execution environment minimal while
// still giving Windows the one variable a process needs to start.
func probeEnvironment() []string {
	if root := os.Getenv("SystemRoot"); root != "" {
		return []string{"SystemRoot=" + root}
	}
	return []string{}
}
