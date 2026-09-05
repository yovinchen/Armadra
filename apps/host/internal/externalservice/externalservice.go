// Package externalservice owns the "serve to my other devices" switch
// (canvas platform design §3 H02, host protocol design §5).
//
// A Host listens on loopback and nothing else until an operator turns this on.
// Turning it on binds one extra TLS listener on a named interface address; the
// loopback --listen surface is untouched, so the desktop shell keeps working
// whether or not phones can reach the machine. Turning it off closes that
// listener, and every device stream on it ends with the connection.
//
// Three rules are enforced here rather than left to the caller:
//
//   - external serving requires the configured HTTPS origin and certificate.
//     There is no plaintext remote mode to fall back to;
//   - the listen address is an explicit interface IP. A wildcard is refused,
//     never widened, and a non-loopback address additionally requires the
//     operator to have said "allow LAN";
//   - the port must be the one the public origin names, because that is the
//     origin the certificate, the cookies and the pairing ticket are bound to.
package externalservice

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

// Version is bumped only when an older Host could no longer read the document.
const Version = 1

// Name is the file inside the Host data directory.
const Name = "external-service.json"

// ErrUnsupported means this Host was started without HTTPS, so remote devices
// can never reach it however the switch is set.
var ErrUnsupported = errors.New("external service requires a configured HTTPS origin")

// ErrInvalid is a rejected configuration.
var ErrInvalid = errors.New("invalid external service configuration")

// Config is the persisted switch.
type Config struct {
	Version int    `json:"version"`
	Enabled bool   `json:"enabled"`
	Address string `json:"address"`
	Port    int    `json:"port"`
	// AllowLAN must be set before a non-loopback interface address is accepted.
	// It is a separate acknowledgement, not an inference from the address.
	AllowLAN bool `json:"allowLan"`
}

// Status is what the settings page shows.
type Status struct {
	Config
	// Supported is false when the Host has no HTTPS origin; the switch is then
	// visible but cannot be turned on.
	Supported bool
	// PublicOrigin is the exact origin devices must use.
	PublicOrigin string
	// BoundAddress is the address actually being served, empty when off.
	BoundAddress string
	// Interfaces are the non-loopback IPv4 addresses this machine has, offered
	// as choices. They are reported, never bound without being chosen.
	Interfaces []string
}

// Path returns the configuration file inside dir.
func Path(dir string) string { return filepath.Join(dir, Name) }

// Serve runs one accepted listener until ctx ends.
type Serve func(ctx context.Context, listener net.Listener) error

// Manager binds and unbinds the external listener.
type Manager struct {
	file         string
	tls          *tls.Config
	publicOrigin string
	serve        Serve

	mu       sync.Mutex
	config   Config
	listener net.Listener
	stop     context.CancelFunc
	done     chan struct{}
	parent   context.Context
}

// New reads the persisted switch. A missing or unreadable document means off:
// the Host must never start serving the network because a file was corrupt.
// The switch is not applied here — call Restore once the Host is ready.
func New(dir, publicOrigin string, config *tls.Config, serve Serve) *Manager {
	manager := &Manager{file: Path(dir), tls: config, publicOrigin: publicOrigin, serve: serve}
	manager.config = read(manager.file)
	if publicOrigin == "" {
		manager.config.Enabled = false
	}
	return manager
}

func read(path string) Config {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{Version: Version}
	}
	var config Config
	if err = json.Unmarshal(data, &config); err != nil || config.Version > Version {
		return Config{Version: Version}
	}
	config.Version = Version
	return config
}

// Restore binds the listener if the persisted switch is on. A bind failure is
// reported and leaves the switch off rather than retried on another address.
func (m *Manager) Restore(ctx context.Context) error {
	m.mu.Lock()
	m.parent = ctx
	config := m.config
	m.mu.Unlock()
	if !config.Enabled {
		return nil
	}
	_, err := m.Apply(ctx, config)
	return err
}

// Status reports the current switch without changing it.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	status := Status{Config: m.config, Supported: m.publicOrigin != "" && m.tls != nil, PublicOrigin: m.publicOrigin, Interfaces: interfaces()}
	if m.listener != nil {
		status.BoundAddress = m.listener.Addr().String()
	}
	if status.Port == 0 {
		status.Port = originPort(m.publicOrigin)
	}
	if status.Address == "" {
		status.Address = "127.0.0.1"
	}
	return status
}

// Apply validates, persists and rebinds. The persisted document is written only
// after the listener the operator asked for is actually accepting, so a saved
// "on" never describes a Host that failed to bind.
func (m *Manager) Apply(ctx context.Context, next Config) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.parent == nil {
		m.parent = ctx
	}
	next.Version = Version
	if next.Enabled {
		if m.publicOrigin == "" || m.tls == nil {
			return m.statusLocked(), ErrUnsupported
		}
		if err := m.validate(next); err != nil {
			return m.statusLocked(), err
		}
	}
	// The device that flips this switch is very often connected through the
	// listener being closed. Closing the listener frees the port immediately,
	// but its in-flight handlers — this one included — keep draining, so this
	// must not wait for them: waiting here would deadlock on ourselves and the
	// operator would see a dropped connection instead of an answer.
	m.closeLocked(false)
	if next.Enabled {
		listener, err := listenTLS(net.JoinHostPort(next.Address, strconv.Itoa(next.Port)), m.tls)
		if err != nil {
			return m.statusLocked(), err
		}
		serveCtx, cancel := context.WithCancel(m.parent)
		done := make(chan struct{})
		m.listener, m.stop, m.done = listener, cancel, done
		go func() {
			defer close(done)
			_ = m.serve(serveCtx, listener)
		}()
	}
	m.config = next
	if err := write(m.file, next); err != nil {
		return m.statusLocked(), err
	}
	return m.statusLocked(), nil
}

func (m *Manager) statusLocked() Status {
	status := Status{Config: m.config, Supported: m.publicOrigin != "" && m.tls != nil, PublicOrigin: m.publicOrigin, Interfaces: interfaces()}
	if m.listener != nil {
		status.BoundAddress = m.listener.Addr().String()
	}
	if status.Port == 0 {
		status.Port = originPort(m.publicOrigin)
	}
	if status.Address == "" {
		status.Address = "127.0.0.1"
	}
	return status
}

// Close stops serving. It does not change the persisted switch: a Host that is
// shutting down has not been turned off by anybody.
func (m *Manager) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closeLocked(true)
	return nil
}

// closeLocked releases the port. `drain` additionally waits for the listener's
// handlers to finish, which is what process shutdown wants and what a request
// arriving on that same listener must never ask for.
func (m *Manager) closeLocked(drain bool) {
	if m.stop != nil {
		m.stop()
	}
	if m.listener != nil {
		_ = m.listener.Close()
	}
	if drain && m.done != nil {
		<-m.done
	}
	m.listener, m.stop, m.done = nil, nil, nil
}

func (m *Manager) validate(config Config) error {
	ip := net.ParseIP(config.Address)
	if ip == nil || ip.IsUnspecified() || ip.IsMulticast() {
		return fmt.Errorf("%w: the listen address must be an explicit interface IP", ErrInvalid)
	}
	if !ip.IsLoopback() && !config.AllowLAN {
		return fmt.Errorf("%w: serving a network interface needs the local-network acknowledgement", ErrInvalid)
	}
	if !ip.IsLoopback() && !ip.IsPrivate() && !ip.IsLinkLocalUnicast() {
		return fmt.Errorf("%w: only loopback and private network addresses may be served", ErrInvalid)
	}
	expected := originPort(m.publicOrigin)
	if config.Port < 1 || config.Port > 65535 {
		return fmt.Errorf("%w: the port must be between 1 and 65535", ErrInvalid)
	}
	if expected != 0 && config.Port != expected {
		return fmt.Errorf("%w: devices reach this Host at %s, so the port must be %d", ErrInvalid, m.publicOrigin, expected)
	}
	return nil
}

func listenTLS(address string, config *tls.Config) (net.Listener, error) {
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("%w: could not listen on %s", ErrInvalid, address)
	}
	return tls.NewListener(listener, config.Clone()), nil
}

func write(path string, config Config) error {
	body, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	temporary, err := os.CreateTemp(filepath.Dir(path), ".external-service-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err = temporary.Chmod(0600); err != nil {
		temporary.Close()
		return err
	}
	if _, err = temporary.Write(body); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func originPort(origin string) int {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "https" {
		return 0
	}
	if port := parsed.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil {
			return 0
		}
		return number
	}
	return 443
}

// interfaces lists the private IPv4 addresses a phone on the same network could
// reach. Public addresses are deliberately not offered.
func interfaces() []string {
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	result := []string{}
	for _, address := range addresses {
		network, ok := address.(*net.IPNet)
		if !ok {
			continue
		}
		ip := network.IP.To4()
		if ip == nil || ip.IsLoopback() || !ip.IsPrivate() {
			continue
		}
		result = append(result, ip.String())
	}
	return result
}
