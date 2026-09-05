package worker

import (
	"context"
	"errors"
	"net"
	"path/filepath"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
)

// The channel's second bearer, from the Host's side (business migration §2.9,
// 承载 ②).
//
// stdio only exists for a Worker this process started. A Host that restarts
// while its Worker keeps running has no pipe to it any more — and that is
// exactly when the Worker's outbox has a replay to deliver. The Worker
// publishes a private local socket in its handshake; this dials it and speaks
// the identical frames.
//
// The address comes from the Worker's own handshake record, never from a
// caller: a path supplied by a request would let one choose which process the
// Host attached to. It is validated as an absolute path inside the state
// directory the operator configured, so a Worker cannot redirect the Host at
// something else either.

// ErrNoBearer means this Worker published no socket to reattach over. It is a
// statement about the Worker, not a failure of the Host: a Worker started
// without a state directory has no outbox and therefore nothing to reattach to.
var ErrNoBearer = errors.New("the Worker published no upcall bearer")

// BearerAddress reports the local address the Worker published for its resident
// channel, having checked it names something inside `stateDir`.
//
// A record that names an address outside the configured state directory is
// refused rather than dialled: the whole reason this bearer is safe is that
// reaching it already requires the filesystem access reaching the command
// journal requires.
func BearerAddress(channel *pb.WorkerChannelCapability, stateDir string) (string, error) {
	if channel == nil {
		return "", ErrNoBearer
	}
	if pipe := channel.GetPipe(); pipe != "" {
		// A pipe lives in the local pipe namespace, not the filesystem, so the
		// containment check is the namespace prefix and the absence of any
		// further separator that could redirect it at a remote UNC path.
		rest, ok := strings.CutPrefix(pipe, `\\.\pipe\`)
		if !ok || rest == "" || strings.ContainsAny(rest, `\/`) {
			return "", ErrNoBearer
		}
		return pipe, nil
	}
	socket := channel.GetSocket()
	if socket == "" || !filepath.IsAbs(socket) || strings.IndexByte(socket, 0) >= 0 {
		return "", ErrNoBearer
	}
	if stateDir != "" {
		resolved, err := filepath.EvalSymlinks(stateDir)
		if err != nil {
			return "", ErrNoBearer
		}
		if filepath.Dir(filepath.Clean(socket)) != filepath.Clean(resolved) {
			return "", ErrNoBearer
		}
	}
	return socket, nil
}

// DialBearer opens one connection to a published bearer.
//
// The returned connection speaks the same framing as stdio: kind-tagged frames,
// requests and responses on kind 0, upcalls and their replies on 1 and 2.
func DialBearer(ctx context.Context, address string) (net.Conn, error) {
	if address == "" {
		return nil, ErrNoBearer
	}
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	network := "unix"
	if strings.HasPrefix(address, `\\.\pipe\`) {
		return dialPipe(dialCtx, address)
	}
	conn, err := (&net.Dialer{}).DialContext(dialCtx, network, address)
	if err != nil {
		return nil, &Error{Code: CodeTransport}
	}
	return conn, nil
}
