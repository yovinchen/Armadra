package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/daemon"
	"armadra.local/host/internal/server"
	"google.golang.org/protobuf/proto"
)

func TestPairCLIHelper(t *testing.T) {
	input := os.Getenv("ARMADRA_TEST_PAIR_ARGUMENTS")
	if input == "" {
		return
	}
	var args []string
	if json.Unmarshal([]byte(input), &args) != nil {
		os.Exit(2)
	}
	if err := run(args); err != nil {
		os.Exit(3)
	}
	os.Exit(0)
}

func pairProcess(t *testing.T, args []string) ([]byte, error) {
	t.Helper()
	input, _ := json.Marshal(args)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPairCLIHelper$")
	child.Env = append(os.Environ(), "ARMADRA_TEST_PAIR_ARGUMENTS="+string(input))
	return child.Output()
}

func startPairHost(t *testing.T, c config) *pb.HostStatus {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serveHost(ctx, c) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("Host did not stop")
		}
	})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if status, err := daemon.Status(ctx, c.dataDir); err == nil {
			return status
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("Host private control did not become ready")
	return nil
}

func TestPairCLIAndHTTPSUseTheSameBoundHost(t *testing.T) {
	fixture := httptest.NewTLSServer(http.NotFoundHandler())
	certificate := fixture.TLS.Certificates[0]
	leaf := fixture.Certificate()
	fixture.Close()
	key, err := x509.MarshalPKCS8PrivateKey(certificate.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	certPath, keyPath := filepath.Join(directory, "cert.pem"), filepath.Join(directory, "key.pem")
	if err = os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]}), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0600); err != nil {
		t.Fatal(err)
	}
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := probe.Addr().String()
	probe.Close()
	origin := "https://" + address
	c, err := parseConfig([]string{"serve", "--data-dir", filepath.Join(directory, "host"), "--listen", address, "--tls-cert", certPath, "--tls-key", keyPath, "--public-origin", origin})
	if err != nil {
		t.Fatal(err)
	}
	status := startPairHost(t, c)
	wire, err := pairProcess(t, []string{"pair", "--data-dir", c.dataDir, "--origin", origin, "--device-name", "手机", "--output", "protobuf"})
	if err != nil {
		t.Fatal("pair subprocess failed")
	}
	ticket := new(pb.BootstrapTicketResponse)
	if proto.Unmarshal(wire, ticket) != nil || ticket.HostId != status.HostId || ticket.HostInstanceId != status.HostInstanceId || ticket.Origin != origin || ticket.Ticket == "" {
		t.Fatal("CLI returned an invalid bound ticket")
	}
	roots := x509.NewCertPool()
	roots.AddCert(leaf)
	jar, _ := cookiejar.New(nil)
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Jar: jar, Timeout: 3 * time.Second}
	request := func(path string, input proto.Message) *http.Response {
		t.Helper()
		data, _ := proto.Marshal(input)
		req, _ := http.NewRequest("POST", origin+server.AuthPrefix+path, bytes.NewReader(data))
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", server.MediaType)
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	response := request("Pair", &pb.PairDeviceRequest{ExpectedHostId: status.HostId, ExpectedInstanceId: status.HostInstanceId, Ticket: ticket.Ticket})
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	session := new(pb.AuthenticatedSession)
	if response.StatusCode != 200 || proto.Unmarshal(body, session) != nil || session.Device.DisplayName != "手机" {
		t.Fatal("HTTPS did not consume CLI ticket")
	}
	response = request("Current", &pb.CurrentSessionRequest{})
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("secure cookies did not restore session")
	}
	if _, err = pairProcess(t, []string{"pair", "--data-dir", c.dataDir, "--origin", "https://other.example", "--device-name", "other"}); err == nil {
		t.Fatal("issued ticket for an unavailable origin")
	}
}

func TestPlainHTTPHostRefusesBrowserPairing(t *testing.T) {
	c := config{dataDir: t.TempDir(), address: "127.0.0.1:0"}
	startPairHost(t, c)
	if _, err := pairProcess(t, []string{"pair", "--data-dir", c.dataDir, "--origin", "https://armadra.example", "--device-name", "phone"}); err == nil {
		t.Fatal("HTTP-only Host issued unusable cookie credentials")
	}
}
