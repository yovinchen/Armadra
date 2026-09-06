// Command-line configuration for the Host: the flag set, its validation, and
// the collected values every subcommand runs against.

package main

import (
	"flag"
	"fmt"
	"net"
	"path/filepath"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/hoststate"
	"armadra.local/host/internal/server"
	"armadra.local/host/internal/updates"
)

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
