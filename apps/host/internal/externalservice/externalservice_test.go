package externalservice

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"math/big"
	"net"
	"strconv"
	"testing"
	"time"
)

func fixtureTLS(t *testing.T) *tls.Config {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "external fixture"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
}

func freePort(t *testing.T) int {
	t.Helper()
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Close()
	return probe.Addr().(*net.TCPAddr).Port
}

// accepted records that the switch handed a listener to the Host's own server.
func accepting(served chan<- string) Serve {
	return func(ctx context.Context, listener net.Listener) error {
		served <- listener.Addr().String()
		<-ctx.Done()
		return listener.Close()
	}
}

func TestTheSwitchIsOffUntilItIsTurnedOnAndSurvivesARestart(t *testing.T) {
	directory := t.TempDir()
	port := freePort(t)
	origin := "https://127.0.0.1:" + strconv.Itoa(port)
	served := make(chan string, 4)
	manager := New(directory, origin, fixtureTLS(t), accepting(served))
	t.Cleanup(func() { _ = manager.Close() })
	if status := manager.Status(); status.Enabled || !status.Supported || status.Port != port {
		t.Fatalf("a fresh Host started with %+v", status)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := manager.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case address := <-served:
		t.Fatalf("a Host with the switch off listened on %s", address)
	case <-time.After(150 * time.Millisecond):
	}
	status, err := manager.Apply(ctx, Config{Enabled: true, Address: "127.0.0.1", Port: port})
	if err != nil || status.BoundAddress == "" {
		t.Fatalf("turning the switch on failed: %v %+v", err, status)
	}
	if address := <-served; address != status.BoundAddress {
		t.Fatalf("the switch served %s but reported %s", address, status.BoundAddress)
	}

	// A second Host reading the same data directory starts serving again,
	// because the operator's own choice is what persisted.
	restarted := New(directory, origin, fixtureTLS(t), accepting(served))
	t.Cleanup(func() { _ = restarted.Close() })
	if !restarted.Status().Enabled {
		t.Fatal("the saved switch was not restored")
	}
	// The original still holds the port, so the restore reports rather than
	// silently moving to a different one.
	if err = restarted.Restore(ctx); err == nil {
		t.Fatal("a second Host bound a port that was already taken")
	}

	if _, err = manager.Apply(ctx, Config{Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if _, err = net.DialTimeout("tcp", status.BoundAddress, 200*time.Millisecond); err == nil {
		t.Fatal("the listener stayed open after the switch was turned off")
	}
}

func TestTheSwitchRefusesAddressesTheOperatorDidNotAcknowledge(t *testing.T) {
	directory := t.TempDir()
	port := freePort(t)
	origin := "https://127.0.0.1:" + strconv.Itoa(port)
	served := make(chan string, 2)
	manager := New(directory, origin, fixtureTLS(t), accepting(served))
	t.Cleanup(func() { _ = manager.Close() })
	ctx := context.Background()
	for _, config := range []Config{
		{Enabled: true, Address: "0.0.0.0", Port: port},
		{Enabled: true, Address: "", Port: port},
		{Enabled: true, Address: "not-an-ip", Port: port},
		{Enabled: true, Address: "192.168.1.20", Port: port, AllowLAN: false},
		{Enabled: true, Address: "203.0.113.5", Port: port, AllowLAN: true},
		{Enabled: true, Address: "127.0.0.1", Port: port + 1},
		{Enabled: true, Address: "127.0.0.1", Port: 0},
	} {
		if _, err := manager.Apply(ctx, config); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%+v was accepted", config)
		}
		if manager.Status().Enabled {
			t.Fatalf("%+v left the switch on", config)
		}
	}
}

func TestAHostWithoutHTTPSCannotServeDevices(t *testing.T) {
	manager := New(t.TempDir(), "", nil, accepting(make(chan string, 1)))
	t.Cleanup(func() { _ = manager.Close() })
	if status := manager.Status(); status.Supported {
		t.Fatal("a plain HTTP Host reported that it can serve devices")
	}
	if _, err := manager.Apply(context.Background(), Config{Enabled: true, Address: "127.0.0.1", Port: 8443}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("a plain HTTP Host accepted the switch: %v", err)
	}
}
