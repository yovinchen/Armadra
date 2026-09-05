//go:build windows

package runtimelink

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

func dialPipe(ctx context.Context, name string) (net.Conn, error) {
	address, err := pipeName(name)
	if err != nil {
		return nil, err
	}
	return winio.DialPipeContext(ctx, address)
}
