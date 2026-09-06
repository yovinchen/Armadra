// Serving assembly: the long-running Host process, the services it wires up
// and the state directory it holds while it runs.

package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/agenthost"
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
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/runtimelink"
	"armadra.local/host/internal/server"
	"armadra.local/host/internal/sessionhost"
	"armadra.local/host/internal/settingshost"
	"armadra.local/host/internal/storage"
	"armadra.local/host/internal/updates"
	"armadra.local/host/internal/worker"
)

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
	// The agent surface is assembled on the same terms, and needs the same
	// channel for the same reason: recording that somebody allowed a command is
	// worth nothing unless the CLI that is blocked on it hears. A Host with no
	// Runtime binary still answers every read and refuses the rest with a state
	// a client can draw.
	openAgentExecutor := func(ctx context.Context, executionHostID string) (agenthost.Executor, func(), error) {
		if c.runtimeBinary == "" || executionHostID != "" {
			return nil, nil, agenthost.ErrNoWorker
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
	agents, err := agenthost.New(agenthost.Options{
		Store:      database,
		HostID:     state.ID,
		InstanceID: identity.InstanceID,
		Open:       openAgentExecutor,
	})
	if err != nil {
		return err
	}
	// A dispatch this Host was in the middle of when it stopped is settled
	// before anything new is accepted. Leaving it claimed would leave it
	// claimed forever, and re-dispatching it would put a second copy of
	// somebody's work in front of an agent that may already have the first.
	if _, err = agents.ReconcileHandoffs(ctx); err != nil {
		return err
	}
	// Context links are derived from the canvas' own edges, so the canvas
	// service tells the agent service when they may have moved. It is a
	// callback rather than a shared transaction because the dependency has to
	// run this way round: the canvas domain was migrated first and must not
	// have to know what an agent is.
	canvases.SetAfterApply(func(ctx context.Context, workspaceID string) {
		if _, err := agents.RefreshContextLinks(ctx, workspaceID); err != nil {
			fmt.Fprintln(os.Stderr, "Armadra: could not refresh context links:", err)
		}
	})
	switches, err := ownership.New(ownership.Options{
		Store:      database,
		InstanceID: identity.InstanceID,
		Projectors: map[string]ownership.Projector{
			canvashost.Domain:   canvases.AsProjector(),
			settingshost.Domain: settings.AsProjector(),
			fshost.Domain:       fileRoots.AsProjector(),
			githost.Domain:      repositoryQueue.AsProjector(),
			sessionhost.Domain:  sessions.AsProjector(),
			agenthost.Domain:    agents.AsProjector(),
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
	events, err := eventstream.New(eventstream.Options{Store: database, HostID: state.ID, Projectors: []eventstream.Projector{canvashost.EventProjector{}, settingshost.EventProjector{}, fshost.EventProjector{}, githost.EventProjector{}, sessionhost.EventProjector{}, agenthost.EventProjector{}}})
	if err != nil {
		return err
	}
	defer events.Close()
	database.SetCommitNotifier(events.Notify)
	options := server.Options{AllowedOrigins: c.origins, Identity: identities, PublicOrigin: c.publicOrigin, Automation: plans, GitHub: repositories, Web: web, Runtime: link, Updates: releases, Canvas: canvases, Settings: settings, Filesystem: fileRoots, Git: repositoryQueue, Sessions: sessions, Agents: agents, Events: events, Ownership: switches, OpenHandoff: openHandoff}
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
				// A ticket is minted only for an origin that can actually
				// spend it: the HTTPS public origin, or — on a plain loopback
				// Host — a desktop shell origin the operator allowed, which
				// the shell then trades for a bearer session over that
				// listener (docs/design/host-native-session.md §2). A plain
				// Host still refuses browser origins: it could never set
				// their cookies.
				native := c.publicOrigin == "" && listener != nil && server.NativeOrigin(request.Origin) && slices.Contains(c.origins, request.Origin)
				if !native && (c.publicOrigin == "" || request.Origin != c.publicOrigin) {
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
