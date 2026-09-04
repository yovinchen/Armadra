package localipc

import (
	"errors"
	"io"
	"net"
	"os"
	"testing"
)

type pipeHandleConn struct {
	net.Conn
	handle uintptr
	closed bool
}

func (c *pipeHandleConn) Fd() uintptr  { return c.handle }
func (c *pipeHandleConn) Close() error { c.closed = true; return c.Conn.Close() }

func TestPipeServerIdentityBeforeExposingConnection(t *testing.T) {
	const current = "S-1-5-21-100-200-300-1001"
	const other = "S-1-5-21-100-200-300-1002"
	for _, tc := range []struct {
		name, owner, process string
		queryErr             error
		allowed              bool
	}{
		{name: "same user", owner: current, process: current, allowed: true},
		{name: "system", owner: localSystemSID, process: localSystemSID, allowed: true},
		{name: "system process with user owner", owner: current, process: localSystemSID, allowed: true},
		{name: "other user", owner: other, process: other},
		{name: "recycled trusted PID on foreign pipe", owner: other, process: current},
		{name: "foreign process on trusted owner", owner: current, process: other},
		{name: "missing owner", process: current},
		{name: "query denied", queryErr: os.ErrPermission},
		{name: "query missing must not be not-running", queryErr: os.ErrNotExist},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()
			connection := &pipeHandleConn{Conn: client, handle: 123}
			called := 0
			result, err := checkedPipeConnection(connection, current, func(handle uintptr) (string, string, error) {
				called++
				if handle != 123 {
					t.Fatal("inspected a different handle")
				}
				return tc.owner, tc.process, tc.queryErr
			})
			if called != 1 {
				t.Fatalf("inspector calls %d", called)
			}
			if tc.allowed {
				if err != nil || result != connection || connection.closed {
					t.Fatalf("valid connection rejected: %v", err)
				}
			} else {
				if result != nil || !errors.Is(err, os.ErrPermission) || !connection.closed {
					t.Fatalf("unverified connection exposed: %v", err)
				}
				if errors.Is(err, ErrNotRunning) {
					t.Fatal("identity failure was marked not running")
				}
			}
		})
	}
}

func TestPipeWithoutVerifiableHandleFailsClosed(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	result, err := checkedPipeConnection(client, "S-1-5-21-1", func(uintptr) (string, string, error) { t.Fatal("unexpected query"); return "", "", nil })
	if result != nil || !errors.Is(err, ErrUnsupported) || !errors.Is(err, os.ErrPermission) {
		t.Fatalf("missing handle: %v", err)
	}
	if _, err := client.Write([]byte("must be closed")); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("connection left open: %v", err)
	}
}
