package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/url"
	"time"
)

// TLS configuration is explicit. This never installs a certificate authority or
// changes the OS trust store. Clients must validate the configured certificate.
func LoadTLS(certFile, keyFile string) (*tls.Config, error) {
	if certFile == "" || keyFile == "" {
		return nil, errors.New("TLS requires both certificate and private key files")
	}
	certificate, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, errors.New("could not load TLS certificate and private key")
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}, nil
}

func ValidateTLSOrigin(config *tls.Config, origin string) error {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "https" || config == nil || len(config.Certificates) == 0 || len(config.Certificates[0].Certificate) == 0 {
		return errors.New("invalid TLS origin or certificate")
	}
	leaf, err := x509.ParseCertificate(config.Certificates[0].Certificate[0])
	if err != nil || leaf.VerifyHostname(parsed.Hostname()) != nil {
		return errors.New("TLS certificate does not match the public origin")
	}
	now := time.Now()
	if now.Before(leaf.NotBefore) || !now.Before(leaf.NotAfter) {
		return errors.New("TLS certificate is not currently valid")
	}
	return nil
}

// Remote listening is opt-in and requires a concrete interface IP. Wildcard
// addresses and DNS-derived interfaces are rejected rather than widened.
func ListenTLS(address string, config *tls.Config) (net.Listener, error) {
	if config == nil || len(config.Certificates) == 0 {
		return nil, errors.New("authenticated listener requires TLS")
	}
	host, _, err := net.SplitHostPort(address)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || ip.IsUnspecified() {
		return nil, errors.New("TLS listener requires an explicit interface IP")
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, err
	}
	return tls.NewListener(listener, config.Clone()), nil
}

func ServeTLS(ctx context.Context, listener net.Listener, host Identity, options Options) error {
	if options.PublicOrigin == "" {
		return errors.New("TLS service requires its exact public HTTPS origin")
	}
	return ServeWithOptions(ctx, listener, host, options)
}
