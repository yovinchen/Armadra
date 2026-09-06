package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/automationhost"
	"armadra.local/host/internal/canvashost"
	"armadra.local/host/internal/daemon"
	"armadra.local/host/internal/endpoints"
	"armadra.local/host/internal/eventstream"
	"armadra.local/host/internal/externalservice"
	"armadra.local/host/internal/fshost"
	"armadra.local/host/internal/githost"
	"armadra.local/host/internal/githubcred"
	"armadra.local/host/internal/githubhost"
	"armadra.local/host/internal/hoststate"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/localipc"
	"armadra.local/host/internal/migration"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/runtimelink"
	"armadra.local/host/internal/server"
	"armadra.local/host/internal/sessionhost"
	"armadra.local/host/internal/settingshost"
	"armadra.local/host/internal/storage"
	"armadra.local/host/internal/updates"
	"armadra.local/host/internal/worker"
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
	// webDir is the built front end this Host serves over its HTTPS origin.
	// Empty means the Host serves protocol routes only.
	webDir string
	// externalService is "on", "off", or empty to leave the persisted switch
	// exactly as the operator last set it. externalAddress names the interface
	// to serve; naming a non-loopback address on the command line is itself the
	// acknowledgement that this Host becomes reachable from the local network.
	externalService string
	externalAddress string
	origins         allowedOriginFlags
	output          string
	// Both must be given together to enable scheduling. Neither is inferred:
	// a Host never guesses which binary is allowed to execute the owner's work.
	workerBinary   string
	workerStateDir string
	// The Runtime executable and its database. Given together, they let a
	// serving Host move write ownership over HTTPS: the switch starts a
	// short-lived Worker from that executable to hand the epoch over. Without
	// them the record can still be read and every switch answers UNSUPPORTED,
	// rather than pretending to have told the Runtime something. They are
	// deliberately separate from the scheduling Worker: one process never both
	// runs the owner's work and moves ownership.
	runtimeBinary   string
	runtimeDatabase string
	// The Runtime's settings.json. It defaults to the file beside
	// --runtime-database, which is the Runtime's own layout; an operator whose
	// database was relocated names the real file, so a switch reads the
	// settings somebody actually edited instead of exporting defaults.
	runtimeSettings string
	// The release index this Host may consult, and the channel an operator
	// pinned it to. An unset source means update checks answer UNSUPPORTED;
	// nothing is inferred from the build (roadmap §3.12).
	updatesSource  string
	releaseChannel pb.ReleaseChannel
	// launcher records who started this Host — the desktop app, a service
	// manager, or an operator at a shell. Only its own launcher may replace
	// it, so the value is written down rather than inferred later.
	launcher string
	// Server-mode flags (install / uninstall / logs / upgrade) live in
	// service.go; only their registration and validation appear here.
	service serviceFlags
	// Write-ownership maintenance. Nothing here is inferred either: moving the
	// canvas domain names the Runtime binary and database explicitly, so the
	// command can never act on a Runtime the operator did not point it at.
	ownership ownershipConfig
}

func parseConfig(args []string) (config, error) {
	c := config{command: "serve", output: "json"}
	releaseChannel := ""
	if len(args) > 0 {
		switch args[0] {
		case "serve", "start", "status", "stop", "import", "pair", "install", "uninstall", "logs", "upgrade", "version":
			c.command = args[0]
			args = args[1:]
		case "ownership":
			c.command = args[0]
			args = args[1:]
			// The verb is positional so the command reads as an operator
			// instruction, and an unknown one is refused before any flag is
			// parsed rather than defaulting to something that changes state.
			if len(args) == 0 {
				return c, fmt.Errorf("ownership requires status, window, switch or rollback")
			}
			switch args[0] {
			case "status", "window", "switch", "rollback":
				c.ownership.action = args[0]
				args = args[1:]
			default:
				return c, fmt.Errorf("ownership requires status, window, switch or rollback")
			}
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
	if c.command == "ownership" {
		c.ownership.register(flags)
	}
	if c.command != "serve" {
		// The server-mode commands print for people first, so logs defaults to
		// plain text; every other command keeps its json default.
		if c.command == "logs" {
			c.output = "text"
		}
		flags.StringVar(&c.output, "output", c.output, "Management result format: json, protobuf or text (server-mode commands)")
	}
	c.service.register(flags, c.command)
	// install renders the same serve configuration into a service definition,
	// so it accepts and validates exactly the flags serve does.
	if c.command == "serve" || c.command == "start" || c.command == "install" {
		flags.StringVar(&c.certFile, "tls-cert", "", "TLS certificate PEM file (required for browser authentication)")
		flags.StringVar(&c.keyFile, "tls-key", "", "TLS private key PEM file")
		flags.StringVar(&c.publicOrigin, "public-origin", "", "Exact HTTPS origin clients use for this Host")
		flags.StringVar(&c.address, "listen", "127.0.0.1:43121", "Local metadata listener (loopback IP only); \"none\" serves control IPC only")
		flags.StringVar(&c.endpointsDir, "endpoints-dir", "", "Absolute directory holding the shared endpoints.json (default: the data directory)")
		flags.StringVar(&c.webDir, "serve-web", "", "Directory holding the built front end to serve on the HTTPS origin")
		flags.StringVar(&c.externalService, "external-service", "", "Turn serving other devices \"on\" or \"off\" (default: keep the saved switch)")
		flags.StringVar(&c.externalAddress, "external-address", "", "Interface IP the external service listens on (a non-loopback IP also allows the local network)")
		flags.Var(&c.origins, "allow-origin", "Exact browser origin allowed to read metadata (repeatable)")
		flags.StringVar(&c.workerBinary, "worker-binary", "", "Absolute path to the Rust Worker executable that runs scheduled commands")
		flags.StringVar(&c.workerStateDir, "worker-state-dir", "", "Absolute private directory for the Worker's own execution journal")
		flags.StringVar(&c.runtimeBinary, "runtime-binary", "", "Absolute path to the Rust Runtime executable, enabling write-ownership switches over HTTPS")
		flags.StringVar(&c.runtimeDatabase, "runtime-database", "", "Absolute path to the Runtime's database, enabling write-ownership switches over HTTPS")
		flags.StringVar(&c.runtimeSettings, "runtime-settings", "", "Absolute path to the Runtime's settings.json (default: settings.json beside --runtime-database)")
		flags.StringVar(&c.updatesSource, "updates-source", "", "Releases API base this Host may consult, e.g. https://api.github.com/repos/OWNER/REPO; unset means update checks answer UNSUPPORTED")
		flags.StringVar(&releaseChannel, "release-channel", "", "Pin update checks to a channel: stable, beta or development; unset lets the caller ask")
		flags.StringVar(&c.launcher, "launcher", "", "Who is starting this Host: desktop, service or cli (default: cli)")
	}
	// upgrade --from-release consults the same source a serving Host would, and
	// replaces the Worker alongside the Host when this deployment runs one. It
	// takes both from the command line rather than from the recorded definition
	// so an operator can see exactly which source is about to be contacted.
	if c.command == "upgrade" {
		flags.StringVar(&c.updatesSource, "updates-source", "", "Releases API base to install from, e.g. https://api.github.com/repos/OWNER/REPO")
		flags.StringVar(&c.workerBinary, "worker-binary", "", "Absolute path to the installed Worker executable, so it is replaced in the same transaction")
		flags.StringVar(&c.workerStateDir, "worker-state-dir", "", "The Worker's private state directory, when --worker-binary is given")
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
	if c.command == "ownership" {
		if err := c.ownership.normalize(); err != nil {
			return c, err
		}
	}
	if c.command == "pair" {
		normalized, err := server.ParseOrigin(c.pairOrigin)
		if err != nil || normalized != c.pairOrigin || strings.TrimSpace(c.deviceName) == "" {
			return c, fmt.Errorf("pair requires --origin EXACT_ORIGIN and --device-name NAME")
		}
	}
	if !supportedOutput(c.command, c.output) {
		return c, fmt.Errorf("unsupported output format")
	}
	if err := c.service.normalize(c.command); err != nil {
		return c, err
	}
	if err := c.origins.normalize(); err != nil {
		return c, err
	}
	if c.command == "start" || c.command == "serve" || c.command == "install" {
		// "none" is the desktop shape: the shell reaches this Host over the
		// same-user control IPC, and nothing on the machine can reach it over
		// TCP. Serving the outside world stays an explicit act.
		// "none" plus TLS is the phone-only shape: nothing is listening until
		// the operator turns the external service on, and when they do, the
		// switch owns the only listener.
		if c.address == noListener && c.certFile == "" && c.keyFile == "" && c.publicOrigin == "" {
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
			if c.address != noListener {
				host, _, err := net.SplitHostPort(c.address)
				ip := net.ParseIP(host)
				if err != nil || ip == nil || ip.IsUnspecified() {
					return c, fmt.Errorf("TLS listener requires an explicit interface IP")
				}
			}
		} else if c.address != noListener {
			if err := server.ValidateListenAddress(c.address); err != nil {
				return c, err
			}
		}
		switch c.externalService {
		case "", "on", "off":
		default:
			return c, fmt.Errorf("--external-service accepts \"on\" or \"off\"")
		}
		if c.externalAddress != "" {
			if ip := net.ParseIP(c.externalAddress); ip == nil || ip.IsUnspecified() {
				return c, fmt.Errorf("--external-address must be an explicit interface IP")
			}
		}
		if (c.externalService == "on" || c.externalAddress != "") && c.publicOrigin == "" {
			return c, fmt.Errorf("the external service requires --tls-cert, --tls-key and --public-origin")
		}
	}
	// A front end is only reachable over the authenticated HTTPS origin. Serving
	// it from a plain loopback Host would put the pairing page somewhere no
	// device can actually finish pairing from.
	if c.webDir != "" {
		if c.publicOrigin == "" {
			return c, fmt.Errorf("--serve-web requires --tls-cert, --tls-key and --public-origin")
		}
		var err error
		if c.webDir, err = filepath.Abs(c.webDir); err != nil {
			return c, err
		}
	}
	// The source is validated here so a bad one is a refusal to start. Its
	// error never repeats the value: an operator's release URL can carry a
	// token, and a startup message is exactly where one would be kept.
	if c.updatesSource != "" {
		normalized, err := updates.ParseSource(c.updatesSource)
		if err != nil {
			return c, err
		}
		c.updatesSource = normalized
	}
	switch releaseChannel {
	case "":
	case "stable":
		c.releaseChannel = pb.ReleaseChannel_RELEASE_CHANNEL_STABLE
	case "beta":
		c.releaseChannel = pb.ReleaseChannel_RELEASE_CHANNEL_BETA
	case "development":
		c.releaseChannel = pb.ReleaseChannel_RELEASE_CHANNEL_DEVELOPMENT
	default:
		return c, fmt.Errorf("--release-channel must be stable, beta or development")
	}
	if releaseChannel != "" && c.updatesSource == "" {
		return c, fmt.Errorf("--release-channel has no effect without --updates-source")
	}
	// An unset launcher is "cli": a shell is what starts a Host nobody
	// configured, and claiming otherwise would let `upgrade` refuse or proceed
	// on a record nobody wrote.
	if c.launcher == "" {
		c.launcher = hoststate.LauncherCLI
	} else if !hoststate.ValidLauncher(c.launcher) {
		return c, fmt.Errorf("--launcher accepts desktop, service or cli")
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
	// Moving ownership needs a Worker to tell the Runtime about it, so naming
	// one half without the other is a configuration that could never switch
	// anything.
	if (c.runtimeBinary == "") != (c.runtimeDatabase == "") {
		return c, fmt.Errorf("write-ownership switches require both --runtime-binary and --runtime-database")
	}
	if c.runtimeBinary != "" {
		var err error
		if c.runtimeBinary, err = filepath.Abs(c.runtimeBinary); err != nil {
			return c, err
		}
		if c.runtimeDatabase, err = filepath.Abs(c.runtimeDatabase); err != nil {
			return c, err
		}
		if c.runtimeSettings == "" {
			c.runtimeSettings = filepath.Join(filepath.Dir(c.runtimeDatabase), "settings.json")
		} else if c.runtimeSettings, err = filepath.Abs(c.runtimeSettings); err != nil {
			return c, err
		}
	} else if c.runtimeSettings != "" {
		return c, fmt.Errorf("--runtime-settings has no effect without --runtime-binary and --runtime-database")
	}
	// version reports what this binary is and touches no state, so it must not
	// depend on a resolvable per-user directory: an upgrade probes a candidate
	// in a stripped environment where no home directory is visible.
	if c.dataDir == "" && c.command != "version" {
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
	case "ownership":
		if c.ownership.action == "window" {
			return runMaintenanceWindow(ctx, c)
		}
		return runOwnership(ctx, c)
	case "start":
		return startBackground(ctx, c)
	case "status":
		return showServiceStatus(ctx, c)
	case "install":
		return installService(ctx, c)
	case "uninstall":
		return uninstallService(ctx, c)
	case "logs":
		return showLogs(ctx, c)
	case "upgrade":
		return upgradeHost(ctx, c)
	case "version":
		return showVersion(c)
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
	// Record who started this Host while it is serving, and drop the record on
	// a clean exit. `upgrade` reads it to refuse a Host the desktop app owns:
	// a stale record left by a crash refuses one upgrade too many, which is the
	// direction that cannot replace a binary somebody else is holding.
	if executable, execErr := os.Executable(); execErr == nil {
		// A config assembled in-process may leave the flag unset; a shell is
		// still the honest answer for a Host nobody claimed.
		kind := c.launcher
		if kind == "" {
			kind = hoststate.LauncherCLI
		}
		launcher := hoststate.LauncherRecord{Launcher: kind, InstanceID: identity.InstanceID, Executable: executable}
		if launcherErr := hoststate.WriteLauncher(c.dataDir, launcher); launcherErr != nil {
			return launcherErr
		}
		defer func() { err = errors.Join(err, hoststate.RemoveLauncher(c.dataDir)) }()
	}
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
	// A nil release service is the Host the operator gave no source: update
	// checks then report UNSUPPORTED instead of an answer nobody looked for.
	var releases *updates.Service
	if c.updatesSource != "" {
		releases, err = updates.New(updates.Options{Source: c.updatesSource, Channel: c.releaseChannel, ProtocolMajor: server.ProtocolMajor, ProtocolMinor: server.ProtocolMinor})
		if err != nil {
			return err
		}
	}
	plans, err := startAutomation(ctx, c, state.ID, identity.InstanceID, database)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, plans.Close()) }()
	repositories, err := startGithub(c, state.ID, database)
	if err != nil {
		return err
	}
	// The canvas surface is always assembled: it answers reads whoever owns
	// writes, and its GetOwnership is how a client learns which service it must
	// save through. Serving it is not a claim that the Host owns canvas writes.
	canvases, err := canvashost.New(canvashost.Options{Store: database, HostID: state.ID})
	if err != nil {
		return err
	}
	// The settings surface is assembled on the same terms as the canvas one:
	// it answers reads whoever owns writes, and its mutations refuse with
	// ownership_moved until this Host is the settled owner of the domain.
	settings, err := settingshost.New(settingshost.Options{Store: database, HostID: state.ID})
	if err != nil {
		return err
	}
	// The ownership record is always readable: a client has to know which side
	// writes a domain before it saves anything, and that answer must not depend
	// on this Host being able to move it. Moving it does depend on a Runtime to
	// tell, which is what the handoff opener below is.
	// The filesystem surface is assembled on the same terms as the canvas: it
	// answers reads whoever owns writes, and the proxy asks it on every
	// forwarded file request whether this Host is the one that decides.
	fileRoots, err := fshost.New(fshost.Options{Store: database, HostID: state.ID})
	if err != nil {
		return err
	}
	// The git surface is assembled on the same terms as the others: it answers
	// reads whoever owns writes, and its queue refuses with ownership_moved
	// until this Host is the settled owner. Its executor is the one part that
	// can be absent -- without a Runtime binary there is no execution host to
	// run a command on, and the surface says UNSUPPORTED rather than accepting
	// a write it could never run.
	repositoryQueue, err := githost.New(githost.Options{
		Store:    database,
		HostID:   state.ID,
		Roots:    fileRoots,
		Executor: newGitExecutor(c.runtimeBinary, state.ID),
	})
	if err != nil {
		return err
	}
	// Anything this Host left running when it stopped is settled before the
	// queue accepts anything new. An entry still marked RUNNING while a fresh
	// one is dispatched would let two writes into one checkout, which is the
	// one thing the queue exists to prevent.
	if _, err = repositoryQueue.Reconcile(ctx); err != nil {
		return err
	}
	// The session surface is assembled on the same terms as the others, with
	// one addition: it needs a way to reach the machine that holds the PTYs,
	// because deciding a session should run is worth nothing without somebody
	// to run it. A Host with no Runtime binary configured still answers every
	// read and refuses the rest with a state a client can draw, rather than
	// pretending it started something.
	openRunner := func(ctx context.Context, executionHostID string) (sessionhost.Runner, func(), error) {
		if c.runtimeBinary == "" {
			return nil, nil, sessionhost.ErrNoWorker
		}
		// Remote execution hosts are the settings domain's routing decision and
		// have no Worker of their own here yet; saying so is better than
		// silently running somebody's command on the wrong machine.
		if executionHostID != "" {
			return nil, nil, sessionhost.ErrNoWorker
		}
		client, err := worker.Start(ctx, worker.Options{
			Executable:     c.runtimeBinary,
			HostID:         state.ID,
			CanvasDatabase: c.runtimeDatabase,
			SettingsFile:   c.runtimeSettings,
			RequestTimeout: 30 * time.Second,
		})
		if err != nil {
			return nil, nil, err
		}
		return client, func() { _ = client.Close() }, nil
	}
	sessions, err := sessionhost.New(sessionhost.Options{Store: database, HostID: state.ID, Open: openRunner})
	if err != nil {
		return err
	}
	switches, err := ownership.New(ownership.Options{
		Store:      database,
		InstanceID: identity.InstanceID,
		Projectors: map[string]ownership.Projector{
			canvashost.Domain:   canvases.AsProjector(),
			settingshost.Domain: settings.AsProjector(),
			fshost.Domain:       fileRoots.AsProjector(),
			githost.Domain:      repositoryQueue.AsProjector(),
			sessionhost.Domain:  sessions.AsProjector(),
		},
		ExportRoot: filepath.Join(c.dataDir, "ownership-exports"),
	})
	if err != nil {
		return err
	}
	var openHandoff server.HandoffOpener
	if c.runtimeBinary != "" {
		openHandoff = func(ctx context.Context) (ownership.Channel, io.Closer, error) {
			// One short-lived Worker per switch. It may move an epoch and
			// nothing else: the scheduling Worker cannot, and this one cannot
			// run commands.
			client, err := worker.Start(ctx, worker.Options{
				Executable:     c.runtimeBinary,
				HostID:         state.ID,
				CanvasDatabase: c.runtimeDatabase,
				SettingsFile:   c.runtimeSettings,
				RequestTimeout: 30 * time.Second,
			})
			if err != nil {
				return nil, nil, err
			}
			return client, client, nil
		}
	}
	// The front end and the Runtime proxy are the "reach this Host from my
	// phone" half of H02. Both exist only on the authenticated HTTPS origin;
	// a mistyped bundle path fails here rather than as a 404 discovered later.
	var web *server.WebRoot
	if c.webDir != "" {
		if web, err = server.OpenWebRoot(c.webDir); err != nil {
			return err
		}
		defer func() { err = errors.Join(err, web.Close()) }()
	}
	// The Runtime publishes its own address into the same endpoints document
	// this Host writes, so no port is ever assumed.
	var link *runtimelink.Resolver
	if c.publicOrigin != "" {
		link = runtimelink.New(endpointsDir)
	}
	// The event stream replaces the client's polling loop. It reads the same
	// stored outbox the HTTPS event page reads, and it is woken by the storage
	// kernel's own commit notification, so a saved change reaches a second
	// client in the time one write takes rather than in one poll interval.
	events, err := eventstream.New(eventstream.Options{Store: database, HostID: state.ID, Projectors: []eventstream.Projector{canvashost.EventProjector{}, settingshost.EventProjector{}, fshost.EventProjector{}, githost.EventProjector{}, sessionhost.EventProjector{}}})
	if err != nil {
		return err
	}
	defer events.Close()
	database.SetCommitNotifier(events.Notify)
	options := server.Options{AllowedOrigins: c.origins, Identity: identities, PublicOrigin: c.publicOrigin, Automation: plans, GitHub: repositories, Web: web, Runtime: link, Updates: releases, Canvas: canvases, Settings: settings, Filesystem: fileRoots, Git: repositoryQueue, Sessions: sessions, Events: events, Ownership: switches, OpenHandoff: openHandoff}
	// The switch binds its own listener with the same routes. `options` is
	// captured by reference, so the manager it is about to be given is the one
	// this closure serves with.
	external := externalservice.New(c.dataDir, c.publicOrigin, tlsConfig, func(ctx context.Context, listener net.Listener) error {
		return server.ServeWithOptions(ctx, listener, identity, options)
	})
	options.External = external
	defer func() { err = errors.Join(err, external.Close()) }()
	if externalErr := applyExternalSwitch(ctx, c, external); externalErr != nil {
		// A switch that cannot bind is reported and left off. The Host keeps
		// serving whatever it already had rather than refusing to start.
		fmt.Fprintln(os.Stderr, "Armadra: could not start the external service:", externalErr)
	}
	if status := external.Status(); status.Enabled && status.BoundAddress != "" {
		fmt.Printf("Armadra serving devices on %s at %s\n", status.BoundAddress, status.PublicOrigin)
	}
	// The sessions this Host holds describe processes it did not start, and a
	// switch that ran while the Runtime was down had nobody to ask — those
	// sessions are recorded LOST, which is honest and also stale the moment a
	// Runtime comes back. So one reconciliation runs here, once, in the
	// background: it asks the execution host what it actually holds and records
	// that, which is what turns "nobody could see this" back into RUNNING or
	// EXITED without a person having to press anything.
	//
	// It is best effort by design. A Runtime that is still starting simply
	// leaves the sessions LOST for now, which a later start resolves; failing
	// to boot the Host over it would be refusing to serve five other domains
	// because one machine was slow.
	go func() {
		outcome, reclaimErr := sessions.Reclaim(ctx, "")
		switch {
		case reclaimErr != nil:
			fmt.Fprintln(os.Stderr, "Armadra: sessions could not be reconciled:", reclaimErr)
		case len(outcome.Ended)+len(outcome.Lost)+len(outcome.Regenerated) > 0:
			fmt.Printf("Armadra reconciled sessions: %d ended, %d unreachable, %d replaced\n",
				len(outcome.Ended), len(outcome.Lost), len(outcome.Regenerated))
		}
	}()
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
			finished <- server.ServeWithOptions(ctx, listener, identity, options)
		}()
	}
	go func() {
		finished <- daemon.ServeWithHandlers(ctx, control, status, cancel, daemon.Handlers{
			Maintenance: func(ctx context.Context, request *pb.MaintenanceTicketRequest) (*pb.MaintenanceTicketResponse, error) {
				// The window is opened at the machine and nowhere else. This
				// callback runs only after localipc authenticated the OS peer,
				// which is the whole reason a remote device cannot start a
				// switch however well it is authenticated over HTTPS.
				if openHandoff == nil {
					return nil, ownership.ErrUnsupportedDomain
				}
				issued, err := switches.IssueMaintenance(ctx, request.Domain)
				if err != nil {
					return nil, err
				}
				return &pb.MaintenanceTicketResponse{
					HostId:          identity.HostID,
					HostInstanceId:  identity.InstanceID,
					Token:           issued.Token,
					Domain:          issued.Domain,
					ExpiresAtUnixMs: issued.ExpiresAtMS,
				}, nil
			},
			Bootstrap: func(ctx context.Context, request *pb.BootstrapTicketRequest) (*pb.BootstrapTicketResponse, error) {
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
			},
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

// applyExternalSwitch reconciles the command line with the saved switch. With
// neither --external-service nor --external-address given, the operator's own
// last choice is restored untouched; the command line never silently widens it.
func applyExternalSwitch(ctx context.Context, c config, external *externalservice.Manager) error {
	if c.externalService == "" && c.externalAddress == "" {
		return external.Restore(ctx)
	}
	status := external.Status()
	next := externalservice.Config{Enabled: status.Enabled, Address: status.Address, Port: status.Port, AllowLAN: status.AllowLAN}
	switch c.externalService {
	case "on":
		next.Enabled = true
	case "off":
		next.Enabled = false
	}
	if c.externalAddress != "" {
		next.Address = c.externalAddress
		// Naming an interface on the command line is the acknowledgement; a
		// loopback address explicitly withdraws it again.
		next.AllowLAN = !net.ParseIP(c.externalAddress).IsLoopback()
	}
	_, err := external.Apply(ctx, next)
	return err
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

// startGithub assembles the GitHub credential service. It is always available
// — a Host with no credential configured still answers, and says so — but the
// operator can point it at a GitHub Enterprise API base and, where that base
// uses an internal certificate authority, at the roots that sign it.
//
// GITHUB_API_BASE only supplies the default for a first configuration; once a
// base has been configured through the settings page, the stored value wins.
func startGithub(c config, hostID string, database *storage.Store) (*githubhost.Service, error) {
	options := githubcred.Options{
		Store:          database,
		Secrets:        githubcred.OpenSecretStore(c.dataDir),
		DefaultAPIBase: strings.TrimSpace(os.Getenv("GITHUB_API_BASE")),
	}
	if path := strings.TrimSpace(os.Getenv("GITHUB_CA_FILE")); path != "" {
		roots, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(roots) {
			return nil, errors.New("GITHUB_CA_FILE contains no usable certificate")
		}
		// Only the roots the operator named are trusted for this base. The
		// system pool is deliberately not added: an enterprise base with a
		// private CA should not also accept a publicly issued certificate.
		options.Client.HTTP = &http.Client{
			Timeout:   30 * time.Second,
			Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}},
		}
	}
	credentials, err := githubcred.New(options)
	if err != nil {
		return nil, err
	}
	return githubhost.New(githubhost.Options{Store: database, Credentials: credentials, HostID: hostID})
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
