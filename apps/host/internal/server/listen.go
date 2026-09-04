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
	host, _, err := net.SplitHostPort(address)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || !ip.IsLoopback() {
		return nil, fmt.Errorf("listen address must use an explicit loopback IP")
	}
	endpoint, err := net.ResolveTCPAddr("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("invalid listen address: %w", err)
	}
	return net.ListenTCP("tcp", endpoint)
}

// Serve ends only on host shutdown, not when a client disconnects.
func Serve(ctx context.Context, listener net.Listener, identity Identity) error {
	return serve(ctx, listener, NewHandler(identity), 5*time.Second)
}

func serve(ctx context.Context, listener net.Listener, handler http.Handler, drainTimeout time.Duration) error {
	s := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    8 << 10,
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
