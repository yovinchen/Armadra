package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"time"
)

// ListenLocal intentionally rejects wildcard and DNS names until the authenticated
// remote-host surface exists. Port zero is supported for isolated tests/probes.
func ListenLocal(address string) (net.Listener, error) {
	endpoint, err := localAddress(address)
	if err != nil {
		return nil, err
	}
	return net.ListenTCP("tcp", endpoint)
}

// ValidateListenAddress performs no listening or filesystem I/O.
func ValidateListenAddress(address string) error {
	_, err := localAddress(address)
	return err
}

func localAddress(address string) (*net.TCPAddr, error) {
	host, _, err := net.SplitHostPort(address)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || !ip.IsLoopback() {
		return nil, fmt.Errorf("listen address must use an explicit loopback IP")
	}
	endpoint, err := net.ResolveTCPAddr("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("invalid listen address: %w", err)
	}
	return endpoint, nil
}

// Serve ends only on host shutdown, not when a client disconnects.
func Serve(ctx context.Context, listener net.Listener, identity Identity) error {
	return serve(ctx, listener, NewHandler(identity), 5*time.Second, false)
}

// ServeWithOptions serves the same metadata routes with explicit browser origins.
func ServeWithOptions(ctx context.Context, listener net.Listener, identity Identity, options Options) error {
	handler, err := NewHandlerWithOptions(identity, options)
	if err != nil {
		return err
	}
	return serve(ctx, listener, handler, 5*time.Second, options.Runtime != nil)
}

// streaming relaxes the whole-request deadlines. A terminal attached from a
// phone lives for hours and a file import can take minutes, so a Host that
// forwards to the Runtime bounds the header read and the idle connection
// instead of the exchange. A metadata-only Host keeps the tighter limits.
func serve(ctx context.Context, listener net.Listener, handler http.Handler, drainTimeout time.Duration, streaming bool) error {
	s := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    8 << 10,
	}
	if streaming {
		s.ReadTimeout, s.WriteTimeout = 0, 0
		s.IdleTimeout = 120 * time.Second
	}
	stopped := make(chan struct{})
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		select {
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), drainTimeout)
			defer cancel()
			if err := s.Shutdown(shutdown); err != nil {
				_ = s.Close()
			}
		case <-stopped:
		}
	}()
	err := s.Serve(listener)
	close(stopped)
	// Serve returns as soon as Shutdown closes the listener, before its active
	// handlers have drained. Keep main alive until the shutdown completes.
	<-shutdownDone
	if err == http.ErrServerClosed {
		return nil
	}
	_ = s.Close()
	return err
}
