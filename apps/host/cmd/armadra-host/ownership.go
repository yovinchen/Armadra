package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/agenthost"
	"armadra.local/host/internal/canvashost"
	"armadra.local/host/internal/daemon"
	"armadra.local/host/internal/fshost"
	"armadra.local/host/internal/githost"
	"armadra.local/host/internal/hoststate"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/sessionhost"
	"armadra.local/host/internal/settingshost"
	"armadra.local/host/internal/storage"
	"armadra.local/host/internal/worker"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// `armadra-host ownership status | window | switch | rollback [--domain D]`.
//
// `status`, `switch` and `rollback` are offline maintenance commands, like
// `import`: they take the data directory lock, so they cannot run while a Host
// is serving. That is the maintenance window in its simplest form — no client
// is connected to either side while write ownership moves.
//
// `window` is the opposite case: the Host *is* serving, and an operator at the
// machine asks it, over the same-user control channel, for the token an HTTPS
// switch must carry. Everything else about the switch is identical; only the
// proof that someone is at the machine changes shape.
//
// Nothing here happens automatically. A switch is typed by an operator, names
// the domain and the verified import it rests on, and names the Runtime binary
// and database it is going to talk to. A rollback additionally writes the
// reverse export the Host owes the Runtime and has that same Runtime apply it,
// and the epoch only moves once the Runtime's re-read matches the package.
//
// `--domain` defaults to the canvas, which is the only domain that has moved so
// far and the only one existing scripts name.

type ownershipConfig struct {
	action           string
	domain           string
	target           string
	importID         string
	runtimeBinary    string
	runtimeDatabase  string
	runtimeSettings  string
	exportDirectory  string
	acceptExportOnly bool
}

func (o *ownershipConfig) register(flags *flag.FlagSet) {
	flags.StringVar(&o.domain, "domain", storage.OwnershipDomainCanvas,
		"Business domain: "+strings.Join(storage.OwnershipDomains, ", "))
	if o.action == "status" || o.action == "window" {
		return
	}
	if o.action == "switch" {
		flags.StringVar(&o.importID, "import-id", "", "Import identifier reported by `armadra-host import`")
	}
	if o.action == "rollback" {
		flags.StringVar(&o.exportDirectory, "export", "", "New directory for the Host's reverse export back to the Runtime")
		flags.BoolVar(&o.acceptExportOnly, "accept-export-only", false,
			"DANGER: hand the epoch back without the Runtime importing the package. Everything the Host wrote stays only in --export, and the Runtime resumes from what it held before the switch")
	}
	flags.StringVar(&o.runtimeBinary, "runtime-binary", "", "Absolute path to the Rust Runtime executable that stores the epoch")
	flags.StringVar(&o.runtimeDatabase, "runtime-database", "", "Absolute path to the Runtime's database")
	flags.StringVar(&o.runtimeSettings, "runtime-settings", "", "Absolute path to the Runtime's settings.json (default: settings.json beside --runtime-database)")
}

func (o *ownershipConfig) normalize() error {
	if o.domain == "" {
		o.domain = storage.OwnershipDomainCanvas
	}
	if !storage.ValidOwnershipDomain(o.domain) {
		return fmt.Errorf("ownership --domain must be one of %s", strings.Join(storage.OwnershipDomains, ", "))
	}
	if o.action == "status" || o.action == "window" {
		return nil
	}
	o.target = storage.OwnerHost
	if o.action == "rollback" {
		o.target = storage.OwnerRuntime
	}
	if o.runtimeBinary == "" || o.runtimeDatabase == "" {
		return fmt.Errorf("ownership %s requires --runtime-binary PATH and --runtime-database PATH", o.action)
	}
	var err error
	if o.runtimeBinary, err = filepath.Abs(o.runtimeBinary); err != nil {
		return err
	}
	if o.runtimeDatabase, err = filepath.Abs(o.runtimeDatabase); err != nil {
		return err
	}
	// The settings document lives beside the database in the Runtime's own
	// layout. Defaulting to it means an ordinary deployment names one path;
	// naming the flag is what a relocated database needs, and without it a
	// settings switch would read a file nobody has ever edited and export
	// defaults over the operator's real preferences.
	if o.runtimeSettings == "" {
		o.runtimeSettings = filepath.Join(filepath.Dir(o.runtimeDatabase), "settings.json")
	} else if o.runtimeSettings, err = filepath.Abs(o.runtimeSettings); err != nil {
		return err
	}
	if o.action == "switch" && o.importID == "" {
		return errors.New("ownership switch requires --import-id ID from a completed import")
	}
	if o.action == "rollback" {
		if o.exportDirectory == "" {
			return errors.New("ownership rollback requires --export DIRECTORY for the reverse export")
		}
		if o.exportDirectory, err = filepath.Abs(o.exportDirectory); err != nil {
			return err
		}
	}
	return nil
}

// openOwnership takes the directory lock and assembles the switch. A Host that
// is currently serving holds the same lock, so this fails rather than letting
// two writers touch the same database during a switch.
func openOwnership(c config) (*hoststate.State, *storage.Store, *canvashost.Service, *ownership.Service, error) {
	state, err := hoststate.Open(c.dataDir)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	database, err := storage.Open(c.dataDir, state.ID)
	if err != nil {
		state.Close()
		return nil, nil, nil, nil, err
	}
	canvases, err := canvashost.New(canvashost.Options{Store: database, HostID: state.ID})
	if err != nil {
		database.Close()
		state.Close()
		return nil, nil, nil, nil, err
	}
	settings, err := settingshost.New(settingshost.Options{Store: database, HostID: state.ID})
	if err != nil {
		database.Close()
		state.Close()
		return nil, nil, nil, nil, err
	}
	fileRoots, err := fshost.New(fshost.Options{Store: database, HostID: state.ID})
	if err != nil {
		database.Close()
		state.Close()
		return nil, nil, nil, nil, err
	}
	// The offline entry point has no execution channel of its own: an operator
	// running this holds the data-directory lock, so the Runtime is stopped and
	// there is nothing to run a command on. The git projector needs none --
	// what it checks is that no queue is in flight, and the Host's own queue is
	// empty in a process that has just started.
	repositoryQueue, err := githost.New(githost.Options{Store: database, HostID: state.ID, Roots: fileRoots})
	if err != nil {
		database.Close()
		state.Close()
		return nil, nil, nil, nil, err
	}
	// The offline command has no long-lived Worker, so the session domain gets
	// one per exchange. It is the same short-lived Worker the switch itself
	// uses, and it is what makes an offline adoption end by asking the machine
	// what it actually holds rather than trusting the rows it just projected.
	sessions, err := sessionhost.New(sessionhost.Options{
		Store:  database,
		HostID: state.ID,
		Open: func(ctx context.Context, executionHostID string) (sessionhost.Runner, func(), error) {
			if c.ownership.runtimeBinary == "" || executionHostID != "" {
				return nil, nil, sessionhost.ErrNoWorker
			}
			client, err := worker.Start(ctx, worker.Options{
				Executable:     c.ownership.runtimeBinary,
				HostID:         state.ID,
				CanvasDatabase: c.ownership.runtimeDatabase,
				SettingsFile:   c.ownership.runtimeSettings,
				RequestTimeout: 30 * time.Second,
			})
			if err != nil {
				return nil, nil, err
			}
			return client, func() { _ = client.Close() }, nil
		},
	})
	if err != nil {
		database.Close()
		state.Close()
		return nil, nil, nil, nil, err
	}
	// The agent domain gets a short-lived Worker per exchange for the same
	// reason the session domain does: an offline adoption ends by settling what
	// was in flight, and a rollback ends by asking the machine to read its own
	// rows back rather than trusting the request that wrote them.
	agents, err := agenthost.New(agenthost.Options{
		Store:      database,
		HostID:     state.ID,
		InstanceID: state.ID,
		Open: func(ctx context.Context, executionHostID string) (agenthost.Executor, func(), error) {
			if c.ownership.runtimeBinary == "" || executionHostID != "" {
				return nil, nil, agenthost.ErrNoWorker
			}
			client, err := worker.Start(ctx, worker.Options{
				Executable:     c.ownership.runtimeBinary,
				HostID:         state.ID,
				CanvasDatabase: c.ownership.runtimeDatabase,
				SettingsFile:   c.ownership.runtimeSettings,
				RequestTimeout: 30 * time.Second,
			})
			if err != nil {
				return nil, nil, err
			}
			return client, func() { _ = client.Close() }, nil
		},
	})
	if err != nil {
		database.Close()
		state.Close()
		return nil, nil, nil, nil, err
	}
	// The offline command has no Host instance, so the state's own ID stands in
	// for one. It is only ever used to bind maintenance tokens, and this entry
	// point never issues or spends one.
	switches, err := ownership.New(ownership.Options{
		Store:      database,
		InstanceID: state.ID,
		Projectors: map[string]ownership.Projector{
			canvashost.Domain:   canvases.AsProjector(),
			settingshost.Domain: settings.AsProjector(),
			fshost.Domain:       fileRoots.AsProjector(),
			githost.Domain:      repositoryQueue.AsProjector(),
			sessionhost.Domain:  sessions.AsProjector(),
			agenthost.Domain:    agents.AsProjector(),
		},
	})
	if err != nil {
		database.Close()
		state.Close()
		return nil, nil, nil, nil, err
	}
	return state, database, canvases, switches, nil
}

func runOwnership(ctx context.Context, c config) (err error) {
	state, database, _, switches, err := openOwnership(c)
	if err != nil {
		return err
	}
	defer func() {
		err = errors.Join(err, database.Close(), state.Close())
	}()
	if c.ownership.action == "status" {
		record, err := switches.Record(ctx, c.ownership.domain)
		if err != nil {
			return err
		}
		return emitOwnership(c, &pb.OwnershipSwitchResponse{Ownership: ownership.Message(record)})
	}

	// The handoff Worker is started for this one exchange and stopped again.
	// It is not the scheduling Worker and cannot run commands.
	client, err := worker.Start(ctx, worker.Options{
		Executable:     c.ownership.runtimeBinary,
		HostID:         state.ID,
		CanvasDatabase: c.ownership.runtimeDatabase,
		SettingsFile:   c.ownership.runtimeSettings,
		RequestTimeout: 30 * time.Second,
	})
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, client.Close()) }()

	target := pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST
	if c.ownership.target == storage.OwnerRuntime {
		target = pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME
	}
	result, switchErr := switches.SwitchOffline(ctx, ownership.Request{
		Domain:           c.ownership.domain,
		Target:           target,
		ImportID:         c.ownership.importID,
		Handoff:          client,
		Importer:         client,
		ExportDirectory:  c.ownership.exportDirectory,
		AcceptExportOnly: c.ownership.acceptExportOnly,
	})
	// A refusal still prints its report: the operator needs to see which check
	// failed, not just that something did.
	if result != nil {
		if emitErr := emitOwnership(c, result); emitErr != nil {
			return errors.Join(switchErr, emitErr)
		}
	}
	return switchErr
}

// runMaintenanceWindow opens a maintenance window on a Host that is serving.
//
// It is the counterpart of `pair`: the same-user control channel is the proof
// that whoever asked is at the machine, and the token it hands back is what an
// HTTPS switch must carry. The token is printed once, expires in two minutes
// and is spent by exactly one switch; nothing stores it.
//
// This command does not take the data directory lock, because the Host serving
// on the other end of the control channel already holds it.
func runMaintenanceWindow(ctx context.Context, c config) error {
	status, err := daemon.Status(ctx, c.dataDir)
	if err != nil {
		return err
	}
	ticket, err := daemon.Maintenance(ctx, c.dataDir, &pb.MaintenanceTicketRequest{
		ExpectedHostId:     status.HostId,
		ExpectedInstanceId: status.HostInstanceId,
		Domain:             c.ownership.domain,
	})
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

func emitOwnership(c config, result *pb.OwnershipSwitchResponse) error {
	var data []byte
	var err error
	if c.output == "protobuf" {
		data, err = proto.Marshal(result)
	} else {
		data, err = (protojson.MarshalOptions{Indent: "  "}).Marshal(result)
		data = append(data, '\n')
	}
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(data)
	return err
}
