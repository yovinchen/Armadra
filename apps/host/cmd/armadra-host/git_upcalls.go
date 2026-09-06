package main

import (
	"context"
	"fmt"
	"sync/atomic"

	"armadra.local/host/internal/githost"
	"armadra.local/host/internal/worker"
)

// The sink that turns a Worker's git report into a record a client already
// follows (§2.9 上行帧 180, Git 设计 §10).
//
// It is deliberately thin. Everything about *what* a report may change — which
// entries may still move, which values may go backwards, which reports settle
// something and which only decorate it — is decided in `githost`, beside the
// records themselves; this only routes the frame and translates a refusal into
// the disposition the channel needs.
// The service is stored rather than passed to the constructor because the
// three depend on each other in a circle: the service needs the executor, the
// executor needs this sink, and this sink needs the service. Breaking it here
// is the smallest cut — and it is an atomic rather than a plain field because
// the reader is the channel's pump, on another goroutine.
type gitUpcallSink struct {
	service atomic.Pointer[githost.Service]
}

// attach names the service every later report lands in. It is called once,
// immediately after the service is built and before anything can have started a
// Worker, so no report can arrive before it.
func (s *gitUpcallSink) attach(service *githost.Service) {
	s.service.Store(service)
}

// Deliver records one report, and returns only once it is durable: the
// acknowledgement the Host sends next is what lets the Worker forget it.
//
// A frame with no git payload is refused *permanently*. That is not the same as
// dropping it: a Worker whose reports this Host can never accept would otherwise
// replay them forever, and there is nothing to replay them for.
func (s *gitUpcallSink) Deliver(ctx context.Context, upcall worker.Upcall) error {
	frame := upcall.Frame.GetGit()
	if frame == nil {
		return fmt.Errorf("the upcall carries no git report: %w", worker.ErrUpcallUnacceptable)
	}
	service := s.service.Load()
	if service == nil {
		// No git service on this Host. The report is accepted and discarded
		// rather than retried: there is nowhere for it to land, and refusing it
		// would only make the Worker hold it.
		return nil
	}
	return service.ApplyUpcall(ctx, frame)
}
