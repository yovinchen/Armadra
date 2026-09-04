//go:build windows

package localipc

import (
	"context"
	"errors"
	"net"
	"os"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func currentSID() (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

func canonicalWindowsDir(dataDir string) (string, error) {
	canonical, err := resolveDataDir(dataDir)
	if err != nil {
		return "", err
	}
	path, err := windows.UTF16PtrFromString(canonical)
	if err != nil {
		return "", err
	}
	handle, err := windows.CreateFile(path, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)
	// Final-path-by-handle resolves junctions, short names and path aliases using
	// the actual directory object rather than lowercasing potentially distinct names.
	buffer := make([]uint16, 512)
	for {
		size, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
		if err != nil {
			return "", err
		}
		if int(size) < len(buffer) {
			return windows.UTF16ToString(buffer[:size]), nil
		}
		buffer = make([]uint16, size+1)
	}
}

func Endpoint(dataDir string) (string, error) {
	canonical, err := canonicalWindowsDir(dataDir)
	if err != nil {
		return "", err
	}
	sid, err := currentSID()
	if err != nil {
		return "", err
	}
	return `\\.\pipe\armadra-host-` + sid + "-" + endpointHash(canonical, sid), nil
}

func Listen(dataDir string) (net.Listener, error) {
	endpoint, err := Endpoint(dataDir)
	if err != nil {
		return nil, err
	}
	sid, err := currentSID()
	if err != nil {
		return nil, err
	}
	// Protected DACL contains only LocalSystem and this user. Pinned go-winio
	// v0.6.2 unconditionally sets FILE_PIPE_REJECT_REMOTE_CLIENTS in pipe.go's
	// makeServerPipeHandle and creates the first instance exclusively.
	return winio.ListenPipe(endpoint, &winio.PipeConfig{
		SecurityDescriptor: "O:" + sid + "D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")",
		MessageMode:        false, InputBufferSize: 65536, OutputBufferSize: 65536,
	})
}

func Dial(ctx context.Context, dataDir string) (net.Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	endpoint, err := Endpoint(dataDir)
	if err != nil {
		return nil, unavailable(err)
	}
	conn, err := winio.DialPipeContext(ctx, endpoint)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) || errors.Is(err, os.ErrNotExist) {
		return nil, errors.Join(ErrNotRunning, err)
	}
	if err != nil {
		return nil, err
	}
	current, err := currentSID()
	if err != nil {
		conn.Close()
		return nil, errors.Join(os.ErrPermission, err)
	}
	verified, err := checkedPipeConnection(conn, current, inspectPipeServer)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		verified.Close()
		return nil, err
	}
	return verified, nil
}

// inspectPipeServer queries the already connected pipe. The owner check remains
// attached to that object, so a dead server's recycled PID cannot authenticate
// another user's pipe by happening to name an unrelated trusted process.
func inspectPipeServer(raw uintptr) (ownerSID, processSID string, err error) {
	pipe := windows.Handle(raw)
	descriptor, err := windows.GetSecurityInfo(pipe, windows.SE_KERNEL_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return "", "", err
	}
	owner, _, err := descriptor.Owner()
	if err != nil {
		return "", "", err
	}
	if owner == nil {
		return "", "", errors.New("pipe has no owner SID")
	}
	ownerSID = owner.String()
	var pid uint32
	if err := windows.GetNamedPipeServerProcessId(pipe, &pid); err != nil {
		return "", "", err
	}
	if pid == 0 {
		return "", "", errors.New("pipe has no server process")
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", "", err
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return "", "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", "", err
	}
	var exitCode uint32
	if err := windows.GetExitCodeProcess(process, &exitCode); err != nil {
		return "", "", err
	}
	const stillActive = 259
	if exitCode != stillActive {
		return "", "", errors.New("pipe server process has exited")
	}
	return ownerSID, user.User.Sid.String(), nil
}
