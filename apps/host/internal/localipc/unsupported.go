//go:build !darwin && !linux && !freebsd && !openbsd && !netbsd && !dragonfly && !windows

package localipc

import (
	"context"
	"net"
)

func Endpoint(string) (string, error)                { return "", ErrUnsupported }
func Listen(string) (net.Listener, error)            { return nil, ErrUnsupported }
func Dial(context.Context, string) (net.Conn, error) { return nil, ErrUnsupported }
