package settingshost

import (
	"bytes"
	"context"
	"encoding/json"
	"sort"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// Execution hosts are `settings.ssh.hosts[]` read out as entities
// (settings.proto: "Execution hosts are a projection, never a second source").
//
// Projecting them is what lets the event stream and the consistency checks name
// one host — "the machine you build on moved" — instead of "the document
// changed". It also means there is exactly one place a host can be edited: the
// document. Nothing here accepts a host from a client, and nothing writes one
// without writing the document it came out of, so the two can never disagree.
//
// Only SSH hosts become entities. The local machine needs no registration and
// its identifier is the empty string, which is not a storage key at all
// (storage.validateKey); it is supplied by the read instead (localExecutionHost).

// sshHostJSON is the shape packages/shared already stores. Only the fields an
// execution host is addressed and started by are read: extra ssh arguments and
// anything else the document carries stay in the document, which remains the
// only source. Unknown fields are ignored rather than refused — the Host does
// not own this schema and must not fail a save because the front end added a
// field it has not been taught about.
type sshHostJSON struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Host         string  `json:"host"`
	User         string  `json:"user"`
	Port         *uint32 `json:"port"`
	IdentityFile string  `json:"identityFile"`
	Worker       *struct {
		Path     string `json:"path"`
		StateDir string `json:"stateDir"`
	} `json:"worker"`
}

// LocalExecutionHost is the row that is always there: this machine. It is not
// stored, it has no revision to compare, and it takes no part in any
// consistency check — "本机恒有一行" means the read always reports it, not that
// something wrote it. Its identifier is the empty string, the same convention
// Runtime migration 0009 already uses for a local workspace.
func LocalExecutionHost() *pb.ExecutionHost {
	return &pb.ExecutionHost{Kind: pb.ExecutionHostKind_EXECUTION_HOST_KIND_LOCAL}
}

// projectExecutionHosts reads the SSH registry out of one document, in id
// order. A registry this Host cannot read is refused rather than skipped: a
// document whose hosts cannot be projected would be stored as the source of a
// projection that does not exist, which is the one thing the contract's third
// rule forbids.
func projectExecutionHosts(document []byte) ([]*pb.ExecutionHost, error) {
	var envelope struct {
		SSH *struct {
			Hosts []json.RawMessage `json:"hosts"`
		} `json:"ssh"`
	}
	if err := json.Unmarshal(document, &envelope); err != nil {
		return nil, ErrInvalid
	}
	if envelope.SSH == nil || len(envelope.SSH.Hosts) == 0 {
		return []*pb.ExecutionHost{}, nil
	}
	if len(envelope.SSH.Hosts) > MaxExecutionHosts {
		return nil, ErrInvalid
	}
	result := make([]*pb.ExecutionHost, 0, len(envelope.SSH.Hosts))
	seen := map[string]bool{}
	for _, raw := range envelope.SSH.Hosts {
		var entry sshHostJSON
		if err := json.Unmarshal(raw, &entry); err != nil {
			return nil, ErrInvalid
		}
		// An id that is not a storage key, or one the registry already used,
		// would project two different hosts onto one entity.
		if !validExecutionHostID(entry.ID) || seen[entry.ID] {
			return nil, ErrInvalid
		}
		seen[entry.ID] = true
		ssh := &pb.SshExecutionHost{Host: entry.Host, User: entry.User, IdentityFile: entry.IdentityFile}
		if entry.Port != nil {
			ssh.Port = *entry.Port
		}
		if entry.Worker != nil {
			ssh.WorkerPath, ssh.StateDir = entry.Worker.Path, entry.Worker.StateDir
		}
		result = append(result, &pb.ExecutionHost{
			ExecutionHostId: entry.ID,
			Name:            entry.Name,
			Ssh:             ssh,
			Kind:            pb.ExecutionHostKind_EXECUTION_HOST_KIND_SSH,
		})
	}
	sort.Slice(result, func(a, b int) bool { return result[a].ExecutionHostId < result[b].ExecutionHostId })
	return result, nil
}

// storedExecutionHosts lists the live SSH host entities in id order.
// Tombstones are left out: a caller that needs to know a host once existed
// reads the event stream, not this listing.
func (s *Service) storedExecutionHosts(ctx context.Context) ([]*pb.ExecutionHost, error) {
	entities, err := s.collectExecutionHosts(ctx, false)
	if err != nil {
		return nil, err
	}
	result := make([]*pb.ExecutionHost, 0, len(entities))
	for _, entity := range entities {
		host, err := decodeHost(entity)
		if err != nil {
			return nil, err
		}
		result = append(result, host)
	}
	return result, nil
}

// collectExecutionHosts walks every host entity. Tombstones are included when
// asked for, because a host coming back needs the tombstone's revision: without
// it the resurrection is an ABA the storage kernel refuses.
func (s *Service) collectExecutionHosts(ctx context.Context, includeDeleted bool) ([]storage.Entity, error) {
	result := []storage.Entity{}
	after := ""
	for {
		page, err := s.store.List(ctx, storage.ListOptions{
			Kind:           KindExecutionHost,
			AfterID:        after,
			Limit:          storage.MaxPageSize,
			IncludeDeleted: includeDeleted,
		})
		if err != nil {
			return nil, err
		}
		result = append(result, page.Entities...)
		if !page.HasMore || page.NextID == after {
			return result, nil
		}
		after = page.NextID
	}
}

// executionHostChanges derives the entity writes one document implies: the
// hosts it names are upserted at the revision they are stored at, and a host it
// no longer names gets a revision tombstone. Both halves belong to the same
// transaction as the document itself, so an event always names the host that
// changed and never arrives without the document that changed it.
//
// A host whose content is unchanged produces no change and therefore no event,
// which keeps a save that renamed one host from republishing the whole registry.
func (s *Service) executionHostChanges(ctx context.Context, hosts []*pb.ExecutionHost, updatedAt int64) ([]storage.Change, error) {
	entities, err := s.collectExecutionHosts(ctx, true)
	if err != nil {
		return nil, err
	}
	stored := make(map[string]storage.Entity, len(entities))
	for _, entity := range entities {
		stored[entity.ID] = entity
	}
	changes := []storage.Change{}
	named := map[string]bool{}
	for _, host := range hosts {
		named[host.ExecutionHostId] = true
		payload, err := encodeHost(host, updatedAt)
		if err != nil {
			return nil, err
		}
		current, exists := stored[host.ExecutionHostId]
		if !exists {
			changes = append(changes, storage.Change{Key: executionHostKey(host.ExecutionHostId), Payload: payload})
			continue
		}
		same, err := sameHost(current, host)
		if err != nil {
			return nil, err
		}
		if current.Deleted || !same {
			changes = append(changes, storage.Change{Key: executionHostKey(host.ExecutionHostId), ExpectedRevision: current.Revision, Payload: payload})
		}
	}
	for _, entity := range entities {
		if named[entity.ID] || entity.Deleted {
			continue
		}
		changes = append(changes, storage.Change{Key: executionHostKey(entity.ID), ExpectedRevision: entity.Revision, Delete: true})
	}
	sort.Slice(changes, func(a, b int) bool { return changes[a].ID < changes[b].ID })
	return changes, nil
}

// sameHost compares content only. A stored payload that cannot be decoded is
// not "different": it is a corrupt row, and rewriting over it would hide that.
func sameHost(entity storage.Entity, host *pb.ExecutionHost) (bool, error) {
	current, err := decodeHost(entity)
	if err != nil {
		return false, err
	}
	left, err := comparable(current)
	if err != nil {
		return false, err
	}
	right, err := comparable(host)
	if err != nil {
		return false, err
	}
	return bytes.Equal(left, right), nil
}

// hostFingerprint is what a consistency check compares across a switch: the
// identifier, where the Worker binary is and which key file is used. Two sides
// that agree on these agree about which machine will be started and how it is
// reached; the rest of the entry is carried by the document's own digest.
func hostFingerprint(host *pb.ExecutionHost) string {
	if host == nil {
		return ""
	}
	return host.GetSsh().GetWorkerPath() + "\x00" + host.GetSsh().GetIdentityFile()
}

// compareExecutionHosts returns the ids that differ between two host sets.
// A difference names the host, never a path: an export report is written to
// disk and read by whoever is running the switch, and the path is exactly the
// part of an SSH entry that has no business being repeated there.
func compareExecutionHosts(expected, actual []*pb.ExecutionHost) []string {
	stored := make(map[string]string, len(actual))
	for _, host := range actual {
		stored[host.GetExecutionHostId()] = hostFingerprint(host)
	}
	differences := []string{}
	named := map[string]bool{}
	for _, host := range expected {
		id := host.GetExecutionHostId()
		named[id] = true
		fingerprint, ok := stored[id]
		if !ok || fingerprint != hostFingerprint(host) {
			differences = append(differences, id)
		}
	}
	// A host one side holds and the other never named is as much a difference
	// as a missing one: it did not come from this move.
	for id := range stored {
		if !named[id] {
			differences = append(differences, id)
		}
	}
	return differences
}

// sshOnly drops the implied local machine from a set that came from elsewhere.
// The Worker reports it because it is describing a machine; the Host stores no
// row for it, so comparing it would be comparing a row against nothing.
func sshOnly(hosts []*pb.ExecutionHost) []*pb.ExecutionHost {
	result := make([]*pb.ExecutionHost, 0, len(hosts))
	for _, host := range hosts {
		if host == nil || host.GetKind() != pb.ExecutionHostKind_EXECUTION_HOST_KIND_SSH {
			continue
		}
		result = append(result, host)
	}
	sort.Slice(result, func(a, b int) bool { return result[a].ExecutionHostId < result[b].ExecutionHostId })
	return result
}
