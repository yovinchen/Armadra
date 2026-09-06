package settingshost

import (
	"bytes"
	"context"
	"sort"

	pb "armadra.local/host/gen/armadra/v1"
)

// The consistency comparison the settings switch rests on
// (Go Host 业务所有权迁移 §2.11, step 3).
//
// The precondition for moving the epoch is not "the import reported no error";
// it is "what the Host now holds is what the Runtime exported". Three
// statements make that up, and each one is compared against evidence the other
// side produced rather than against something this Host restated:
//
//   - the digest of the bytes now stored equals the digest the Worker reported,
//     which is the whole document in one number;
//   - the top-level key set matches, so a document that parsed but lost a
//     section is a difference and not a smaller success;
//   - the execution hosts the Host derived from the document match the ones the
//     Worker derived from its own copy — two independent projections of the
//     same registry, which is what makes agreeing on them worth anything.
//
// A single difference blocks the switch. There is no severity that lets one
// through: a settings document missing its SSH registry is not a migrated one.

// maxDifferences bounds what one check reports. A report is read by a person in
// a maintenance window, and ten thousand ids would be less useful than thirty.
const maxDifferences = 32

type checkBuilder struct{ checks []*pb.ConsistencyCheck }

func (b *checkBuilder) record(name string, expected, actual uint64, differences []string) {
	sort.Strings(differences)
	if len(differences) > maxDifferences {
		differences = differences[:maxDifferences]
	}
	b.checks = append(b.checks, &pb.ConsistencyCheck{
		Check:         name,
		ExpectedCount: expected,
		ActualCount:   actual,
		Matched:       expected == actual && len(differences) == 0,
		Differences:   differences,
	})
}

func (b *checkBuilder) matched() bool {
	for _, check := range b.checks {
		if !check.Matched {
			return false
		}
	}
	return true
}

// keyDifferences names every top-level key one side has and the other does not.
// A key the Host holds that the export never listed is as much a difference as
// a missing one: it did not come from this move.
func keyDifferences(expected, actual []string) []string {
	left := map[string]bool{}
	for _, key := range expected {
		left[key] = true
	}
	right := map[string]bool{}
	for _, key := range actual {
		right[key] = true
	}
	differences := []string{}
	for key := range left {
		if !right[key] {
			differences = append(differences, key)
		}
	}
	for key := range right {
		if !left[key] {
			differences = append(differences, key)
		}
	}
	return differences
}

// verifyAdoption compares the rows this Host now holds with the snapshot the
// Worker reported. It writes nothing and grants nothing; the caller decides
// what an unmatched report means, and the switch refuses on one.
func (s *Service) verifyAdoption(ctx context.Context, snapshot *pb.WorkerSettingsSnapshot, importID string) (*pb.OwnershipReport, error) {
	exported := snapshot.GetDocument()
	key, err := documentKey(exported.GetScope(), exported.GetDeviceId())
	if err != nil {
		return nil, err
	}
	stored, err := s.document(ctx, key)
	if err != nil {
		return nil, err
	}
	hosts, err := s.storedExecutionHosts(ctx)
	if err != nil {
		return nil, err
	}
	builder := &checkBuilder{}

	// 1. The document, as one number over the bytes that are actually stored —
	// not over the message that was received, which would only restate it.
	digestDifferences := []string{}
	if !bytes.Equal(digest(stored.Document), exported.GetSha256()) {
		digestDifferences = append(digestDifferences, key.ID)
	}
	builder.record("settings.document_sha256", 1, 1, digestDifferences)

	// 2. The key set, so a document that parsed and lost a section is caught
	// even though both halves are valid JSON.
	exportedKeys, err := topLevelKeys(exported.GetDocument())
	if err != nil {
		return nil, err
	}
	storedKeys, err := topLevelKeys(stored.Document)
	if err != nil {
		return nil, err
	}
	builder.record("settings.keys", uint64(len(exportedKeys)), uint64(len(storedKeys)), keyDifferences(exportedKeys, storedKeys))

	// 3. The registry, as two independent projections of the same document.
	// The local machine is left out of the comparison: the Worker reports it
	// because it is describing a machine, and the Host stores no row for it.
	workerHosts := sshOnly(snapshot.GetExecutionHosts())
	builder.record("settings.execution_hosts", uint64(len(workerHosts)), uint64(len(hosts)), compareExecutionHosts(workerHosts, hosts))

	return &pb.OwnershipReport{
		Domain:           pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_SETTINGS,
		ImportId:         importID,
		Checks:           builder.checks,
		EntityCount:      uint64(1 + len(hosts)),
		Matched:          builder.matched(),
		VerifiedAtUnixMs: s.now(),
	}, nil
}
