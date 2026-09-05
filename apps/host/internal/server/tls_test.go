package server

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func fixtureTLSFiles(t *testing.T) (string, string, *x509.CertPool) {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "isolated host fixture"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	directory := t.TempDir()
	certPath := filepath.Join(directory, "fixture certificate.pem")
	keyPath := filepath.Join(directory, "fixture private key.pem")
	if err = os.WriteFile(certPath, certPEM, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(keyPath, keyPEM, 0600); err != nil {
		t.Fatal(err)
	}
	// This pool exists only in the test client; no OS or user's trust is changed.
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(certPEM) {
		t.Fatal("fixture certificate failed to parse")
	}
	return certPath, keyPath, pool
}

func TestLoadTLSRequiresMatchingExplicitCertificateAndKey(t *testing.T) {
	cert, key, _ := fixtureTLSFiles(t)
	config, err := LoadTLS(cert, key)
	if err != nil {
		t.Fatal(err)
	}
	if config.MinVersion < tls.VersionTLS12 || len(config.Certificates) != 1 || config.InsecureSkipVerify {
		t.Fatal("unsafe loaded TLS settings")
	}
	for _, origin := range []string{"https://localhost:43121", "https://127.0.0.1:43121", "https://[::1]:43121"} {
		if err := ValidateTLSOrigin(config, origin); err != nil {
			t.Fatalf("matching certificate origin rejected: %v", err)
		}
	}
	for _, origin := range []string{"http://localhost:43121", "https://other.example:43121", "not-an-origin"} {
		if err := ValidateTLSOrigin(config, origin); err == nil {
			t.Fatal("invalid/mismatched TLS origin accepted")
		}
	}
	if err := ValidateTLSOrigin(nil, "https://localhost:43121"); err == nil {
		t.Fatal("missing TLS config accepted")
	}
	otherCert, otherKey, _ := fixtureTLSFiles(t)
	for _, pair := range [][2]string{{"", ""}, {cert, ""}, {"", key}, {cert, otherKey}, {otherCert, key}, {filepath.Join(t.TempDir(), "missing"), key}, {key, cert}} {
		if value, err := LoadTLS(pair[0], pair[1]); err == nil || value != nil {
			t.Fatal("missing, mismatched or malformed certificate/key accepted")
		}
	}
}

func TestListenTLSRequiresTLSAndExplicitInterface(t *testing.T) {
	cert, key, _ := fixtureTLSFiles(t)
	config, err := LoadTLS(cert, key)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []*tls.Config{nil, {}} {
		if listener, err := ListenTLS("127.0.0.1:0", value); err == nil {
			listener.Close()
			t.Fatal("listener accepted missing TLS certificate")
		}
	}
	for _, address := range []string{"0.0.0.0:0", "[::]:0", ":0", "localhost:0", "127.0.0.1", "not-an-address"} {
		if listener, err := ListenTLS(address, config); err == nil {
			listener.Close()
			t.Fatalf("unsafe listener accepted %q", address)
		}
	}
	listener, err := ListenTLS("127.0.0.1:0", config)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if !listener.Addr().(*net.TCPAddr).IP.IsLoopback() {
		t.Fatal("isolated TLS listener widened its interface")
	}
}

func TestServeTLSUsesFixtureTrustAndExactPublicAuthority(t *testing.T) {
	cert, key, pool := fixtureTLSFiles(t)
	config, err := LoadTLS(cert, key)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := ListenTLS("127.0.0.1:0", config)
	if err != nil {
		t.Fatal(err)
	}
	origin := "https://" + listener.Addr().String()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- ServeTLS(ctx, listener, Identity{HostID: authHost, InstanceID: authInstance}, Options{PublicOrigin: origin})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(3 * time.Second):
			listener.Close()
			t.Error("TLS service did not stop")
		}
	})
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	for _, test := range []struct {
		host, origin string
		status       int
	}{{listener.Addr().String(), origin, 200}, {"localhost:9", origin, 403}, {listener.Addr().String(), "https://evil.example", 403}} {
		request, err := http.NewRequest("GET", origin+"/health", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Host = test.host
		request.Header.Set("Origin", test.origin)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_, err = io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != test.status || response.TLS == nil || len(response.TLS.VerifiedChains) == 0 {
			t.Fatalf("HTTPS authority status=%d want=%d", response.StatusCode, test.status)
		}
	}
	// A valid certificate's DNS/IP identity is still checked against the target.
	parsed, err := x509.ParseCertificate(config.Certificates[0].Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if _, err = parsed.Verify(x509.VerifyOptions{DNSName: "other.example", Roots: pool}); err == nil {
		t.Fatal("fixture trust disabled hostname validation")
	}
}

func TestPublicOriginConfigurationIsExplicitCanonicalHTTPS(t *testing.T) {
	for _, origin := range []string{"http://127.0.0.1:43121", "https://example.test/", "https://user:secret@example.test", "https://example.test?key=secret", "https://example.test#secret", "https://*.example.test", "https://EXAMPLE.test", "https://example.test:443", "null"} {
		if handler, err := NewHandlerWithOptions(Identity{}, Options{PublicOrigin: origin}); err == nil || handler != nil {
			t.Fatal("invalid public origin configuration accepted")
		}
	}
	cert, key, _ := fixtureTLSFiles(t)
	config, err := LoadTLS(cert, key)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := ListenTLS("127.0.0.1:0", config)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err = ServeTLS(context.Background(), listener, Identity{}, Options{}); err == nil {
		t.Fatal("TLS service accepted no public origin")
	}
}
