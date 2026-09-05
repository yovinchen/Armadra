// Package runtimelink reaches the local Rust Runtime on behalf of an already
// authenticated device (host protocol design §5, canvas platform design H02).
//
// The Host never guesses where the Runtime is. It reads the shared
// endpoints.json both services publish (roadmap §4.4) and dials exactly what it
// finds there: a Unix domain socket, a Windows named pipe, or a loopback TCP
// port. The file is a hint, so every dial can fail and every failure is
// reported as unavailable rather than retried against a different address.
//
// Nothing in this package makes an authorization decision. The caller has
// already proven the device, its session and its grants; this package only
// carries bytes to a service that itself has no authentication.
package runtimelink

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"armadra.local/host/internal/endpoints"
)

// ErrUnavailable means no Runtime could be reached. It is deliberately the same
// error for "nothing published an address", "the address is stale" and "the
// dial failed": a device is told the execution service is not reachable, never
// which local paths were tried.
var ErrUnavailable = errors.New("the local Runtime is not reachable")

const pipePrefix = `\\.\pipe\`

// Target is one resolved Runtime address.
type Target struct {
	// Socket is an absolute Unix domain socket path, empty otherwise.
	Socket string
	// Pipe is a Windows named pipe (\\.\pipe\NAME), empty otherwise.
	Pipe string
	// Address is a loopback host:port, empty otherwise.
	Address string
}

// Origin is the origin the Runtime itself accepts for this target. The Host
// replaces the device's browser Origin with this one, so the Runtime's own
// loopback CORS predicate keeps working and never sees a remote origin.
func (t Target) Origin() string {
	if t.Address != "" {
		return "http://" + t.Address
	}
	return "http://127.0.0.1"
}

// Authority is the Host header value used upstream.
func (t Target) Authority() string {
	if t.Address != "" {
		return t.Address
	}
	return "127.0.0.1"
}

// Empty reports whether this target names no transport at all.
func (t Target) Empty() bool { return t.Socket == "" && t.Pipe == "" && t.Address == "" }

// Resolver reads one endpoints.json and dials whatever the Runtime published.
type Resolver struct {
	file string
	// A resolution is cached briefly so a burst of requests does not re-read
	// the file once per asset. It is never cached long enough to outlive a
	// Runtime restart unnoticed: every dial still proves the address, and a
	// failed dial forgets it.
	mu       sync.Mutex
	cached   Target
	cachedAt time.Time
	now      func() time.Time
	clients  clientPool
}

// New returns a resolver for the endpoints.json inside dir.
func New(dir string) *Resolver {
	return &Resolver{file: endpoints.Path(dir), now: time.Now}
}

// File is the document this resolver reads.
func (r *Resolver) File() string { return r.file }

const cacheFor = 500 * time.Millisecond

// Resolve reports where the Runtime says it is listening.
func (r *Resolver) Resolve() (Target, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.cached.Empty() && r.now().Sub(r.cachedAt) < cacheFor {
		return r.cached, nil
	}
	record := endpoints.Read(r.file).Runtime
	if record == nil {
		return Target{}, ErrUnavailable
	}
	target, err := targetOf(*record)
	if err != nil {
		return Target{}, err
	}
	r.cached, r.cachedAt = target, r.now()
	return target, nil
}

// Forget drops the cached address after a failed dial, so the next request
// re-reads the file instead of hammering an address nothing answers on.
func (r *Resolver) Forget() {
	r.mu.Lock()
	r.cached = Target{}
	r.mu.Unlock()
}

// targetOf prefers the OS-scoped transports: a socket or a pipe is reachable
// only by this user, while a TCP port is reachable by every process on the
// machine. A published TCP address that is not loopback is refused outright —
// the Host proxies to a local execution service, never onto the network.
func targetOf(record endpoints.Service) (Target, error) {
	if record.Socket != "" {
		return Target{Socket: record.Socket}, nil
	}
	if record.Pipe != "" {
		return Target{Pipe: record.Pipe}, nil
	}
	if record.HTTP == "" {
		return Target{}, ErrUnavailable
	}
	parsed, err := url.Parse(record.HTTP)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" || parsed.Path != "" {
		return Target{}, ErrUnavailable
	}
	host, port, err := net.SplitHostPort(parsed.Host)
	if err != nil || port == "" {
		return Target{}, ErrUnavailable
	}
	if host != "localhost" {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return Target{}, ErrUnavailable
		}
	}
	return Target{Address: parsed.Host}, nil
}

// Dial opens one connection to the resolved Runtime.
func (r *Resolver) Dial(ctx context.Context) (net.Conn, error) {
	target, err := r.Resolve()
	if err != nil {
		return nil, err
	}
	conn, err := Dial(ctx, target)
	if err != nil {
		r.Forget()
		return nil, err
	}
	return conn, nil
}

// Dial connects to one already resolved target.
func Dial(ctx context.Context, target Target) (net.Conn, error) {
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	switch {
	case target.Socket != "":
		conn, err := (&net.Dialer{}).DialContext(dialCtx, "unix", target.Socket)
		if err != nil {
			return nil, fmt.Errorf("%w over a socket", ErrUnavailable)
		}
		return conn, nil
	case target.Pipe != "":
		conn, err := dialPipe(dialCtx, target.Pipe)
		if err != nil {
			return nil, fmt.Errorf("%w over a pipe", ErrUnavailable)
		}
		return conn, nil
	case target.Address != "":
		conn, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", target.Address)
		if err != nil {
			return nil, fmt.Errorf("%w over loopback TCP", ErrUnavailable)
		}
		return conn, nil
	}
	return nil, ErrUnavailable
}

// pipeName rejects anything that is not rooted in the local pipe namespace, so
// a hint file cannot redirect the Host at a remote UNC path.
func pipeName(value string) (string, error) {
	rest, ok := strings.CutPrefix(value, pipePrefix)
	if !ok || rest == "" || strings.ContainsAny(rest, `\/`) {
		return "", ErrUnavailable
	}
	return value, nil
}
