// The offline maintenance subcommands: pairing a browser origin and staging a
// verified Runtime export bundle.

package main

import (
	"context"
	"os"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/daemon"
	"armadra.local/host/internal/hoststate"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/migration"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

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
