package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/canvashost"
	"armadra.local/host/internal/hoststate"
	"armadra.local/host/internal/storage"
	"armadra.local/host/internal/worker"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// `armadra-host ownership status | switch | rollback`.
//
// This is an offline maintenance command, like `import`: it takes the data
// directory lock, so it cannot run while a Host is serving. That is the
// maintenance window the design asks for — no client is connected to either
// side while write ownership moves.
//
// Nothing here happens automatically. A switch is typed by an operator, names
// the verified import it rests on, and names the Runtime binary and database it
// is going to talk to. A rollback additionally writes the reverse export the
// Host owes the Runtime, has the Runtime apply it, and compares the digests the
// Runtime reads back before it gives the epoch away.

type ownershipConfig struct {
	action           string
	target           string
	importID         string
	runtimeBinary    string
	runtimeDatabase  string
	exportDirectory  string
	acceptExportOnly bool
}

func (o *ownershipConfig) register(flags *flag.FlagSet) {
	if o.action == "status" {
		return
	}
	if o.action == "switch" {
		flags.StringVar(&o.importID, "import-id", "", "Import identifier reported by `armadra-host import`")
	}
	if o.action == "rollback" {
		flags.StringVar(&o.exportDirectory, "export", "", "New directory for the Host's reverse export back to the Runtime")
		flags.BoolVar(&o.acceptExportOnly, "accept-export-only", false, "DANGEROUS: skip applying the package to the Runtime and give the epoch back anyway, leaving the Host's canvas only in the export package")
	}
	flags.StringVar(&o.runtimeBinary, "runtime-binary", "", "Absolute path to the Rust Runtime executable that stores the epoch")
	flags.StringVar(&o.runtimeDatabase, "runtime-database", "", "Absolute path to the Runtime's canvas database")
}

func (o *ownershipConfig) normalize() error {
	if o.action == "status" {
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

// openCanvas takes the directory lock and assembles the canvas service. A Host
// that is currently serving holds the same lock, so this fails rather than
// letting two writers touch the same database during a switch.
func openCanvas(c config) (*hoststate.State, *storage.Store, *canvashost.Service, error) {
	state, err := hoststate.Open(c.dataDir)
	if err != nil {
		return nil, nil, nil, err
	}
	database, err := storage.Open(c.dataDir, state.ID)
	if err != nil {
		state.Close()
		return nil, nil, nil, err
	}
	service, err := canvashost.New(canvashost.Options{Store: database, HostID: state.ID})
	if err != nil {
		database.Close()
		state.Close()
		return nil, nil, nil, err
	}
	return state, database, service, nil
}

func runOwnership(ctx context.Context, c config) (err error) {
	state, database, service, err := openCanvas(c)
	if err != nil {
		return err
	}
	defer func() {
		err = errors.Join(err, database.Close(), state.Close())
	}()
	if c.ownership.action == "status" {
		ownership, err := service.Status(ctx)
		if err != nil {
			return err
		}
		return emitOwnership(c, &pb.CanvasOwnershipResponse{Ownership: ownership})
	}

	// The handoff Worker is started for this one exchange and stopped again.
	// It is not the scheduling Worker and cannot run commands.
	client, err := worker.Start(ctx, worker.Options{
		Executable:     c.ownership.runtimeBinary,
		HostID:         state.ID,
		CanvasDatabase: c.ownership.runtimeDatabase,
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
	result, switchErr := service.Switch(ctx, canvashost.SwitchRequest{
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

func emitOwnership(c config, result *pb.CanvasOwnershipResponse) error {
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
