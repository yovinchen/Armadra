//go:build !windows

package worker

// Unix commands have detached Rust guardians holding the state lock; EOF on
// their private Worker-owned pipe terminates each ordinary process group.
func newContainment(_ bool) (containment, error) { return nil, nil }
