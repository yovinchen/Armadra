package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/buildinfo"
	"armadra.local/host/internal/hoststate"
	"armadra.local/host/internal/server"
	"armadra.local/host/internal/servicedef"
	"armadra.local/host/internal/updates"
)

// upgrade --from-release and upgrade --rollback.
//
// The order of the steps is the whole design (§3.2). Nothing installed is
// touched until every downloaded file has been verified, unpacked and asked
// what it is; the Host, the Worker and the Hook then move as one transaction,
// because half of them at each version is a combination nobody declared
// compatible. If the new Host does not come back healthy, the transaction is
// undone — unless the database has already migrated, in which case putting the
// old binaries back would produce a deployment that refuses to start at all.

// transferTimeout bounds the whole download, verify and unpack stage.
const transferTimeout = 10 * time.Minute

// healthDeadline is how long the new Host has to come back and report itself.
const healthDeadline = 30 * time.Second

// releaseComponents are the programs an upgrade installs together, in the
// order they are replaced. The Host is last so that if anything fails the
// binary running this command is the one still least likely to have moved.
var releaseComponents = []struct {
	component string
	binary    string
	// configured returns the installed path, or "" when this deployment does
	// not run that component at all.
	configured func(c config) string
}{
	{updates.ComponentWorker, "armadra-runtime", func(c config) string { return c.workerBinary }},
	{updates.ComponentHost, "armadra-host", func(c config) string { return "" }},
}

// upgradeFromRelease performs the ten steps of §3.2.
func upgradeFromRelease(parent context.Context, c config) error {
	if c.updatesSource == "" {
		return fmt.Errorf("%s: upgrade --from-release needs --updates-source", updates.ReasonNotConfigured)
	}
	target, err := hostExecutable()
	if err != nil {
		return err
	}
	publicKey, err := releasePublicKey(c)
	if err != nil {
		return err
	}

	// 1. Check. The Host asks about its own component and its own target, so a
	// release that ships a desktop bundle for this platform and no Host is
	// reported as having no artifact rather than answered with the bundle.
	service, err := updates.New(updates.Options{
		Source:        c.updatesSource,
		Channel:       requestedChannel(c),
		ProtocolMajor: server.ProtocolMajor,
		ProtocolMinor: server.ProtocolMinor,
	})
	if err != nil {
		return err
	}
	installed, err := updates.ParseVersion(buildinfo.ReleaseVersion())
	if err != nil {
		return fmt.Errorf("this build does not report a version an upgrade can compare: %w", err)
	}
	ctx, cancel := context.WithTimeout(parent, transferTimeout)
	defer cancel()
	answer, err := service.Check(ctx, &pb.CheckForUpdateRequest{
		Channel:          requestedChannel(c),
		InstalledVersion: installed,
		Target:           updates.LocalTarget(),
		Component:        updates.ComponentHost,
	})
	if err != nil {
		return err
	}

	// 2. Range. AVAILABLE already means the release accepted this installed
	// version and this protocol major; every other state is reported as-is.
	if answer.GetState() != pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE {
		return fmt.Errorf("no release to install: %s (%s)", answer.GetState(), answer.GetReasonCode())
	}
	offered := answer.GetRelease()
	if c.service.version != "" {
		wanted, err := updates.ParseVersion(c.service.version)
		if err != nil {
			return err
		}
		if updates.Compare(offered.GetVersion(), wanted) != 0 {
			return fmt.Errorf("the newest accepted release is %s, not %s; only --rollback goes backwards",
				updates.FormatVersion(offered.GetVersion()), updates.FormatVersion(wanted))
		}
	}
	version := updates.FormatVersion(offered.GetVersion())

	result := upgradeResult{
		Command: "upgrade", Mode: "from-release", Target: target,
		Candidate: version,
	}

	// The release must carry every component this deployment actually runs.
	// Installing the Host without the Worker it launches would be exactly the
	// mixed-version state the transaction exists to prevent.
	wanted, err := releaseArtifacts(ctx, service, installed, c)
	if err != nil {
		return err
	}
	for _, item := range wanted {
		result.Components = append(result.Components, item.component)
	}

	ctxState, cancelState := context.WithTimeout(parent, healthDeadline)
	defer cancelState()
	running, err := runningStatus(ctxState, c.dataDir)
	if err != nil {
		return err
	}
	result.WasRunning = running != nil
	result.Managed = serviceManaged(c.dataDir, running)
	marker, markerErr := servicedef.ReadMarker(c.dataDir)
	if running != nil && markerErr != nil && !result.Managed {
		return fmt.Errorf("Host is running and no service definition records its configuration; run `armadra-host stop` first, then upgrade")
	}

	if !c.service.confirm {
		result.Note = fmt.Sprintf("no change was made; re-run with --confirm to install %s", version)
		return reportUpgrade(c, result, func() {
			fmt.Printf("Would install release %s over %s\n", version, target)
			fmt.Printf("Components: %s\n", strings.Join(result.Components, ", "))
			if result.Managed {
				fmt.Println("The service manager would restart the Host after the binaries are replaced.")
			}
			fmt.Println("Nothing changed. Re-run with --confirm to apply.")
		})
	}

	// 3-6. Download, verify, unpack and probe every component into a staging
	// directory under the data directory. Nothing installed has moved yet.
	staging := filepath.Join(c.dataDir, "updates", version)
	if err := os.RemoveAll(staging); err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	replacements, err := prepareComponents(ctx, wanted, staging, publicKey)
	if err != nil {
		return err
	}
	result.Protocol = versionReport{
		Component: servicedef.ComponentName, Version: version,
		ProtocolMajor: server.ProtocolMajor, ProtocolMinor: server.ProtocolMinor,
	}

	before := migrationLedger(c.dataDir)
	// 7-8. Replace, then order the stop correctly for this deployment.
	transaction, err := servicedef.ReplaceAll(replacements)
	if err != nil {
		return err
	}
	result.Applied = true

	status, restarted, healthErr := completeUpgrade(parent, c, target, marker.Spec, running, result.Managed)
	if healthErr == nil {
		result.Restarted = restarted
		result.Status = summarize(status)
		result.Note = fmt.Sprintf("installed %s (%s)", version, strings.Join(result.Components, ", "))
		return reportUpgrade(c, result, func() {
			fmt.Printf("Installed release %s over %s\n", version, target)
		})
	}

	// 10. Roll back. A database the new build already migrated is a one-way
	// door: the previous binary refuses an unknown schema, so putting it back
	// would turn a failed upgrade into a deployment that will not start.
	if err := servicedef.SafeToRollback(before, migrationLedger(c.dataDir)); err != nil {
		return errors.Join(healthErr, err)
	}
	if rollbackErr := servicedef.Rollback(transaction); rollbackErr != nil {
		return errors.Join(healthErr, rollbackErr)
	}
	result.RolledBack = true
	result.Note = fmt.Sprintf("the new version did not become healthy and was rolled back: %v", healthErr)
	restored, _, restartErr := completeUpgrade(parent, c, target, marker.Spec, running, result.Managed)
	if restartErr == nil {
		result.Status = summarize(restored)
	}
	return reportUpgrade(c, result, func() {
		fmt.Println(result.Note)
	})
}

// releaseArtifacts asks the same release about every component this deployment
// runs. A release missing one of them is refused before anything is fetched.
type wantedArtifact struct {
	component string
	binary    string
	target    string
	artifact  *pb.UpdateArtifact
}

func releaseArtifacts(ctx context.Context, service *updates.Service, installed *pb.SemanticVersion, c config) ([]wantedArtifact, error) {
	wanted := make([]wantedArtifact, 0, len(releaseComponents))
	for _, component := range releaseComponents {
		path := component.configured(c)
		if component.component == updates.ComponentHost {
			executable, err := hostExecutable()
			if err != nil {
				return nil, err
			}
			path = executable
		}
		if path == "" {
			// A deployment that runs no Worker has nothing to upgrade for it,
			// and fetching one would install a binary nothing launches.
			continue
		}
		answer, err := service.Check(ctx, &pb.CheckForUpdateRequest{
			Channel:          requestedChannel(c),
			InstalledVersion: installed,
			Target:           updates.LocalTarget(),
			Component:        component.component,
		})
		if err != nil {
			return nil, err
		}
		if answer.GetState() != pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE {
			return nil, fmt.Errorf("this deployment runs %s but the release publishes none for %s: %s (%s)",
				component.component, updates.LocalTarget(), answer.GetState(), answer.GetReasonCode())
		}
		artifacts := answer.GetRelease().GetArtifacts()
		if len(artifacts) != 1 {
			return nil, fmt.Errorf("the release offers %d artifacts for %s", len(artifacts), component.component)
		}
		wanted = append(wanted, wantedArtifact{
			component: component.component,
			binary:    component.binary,
			target:    path,
			artifact:  artifacts[0],
		})
	}
	return wanted, nil
}

// prepareComponents downloads, verifies, unpacks and probes each artifact.
// Every failure here leaves the installed files untouched, which is why all of
// it happens before ReplaceAll is called.
func prepareComponents(ctx context.Context, wanted []wantedArtifact, staging, publicKey string) ([]servicedef.Replacement, error) {
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: transferTimeout}
	replacements := make([]servicedef.Replacement, 0, len(wanted))
	for _, item := range wanted {
		// 3. Download, with the declared length and digest enforced as it
		// arrives rather than checked over whatever fitted on the disk.
		downloaded, err := updates.Fetch(ctx, client, item.artifact, filepath.Join(staging, item.component))
		if err != nil {
			return nil, err
		}
		// 4. Verify. A release with no signature is refused rather than
		// installed unverified: this Host holds a public key precisely so it
		// never has to decide whether an unsigned binary is probably fine.
		if downloaded.SignaturePath == "" {
			return nil, fmt.Errorf("%w: %s: the release publishes no signature for %s",
				updates.ErrVerify, updates.ReasonSignatureMissing, item.component)
		}
		payload, err := os.ReadFile(downloaded.Path)
		if err != nil {
			return nil, err
		}
		signature, err := os.ReadFile(downloaded.SignaturePath)
		if err != nil {
			return nil, err
		}
		name := updates.AssetName(item.artifact.GetUrl())
		if err := updates.VerifyArtifactSignature(publicKey, string(signature), name, payload); err != nil {
			return nil, err
		}
		// 5. Unpack exactly the one file name expected, refusing traversal,
		// links and anything else the archive happens to contain.
		binary := item.binary
		if strings.HasSuffix(name, ".zip") {
			binary += ".exe"
		}
		candidate := filepath.Join(staging, item.component, binary)
		if err := updates.Unpack(downloaded.Path, binary, candidate); err != nil {
			return nil, err
		}
		// 6. Ask the candidate what it is. Only the Host reports a version
		// report this command understands; the others are checked as files.
		if _, err := servicedef.VerifyCandidate(candidate); err != nil {
			return nil, err
		}
		if item.component == updates.ComponentHost {
			version, err := servicedef.Probe(ctx, candidate)
			if err != nil {
				return nil, err
			}
			if err := servicedef.CheckCompatible(version, server.ProtocolMajor); err != nil {
				return nil, err
			}
		}
		replacements = append(replacements, servicedef.Replacement{
			Component: item.component, Candidate: candidate, Target: item.target,
		})
	}
	if len(replacements) == 0 {
		return nil, fmt.Errorf("the release carries nothing this deployment installs")
	}
	return replacements, nil
}

// completeUpgrade orders the stop against the service manager (§3.3) and waits
// for the result to be healthy.
//
// Under a manager with KeepAlive or Restart=, the binaries are already replaced
// before the Host is asked to stop, so what the manager brings back is the new
// version. Stopping first would have the manager start the old image and then
// have it overwritten underneath — two restarts and a window in which the old
// version is serving from a file that no longer exists.
func completeUpgrade(parent context.Context, c config, target string, spec servicedef.Spec, running *pb.HostStatus, managed bool) (*pb.HostStatus, bool, error) {
	ctx, cancel := context.WithTimeout(parent, healthDeadline)
	defer cancel()
	if running == nil {
		return nil, false, nil
	}
	if err := stopForUpgrade(ctx, c.dataDir, running.GetHostInstanceId()); err != nil {
		return nil, false, err
	}
	if managed {
		// The manager restarts it; this command must not start a second one.
		status, err := awaitReady(ctx, c.dataDir, nil)
		if err != nil {
			return nil, false, err
		}
		return status, false, nil
	}
	return restartAfterUpgrade(ctx, c.dataDir, target, spec)
}

// serviceManaged reports whether something will restart this Host on its own.
// It needs both halves: a recorded definition, and a running Host that says a
// service manager started it. Either alone is a guess, and guessing wrong here
// means either two Hosts or none.
func serviceManaged(dataDir string, running *pb.HostStatus) bool {
	if running == nil {
		return false
	}
	if _, err := servicedef.ReadMarker(dataDir); err != nil {
		return false
	}
	record, err := hoststate.ReadLauncher(dataDir)
	return err == nil && record.InstanceID == running.GetHostInstanceId() && record.Launcher == hoststate.LauncherService
}

// rollbackHost returns to the binaries the last successful upgrade displaced.
// It is the only way down: this command never installs an older release over a
// newer one, because a migrated database cannot be handed back to a build that
// does not know the migration.
func rollbackHost(parent context.Context, c config) error {
	target, err := hostExecutable()
	if err != nil {
		return err
	}
	transaction := servicedef.Transaction{
		Replaced: []servicedef.Replacement{{Component: "host", Target: target}},
	}
	if c.workerBinary != "" {
		transaction.Replaced = append([]servicedef.Replacement{
			{Component: "worker", Target: c.workerBinary},
		}, transaction.Replaced...)
	}
	if !servicedef.RollbackAvailable(transaction) {
		return fmt.Errorf("nothing to roll back to: no %s file was left by a previous upgrade", servicedef.PreviousSuffix)
	}
	result := upgradeResult{Command: "upgrade", Mode: "rollback", Target: target}
	for _, replacement := range transaction.Replaced {
		result.Components = append(result.Components, replacement.Component)
	}
	ctx, cancel := context.WithTimeout(parent, healthDeadline)
	defer cancel()
	running, err := runningStatus(ctx, c.dataDir)
	if err != nil {
		return err
	}
	result.WasRunning = running != nil
	result.Managed = serviceManaged(c.dataDir, running)
	if !c.service.confirm {
		result.Note = "no change was made; re-run with --confirm to roll back"
		return reportUpgrade(c, result, func() {
			fmt.Printf("Would restore %s for: %s\n", servicedef.PreviousSuffix, strings.Join(result.Components, ", "))
			fmt.Println("Nothing changed. Re-run with --confirm to apply.")
		})
	}
	marker, _ := servicedef.ReadMarker(c.dataDir)
	if err := servicedef.Rollback(transaction); err != nil {
		return err
	}
	result.Applied = true
	result.RolledBack = true
	status, restarted, healthErr := completeUpgrade(parent, c, target, marker.Spec, running, result.Managed)
	if healthErr != nil {
		return fmt.Errorf("the binaries were restored but the Host did not come back: %w", healthErr)
	}
	result.Restarted = restarted
	result.Status = summarize(status)
	result.Note = "restored the binaries the last upgrade displaced"
	return reportUpgrade(c, result, func() {
		fmt.Println(result.Note)
	})
}

// releasePublicKey resolves the key release artifacts are verified with:
// --updates-pubkey first, then whatever the pipeline stamped into this build.
// With neither, the upgrade refuses — an unverifiable download is never
// installed, and there is no "probably fine" between the two.
func releasePublicKey(c config) (string, error) {
	if c.service.publicKey != "" {
		data, err := os.ReadFile(c.service.publicKey)
		if err != nil {
			return "", err
		}
		return string(data), nil
	}
	if key := buildinfo.PublicKey(); key != "" {
		return key, nil
	}
	return "", fmt.Errorf("%w: %s: this build carries no release public key; pass --updates-pubkey PATH",
		updates.ErrVerify, updates.ReasonNoPublicKey)
}

func requestedChannel(c config) pb.ReleaseChannel {
	switch c.service.channel {
	case "beta":
		return pb.ReleaseChannel_RELEASE_CHANNEL_BETA
	case "stable":
		return pb.ReleaseChannel_RELEASE_CHANNEL_STABLE
	default:
		return c.releaseChannel
	}
}

// migrationLedger reads how far the database schema has advanced. The value is
// only ever compared with itself before and after, so an unreadable ledger
// reads as "no advance" and rollback stays available: refusing to roll back
// because a file could not be read would strand the operator on a version that
// did not work.
func migrationLedger(dataDir string) uint64 {
	data, err := os.ReadFile(filepath.Join(dataDir, "migrations.json"))
	if err != nil {
		return 0
	}
	var ledger struct {
		Applied uint64 `json:"applied"`
	}
	if err := json.Unmarshal(data, &ledger); err != nil {
		return 0
	}
	return ledger.Applied
}

// reportUpgrade prints the result in whichever format was asked for.
func reportUpgrade(c config, result upgradeResult, text func()) error {
	if c.output == "json" {
		return writeJSON(result)
	}
	text()
	return nil
}
