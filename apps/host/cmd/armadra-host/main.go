package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/automationhost"
	"armadra.local/host/internal/daemon"
	"armadra.local/host/internal/endpoints"
	"armadra.local/host/internal/hoststate"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/localipc"
	"armadra.local/host/internal/migration"
	"armadra.local/host/internal/server"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func main() {
	if err := run(os.Args[1:]); err != nil && !errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(os.Stderr, "Armadra:", err)
		os.Exit(1)
	}
}

// noListener is the --listen value that asks for no TCP surface at all: the
// Host is then reachable only over the same-user control IPC (roadmap §4.4).
const noListener = "none"

type config struct {
	certFile     string
	keyFile      string
	publicOrigin string
	pairOrigin   string
	deviceName   string
	bundle       string
	command      string
	address      string
	dataDir      string
	endpointsDir string
	origins      allowedOriginFlags
	output       string
	// Both must be given together to enable scheduling. Neither is inferred:
	// a Host never guesses which binary is allowed to execute the owner's work.
	workerBinary   string
	workerStateDir string
}

func parseConfig(args []string) (config, error) {
	c := config{command: "serve", output: "json"}
	if len(args) > 0 {
		switch args[0] {
		case "serve", "start", "status", "stop", "import", "pair":
			c.command = args[0]
			args = args[1:]
		}
	}
	flags := flag.NewFlagSet("armadra-host "+c.command, flag.ContinueOnError)
	flags.StringVar(&c.dataDir, "data-dir", "", "Host data directory (default: per-user Armadra/host)")
	if c.command == "pair" {
		flags.StringVar(&c.pairOrigin, "origin", "", "Exact browser origin to authorize")
		flags.StringVar(&c.deviceName, "device-name", "", "Name of the owner's device being paired")
	}
	if c.command == "import" {
		flags.StringVar(&c.bundle, "bundle", "", "Verified Runtime export package directory")
	}
	if c.command != "serve" {
		flags.StringVar(&c.output, "output", "json", "Management result format: json or protobuf")
	}
	if c.command == "serve" || c.command == "start" {
		flags.StringVar(&c.certFile, "tls-cert", "", "TLS certificate PEM file (required for browser authentication)")
		flags.StringVar(&c.keyFile, "tls-key", "", "TLS private key PEM file")
		flags.StringVar(&c.publicOrigin, "public-origin", "", "Exact HTTPS origin clients use for this Host")
		flags.StringVar(&c.address, "listen", "127.0.0.1:43121", "Local metadata listener (loopback IP only); \"none\" serves control IPC only")
		flags.StringVar(&c.endpointsDir, "endpoints-dir", "", "Absolute directory holding the shared endpoints.json (default: the data directory)")
		flags.Var(&c.origins, "allow-origin", "Exact browser origin allowed to read metadata (repeatable)")
		flags.StringVar(&c.workerBinary, "worker-binary", "", "Absolute path to the Rust Worker executable that runs scheduled commands")
		flags.StringVar(&c.workerStateDir, "worker-state-dir", "", "Absolute private directory for the Worker's own execution journal")
	}
	if err := flags.Parse(args); err != nil {
		return c, err
	}
	if flags.NArg() != 0 {
		return c, fmt.Errorf("unexpected positional arguments")
	}
	if c.command == "import" && c.bundle == "" {
		return c, fmt.Errorf("import requires --bundle DIRECTORY")
	}
	if c.command == "pair" {
		normalized, err := server.ParseOrigin(c.pairOrigin)
		if err != nil || normalized != c.pairOrigin || strings.TrimSpace(c.deviceName) == "" {
			return c, fmt.Errorf("pair requires --origin EXACT_ORIGIN and --device-name NAME")
		}
	}
	if c.output != "json" && c.output != "protobuf" {
		return c, fmt.Errorf("unsupported output format")
	}
	if err := c.origins.normalize(); err != nil {
		return c, err
	}
	if c.command == "start" || c.command == "serve" {
		// "none" is the desktop shape: the shell reaches this Host over the
		// same-user control IPC, and nothing on the machine can reach it over
		// TCP. Serving the outside world stays an explicit act.
		if c.address == noListener {
			if c.certFile != "" || c.keyFile != "" || c.publicOrigin != "" {
				return c, fmt.Errorf("TLS requires a --listen address")
			}
			if len(c.origins) != 0 {
				return c, fmt.Errorf("--allow-origin has no effect without a --listen address")
			}
		} else if c.certFile != "" || c.keyFile != "" || c.publicOrigin != "" {
			origin, err := server.ParseOrigin(c.publicOrigin)
			if err != nil || origin != c.publicOrigin || !strings.HasPrefix(origin, "https://") {
				return c, fmt.Errorf("TLS requires an exact --public-origin HTTPS_ORIGIN")
			}
			config, loadErr := server.LoadTLS(c.certFile, c.keyFile)
			if loadErr != nil {
				return c, loadErr
			}
			if err = server.ValidateTLSOrigin(config, c.publicOrigin); err != nil {
				return c, err
			}
			c.certFile, err = filepath.Abs(c.certFile)
			if err != nil {
				return c, err
			}
			c.keyFile, err = filepath.Abs(c.keyFile)
			if err != nil {
				return c, err
			}
			host, _, err := net.SplitHostPort(c.address)
			ip := net.ParseIP(host)
			if err != nil || ip == nil || ip.IsUnspecified() {
				return c, fmt.Errorf("TLS listener requires an explicit interface IP")
			}
		} else if err := server.ValidateListenAddress(c.address); err != nil {
			return c, err
		}
	}
	if (c.workerBinary == "") != (c.workerStateDir == "") {
		return c, fmt.Errorf("scheduled execution requires both --worker-binary and --worker-state-dir")
	}
	if c.workerBinary != "" {
		var err error
		if c.workerBinary, err = filepath.Abs(c.workerBinary); err != nil {
			return c, err
		}
		if c.workerStateDir, err = filepath.Abs(c.workerStateDir); err != nil {
			return c, err
		}
	}
	if c.dataDir == "" {
		var err error
		c.dataDir, err = hoststate.DefaultDir()
		if err != nil {
			return c, err
		}
	}
	var err error
	if c.dataDir, err = filepath.Abs(c.dataDir); err != nil {
		return c, err
	}
	// The shared endpoints file normally lives beside the Host's own data. The
	// desktop points it at the Runtime's data directory instead, so both
	// services describe themselves in one document. A relative path is refused
	// rather than resolved against whatever the working directory happens to be.
	if c.endpointsDir == "" {
		c.endpointsDir = c.dataDir
	} else if !filepath.IsAbs(c.endpointsDir) {
		return c, fmt.Errorf("--endpoints-dir must be an absolute directory")
	}
	c.endpointsDir = filepath.Clean(c.endpointsDir)
	return c, nil
}

func run(args []string) error {
	c, err := parseConfig(args)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch c.command {
	case "pair":
		return pairDevice(ctx, c)
	case "import":
		return importBundle(ctx, c)
	case "start":
		return startBackground(ctx, c)
	case "status":
		return showStatus(ctx, c.dataDir, c.output)
	case "stop":
		return stopBackground(ctx, c.dataDir, c.output)
	default:
		return serveHost(ctx, c)
	}
}

func serveHost(parent context.Context, c config) (err error) {
	var tlsConfig *tls.Config
	if c.publicOrigin != "" {
		tlsConfig, err = server.LoadTLS(c.certFile, c.keyFile)
		if err != nil {
			return err
		}
		if err = server.ValidateTLSOrigin(tlsConfig, c.publicOrigin); err != nil {
			return err
		}
	}
	state, err := acquireState(parent, c.dataDir)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := state.Close(); err == nil {
			err = closeErr
		}
	}()
	database, err := storage.Open(c.dataDir, state.ID)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, database.Close()) }()
	// A Host with no --listen address answers only on the same-user control
	// IPC below. That is the desktop shape: no port for anything on the machine
	// to find, and no browser surface until the operator asks for one.
	var listener net.Listener
	if c.address != noListener {
		if tlsConfig != nil {
			listener, err = server.ListenTLS(c.address, tlsConfig)
		} else {
			listener, err = server.ListenLocal(c.address)
		}
		if err != nil {
			return err
		}
		defer listener.Close()
	}
	control, err := localipc.Listen(c.dataDir)
	if err != nil {
		return err
	}
	defer control.Close()
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return err
	}
	identity := server.Identity{HostID: state.ID, InstanceID: hex.EncodeToString(id[:])}
	identities, err := auth.New(database, auth.Config{InstanceID: identity.InstanceID})
	if err != nil {
		return err
	}
	status := &pb.HostStatus{HostId: state.ID, HostInstanceId: identity.InstanceID, StartedAtUnixMs: time.Now().UnixMilli(), ProcessId: uint32(os.Getpid())}
	if listener != nil {
		status.HttpEndpoint = "http://" + listener.Addr().String()
	}
	if c.publicOrigin != "" {
		status.HttpEndpoint = c.publicOrigin
	}
	// Publish the address we actually bound, never the one we were asked for:
	// --listen :0 means the kernel chose it, and a reader has no other way to
	// learn the number. An unwritable directory is logged, not fatal.
	// parseConfig always fills this in; a config built by hand must still never
	// resolve the file against whatever the working directory happens to be.
	endpointsDir := c.endpointsDir
	if endpointsDir == "" {
		endpointsDir = c.dataDir
	}
	endpointsFile := endpoints.Path(endpointsDir)
	record := endpoints.Now(identity.InstanceID)
	record.HTTP = status.HttpEndpoint
	if endpoint, ipcErr := localipc.Endpoint(c.dataDir); ipcErr == nil {
		if runtime.GOOS == "windows" {
			record.Pipe = endpoint
		} else {
			record.Socket = endpoint
		}
	}
	if publishErr := endpoints.Publish(endpointsFile, endpoints.HostService, record); publishErr != nil {
		fmt.Fprintln(os.Stderr, "Armadra: could not publish the Host endpoint:", publishErr)
	} else {
		defer func() { err = errors.Join(err, endpoints.Withdraw(endpointsFile, endpoints.HostService)) }()
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	// The schedule loop and its Worker are stopped before the database and the
	// directory lock: cancelling ctx ends the loop, then this deferred Close
	// shuts the Worker down and reports whether its children were reclaimed.
	plans, err := startAutomation(ctx, c, state.ID, identity.InstanceID, database)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, plans.Close()) }()
	workers := 1
	if listener != nil {
		workers++
	}
	if plans != nil {
		workers++
	}
	finished := make(chan error, workers)
	if plans != nil {
		go func() { finished <- plans.Run(ctx) }()
	}
	if listener != nil {
		go func() {
			finished <- server.ServeWithOptions(ctx, listener, identity, server.Options{AllowedOrigins: c.origins, Identity: identities, PublicOrigin: c.publicOrigin, Automation: plans})
		}()
	}
	go func() {
		finished <- daemon.ServeWithBootstrap(ctx, control, status, cancel, func(ctx context.Context, request *pb.BootstrapTicketRequest) (*pb.BootstrapTicketResponse, error) {
			if c.publicOrigin == "" || request.Origin != c.publicOrigin {
				return nil, auth.ErrPermission
			}
			scopes := make([]auth.Scope, 0, len(request.Scopes))
			for _, scope := range request.Scopes {
				if scope == nil {
					return nil, auth.ErrInvalid
				}
				scopes = append(scopes, auth.Scope{Permission: scope.Permission, WorkspaceID: scope.WorkspaceId, ExecutionHostID: scope.ExecutionHostId})
			}
			ticket, err := identities.IssueBootstrap(ctx, auth.BootstrapRequest{HostID: request.ExpectedHostId, InstanceID: request.ExpectedInstanceId, Origin: request.Origin, DeviceName: request.DeviceName, Scopes: scopes})
			if err != nil {
				return nil, err
			}
			return &pb.BootstrapTicketResponse{HostId: identity.HostID, HostInstanceId: identity.InstanceID, Ticket: ticket.Ticket, Origin: request.Origin, ExpiresAtUnixMs: ticket.ExpiresAtMS}, nil
		})
	}()
	if listener != nil {
		fmt.Printf("Armadra listening on %s\n", status.HttpEndpoint)
	} else {
		fmt.Printf("Armadra serving control IPC only for host %s\n", state.ID)
	}
	if plans != nil {
		fmt.Printf("Armadra scheduling commands on host %s\n", state.ID)
	}
	failures := []error{<-finished}
	cancel()
	for range workers - 1 {
		failures = append(failures, <-finished)
	}
	return errors.Join(failures...)
}

// startAutomation returns nil when the operator did not configure an execution
// Worker. Scheduling is then unsupported and every other Host function keeps
// working; a half-configured pair is rejected earlier, in parseConfig.
func startAutomation(ctx context.Context, c config, hostID, instanceID string, database *storage.Store) (*automationhost.Service, error) {
	options := automationhost.Options{Executable: c.workerBinary, StateDir: c.workerStateDir, HostID: hostID, InstanceID: instanceID, Store: database}
	if !automationhost.Configured(options) {
		return nil, nil
	}
	if err := os.MkdirAll(c.workerStateDir, 0700); err != nil {
		return nil, err
	}
	if err := storage.ProtectArtifactDirectory(c.workerStateDir); err != nil {
		return nil, err
	}
	return automationhost.New(ctx, options)
}

// Only an explicit local pair command emits one-time material to stdout.
// Access and refresh credentials are never returned by this command.
func pairDevice(ctx context.Context, c config) error {
	status, err := daemon.Status(ctx, c.dataDir)
	if err != nil {
		return err
	}
	scopes := []*pb.AuthorizationGrant{}
	for _, scope := range auth.AllScopes() {
		scopes = append(scopes, &pb.AuthorizationGrant{Permission: scope.Permission})
	}
	ticket, err := daemon.Bootstrap(ctx, c.dataDir, &pb.BootstrapTicketRequest{ExpectedHostId: status.HostId, ExpectedInstanceId: status.HostInstanceId, Origin: c.pairOrigin, DeviceName: c.deviceName, Scopes: scopes})
	if err != nil {
		return err
	}
	var data []byte
	if c.output == "protobuf" {
		data, err = proto.Marshal(ticket)
	} else {
		data, err = (protojson.MarshalOptions{Indent: "  "}).Marshal(ticket)
		data = append(data, '\n')
	}
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(data)
	return err
}

// A read-only ownership probe briefly locks the same file. Retry a short busy
// interval so it cannot make a new serve process mistake the probe for a Host.
func acquireState(ctx context.Context, dir string) (*hoststate.State, error) {
	deadline := time.NewTimer(250 * time.Millisecond)
	defer deadline.Stop()
	for {
		state, err := hoststate.Open(dir)
		if !errors.Is(err, hoststate.ErrLocked) {
			return state, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline.C:
			return nil, hoststate.ErrLocked
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// Collect first, validate before state/listener I/O. flag.Parse would echo the
// rejected flag value (potential credentials) if Set returned its parse error.
type allowedOriginFlags []string

func (values *allowedOriginFlags) String() string { return strings.Join(*values, ", ") }
func (values *allowedOriginFlags) Set(value string) error {
	*values = append(*values, value)
	return nil
}
func (values *allowedOriginFlags) normalize() error {
	for index, value := range *values {
		normalized, err := server.ParseOrigin(value)
		if err != nil {
			return err
		}
		(*values)[index] = normalized
	}
	return nil
}

// Import is an offline maintenance command: a running Host keeps its directory
// lock and prevents a second writer. Imported records remain in staging.
func importBundle(ctx context.Context, c config) error {
	bundle, err := migration.Inspect(ctx, c.bundle)
	if err != nil {
		return err
	}
	state, err := hoststate.Open(c.dataDir)
	if err != nil {
		return err
	}
	defer state.Close()
	database, err := storage.Open(c.dataDir, state.ID)
	if err != nil {
		return err
	}
	defer database.Close()
	report, err := migration.Stage(ctx, database, bundle)
	if err != nil {
		return err
	}
	var data []byte
	if c.output == "protobuf" {
		data, err = proto.Marshal(report)
	} else {
		data, err = (protojson.MarshalOptions{Indent: "  "}).Marshal(report)
		data = append(data, '\n')
	}
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(data)
	return err
}
