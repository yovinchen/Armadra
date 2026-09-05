//go:build !windows

package runtimelink

import (
	"context"
	"net"
)

// A named pipe is a Windows object. Reporting it as unreachable keeps the
// failure identical to every other dial failure on this platform, rather than
// inventing a fallback address the Runtime never published.
func dialPipe(_ context.Context, name string) (net.Conn, error) {
	if _, err := pipeName(name); err != nil {
		return nil, err
	}
	return nil, ErrUnavailable
}
