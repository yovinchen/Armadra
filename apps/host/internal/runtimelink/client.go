package runtimelink

import (
	"context"
	"net"
	"net/http"
	"sync"
	"time"
)

// Client returns an HTTP client bound to one resolved target. Connections are
// pooled per target, so a socket path or port that changes after a Runtime
// restart gets a new pool rather than reusing dead connections.
//
// There is no client timeout: a proxied request is already bounded by the
// device's own request context, and a file import or a clone poll must not be
// cut off by a number chosen here.
func (r *Resolver) Client(target Target) *http.Client {
	key := target.Socket + "\x00" + target.Pipe + "\x00" + target.Address
	r.clients.mu.Lock()
	defer r.clients.mu.Unlock()
	if r.clients.byTarget == nil {
		r.clients.byTarget = map[string]*http.Client{}
	}
	if existing, ok := r.clients.byTarget[key]; ok {
		return existing
	}
	// One pool per resolver keeps the map from growing without bound while a
	// Runtime flaps: only the newest target is kept.
	for previous, client := range r.clients.byTarget {
		if previous != key {
			client.CloseIdleConnections()
			delete(r.clients.byTarget, previous)
		}
	}
	dialTarget := target
	client := &http.Client{
		// A proxied redirect is the Runtime's answer, not something the Host
		// should follow on the device's behalf.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return Dial(ctx, dialTarget)
			},
			MaxIdleConns:          16,
			IdleConnTimeout:       30 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
			DisableCompression:    true,
		},
	}
	r.clients.byTarget[key] = client
	return client
}

type clientPool struct {
	mu       sync.Mutex
	byTarget map[string]*http.Client
}
