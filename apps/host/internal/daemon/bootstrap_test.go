package daemon

import (
	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/localipc"
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestBootstrapUsesPrivateChannelAndBindsObservedHost(t *testing.T) {
	dir := testDir(t)
	listener, err := localipc.Listen(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	var calls, stops atomic.Int32
	status := testStatus()
	go func() {
		done <- ServeWithBootstrap(ctx, listener, status, func() { stops.Add(1) }, func(ctx context.Context, request *pb.BootstrapTicketRequest) (*pb.BootstrapTicketResponse, error) {
			calls.Add(1)
			if request.Origin != "https://armadra.example" {
				return nil, errors.New("private rejection details")
			}
			return &pb.BootstrapTicketResponse{HostId: status.HostId, HostInstanceId: status.HostInstanceId, Origin: request.Origin, Ticket: "test-one-time-material", ExpiresAtUnixMs: time.Now().Add(time.Minute).UnixMilli()}, nil
		})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(time.Second):
			t.Error("bootstrap control did not stop")
		}
	})
	request := &pb.BootstrapTicketRequest{ExpectedHostId: status.HostId, ExpectedInstanceId: status.HostInstanceId, Origin: "https://armadra.example", DeviceName: "phone"}
	request.ExpectedHostId = "another-host"
	if _, err := Bootstrap(ctx, dir, request); err == nil {
		t.Fatal("accepted wrong Host")
	}
	if calls.Load() != 0 {
		t.Fatal("wrong Host reached credential issuer")
	}
	request.ExpectedHostId = status.HostId
	request.ExpectedInstanceId = "old-instance"
	if _, err := Bootstrap(ctx, dir, request); err == nil {
		t.Fatal("accepted stale instance")
	}
	if calls.Load() != 0 {
		t.Fatal("stale instance reached credential issuer")
	}
	request.ExpectedInstanceId = status.HostInstanceId
	result, err := Bootstrap(ctx, dir, request)
	if err != nil || result.Ticket != "test-one-time-material" {
		t.Fatalf("bootstrap failed: %v", err)
	}
	if calls.Load() != 1 || stops.Load() != 0 {
		t.Fatal("bootstrap must issue once without stopping Host")
	}
	request.Origin = "https://other.example"
	if _, err := Bootstrap(ctx, dir, request); err == nil || err.Error() == "private rejection details" {
		t.Fatal("issuer failure was not sanitized")
	}
}

func TestBootstrapUnavailableWithoutExplicitIssuer(t *testing.T) {
	server := startServer(t, testStatus())
	_, err := Bootstrap(context.Background(), server.dir, &pb.BootstrapTicketRequest{ExpectedHostId: testStatus().HostId, ExpectedInstanceId: testStatus().HostInstanceId, Origin: "https://armadra.example", DeviceName: "phone"})
	var failure *Error
	if !errors.As(err, &failure) || failure.RemoteCode != "UNSUPPORTED" {
		t.Fatalf("unexpected default bootstrap result: %v", err)
	}
}
