//go:build windows

package localipc

import (
	"context"
	"testing"
	"time"
)

// This test must run on Windows to validate the actual handle/security APIs.
// Cross-compilation alone does not establish that these calls succeed at runtime.
func TestWindowsSameUserPipeIdentity(t *testing.T) {
	dir := t.TempDir()
	listener, err := Listen(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan error, 1)
	release := make(chan struct{})
	defer close(release)
	go func() {
		conn, err := listener.Accept()
		if conn != nil {
			defer conn.Close()
		}
		accepted <- err
		if err == nil {
			<-release
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := Dial(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if err := <-accepted; err != nil {
		t.Fatal(err)
	}
}
