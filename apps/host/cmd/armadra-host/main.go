package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/daemon"
	"armadra.local/host/internal/hoststate"
	"armadra.local/host/internal/localipc"
	"armadra.local/host/internal/migration"
	"armadra.local/host/internal/server"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func main() {
	if err := run(os.Args[1:]); err != nil && !errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(os.Stderr, "armadra-host:", err)
		os.Exit(1)
	}
}

type config struct {
	bundle  string
	command string
	address string
	dataDir string
	origins allowedOriginFlags
	output  string
}

func parseConfig(args []string) (config, error) {
	c := config{command: "serve", output: "json"}
	if len(args) > 0 {
		switch args[0] {
		case "serve", "start", "status", "stop", "import":
			c.command = args[0]
			args = args[1:]
		}
	}
	flags := flag.NewFlagSet("armadra-host "+c.command, flag.ContinueOnError)
	flags.StringVar(&c.dataDir, "data-dir", "", "Host data directory (default: per-user Armadra/host)")
	if c.command == "import" {
		flags.StringVar(&c.bundle, "bundle", "", "Verified Runtime export package directory")
	}
	if c.command != "serve" {
		flags.StringVar(&c.output, "output", "json", "Management result format: json or protobuf")
	}
	if c.command == "serve" || c.command == "start" {
		flags.StringVar(&c.address, "listen", "127.0.0.1:43121", "Local metadata listener (loopback IP only)")
		flags.Var(&c.origins, "allow-origin", "Exact browser origin allowed to read metadata (repeatable)")
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
	if c.output != "json" && c.output != "protobuf" {
		return c, fmt.Errorf("unsupported output format")
	}
	if err := c.origins.normalize(); err != nil {
		return c, err
	}
	if c.command == "start" || c.command == "serve" {
		if err := server.ValidateListenAddress(c.address); err != nil {
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
	c.dataDir, err = filepath.Abs(c.dataDir)
	return c, err
}

func run(args []string) error {
	c, err := parseConfig(args)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch c.command {
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
	listener, err := server.ListenLocal(c.address)
	if err != nil {
		return err
	}
	defer listener.Close()
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
	status := &pb.HostStatus{HostId: state.ID, HostInstanceId: identity.InstanceID, HttpEndpoint: "http://" + listener.Addr().String(), StartedAtUnixMs: time.Now().UnixMilli(), ProcessId: uint32(os.Getpid())}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	finished := make(chan error, 2)
	go func() {
		finished <- server.ServeWithOptions(ctx, listener, identity, server.Options{AllowedOrigins: c.origins})
	}()
	go func() { finished <- daemon.Serve(ctx, control, status, cancel) }()
	fmt.Printf("armadra-host listening on %s\n", status.HttpEndpoint)
	first := <-finished
	cancel()
	second := <-finished
	return errors.Join(first, second)
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
