//go:build !windows

package worker

import (
	"context"
	"net"
)

// A named pipe is a Windows object. Reporting it as unreachable keeps the
// failure identical to every other dial failure on this platform, rather than
// inventing a fallback address the Worker never published.
func dialPipe(context.Context, string) (net.Conn, error) {
	return nil, ErrNoBearer
}
