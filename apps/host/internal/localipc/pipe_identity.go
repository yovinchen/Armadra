package localipc

import (
	"errors"
	"net"
	"os"
	"runtime"
)

const localSystemSID = "S-1-5-18"

func pipePrincipalAllowed(current, actual string) bool {
	return current != "" && actual != "" && (actual == current || actual == localSystemSID)
}

// checkedPipeConnection authenticates before exposing the connected stream or
// writing any control frame. The inspector must use this exact handle, never
// open another connection to the same predictable pipe name.
func checkedPipeConnection(conn net.Conn, current string, inspect func(uintptr) (owner, process string, err error)) (net.Conn, error) {
	reject := func(err error) (net.Conn, error) {
		_ = conn.Close()
		return nil, errors.Join(os.ErrPermission, err)
	}
	fd, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return reject(errors.Join(ErrUnsupported, errors.New("pipe connection does not expose a verifiable handle")))
	}
	handle := fd.Fd()
	if handle == 0 || handle == ^uintptr(0) {
		return reject(errors.New("pipe connection handle is invalid"))
	}
	owner, process, err := inspect(handle)
	runtime.KeepAlive(conn)
	if err != nil {
		return reject(errors.Join(errors.New("cannot verify local pipe server identity"), err))
	}
	if !pipePrincipalAllowed(current, owner) || !pipePrincipalAllowed(current, process) {
		return reject(errors.New("local pipe server owner or process belongs to a different principal"))
	}
	return conn, nil
}
