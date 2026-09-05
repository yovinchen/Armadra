//go:build windows

package worker

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

func dialPipe(ctx context.Context, address string) (net.Conn, error) {
	conn, err := winio.DialPipeContext(ctx, address)
	if err != nil {
		return nil, &Error{Code: CodeTransport}
	}
	return conn, nil
}
