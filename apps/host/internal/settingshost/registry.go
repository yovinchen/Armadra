package settingshost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// The execution host registry as addressable objects, and the portable form of
// the whole document (Go Host 业务所有权迁移 §2.4).
//
// Everything here obeys the same rule the projection does: **writing a host
// means writing the document**. `PutExecutionHost` is a document write with one
// entry replaced, and `expected_revision` is the document's revision, not a
// per-host one. There is no second store, so there is nothing for the two to
// disagree about.
//
// What that costs is a JSON edit in Go, and the edit is deliberately narrow.
// Only the `ssh` member's `hosts` array is replaced; every other top-level
// member and every other key inside `ssh` is copied through byte for byte, in
// the order it was stored. A whole-document re-marshal would reorder keys and
// renumber nothing, and the digest a switch compares would then change on every
// host rename for no reason a reader could see.
//
// Validation stays structural, as it does everywhere else on this Host. The
// registry's *semantics* — whether `a;rm -rf /` is a hostname, whether a worker
// path would survive a remote shell — are the Runtime's rules
// (`terminal/ssh.rs`) and `packages/shared`'s, and a second copy here could
// disagree with the one that actually governs what gets executed.

// PackageVersion is the portable package's own shape version.
const PackageVersion = 1

// ListExecutionHosts answers the registry without touching the document.
func (s *Service) ListExecutionHosts(ctx context.Context, caller Caller) (*pb.ListExecutionHostsResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	hosts, err := s.executionHosts(ctx)
	if err != nil {
		return nil, err
	}
	// A missing document is not an error here: an installation nobody has
	// configured has this machine and no registry, which is exactly what an
	// empty answer says.
	revision := uint64(0)
	if document, err := s.document(ctx, storage.Key{Kind: KindDocument, ID: GlobalEntityID}); err == nil {
		revision = document.Revision
	} else if !errors.Is(err, storage.ErrNotFound) {
		return nil, err
	}
	return &pb.ListExecutionHostsResponse{ExecutionHosts: hosts, DocumentRevision: revision}, nil
}

// Validate reports what a save would do, and changes nothing.
//
// It is a read, so it needs the read grant and does not care who owns writes: a
// client is allowed to find out whether its document is well formed while the
// domain is mid-switch, and refusing would only make it save blind afterwards.
// The context is unused because nothing is read: the answer is a function of
// the request alone, which is what makes it safe to ask during a switch.
func (s *Service) Validate(_ context.Context, caller Caller, request *pb.ValidateSettingsRequest) (*pb.ValidateSettingsResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	if request == nil {
		return nil, ErrInvalid
	}
	problems := documentProblems(request.Document)
	if len(problems) > 0 {
		return &pb.ValidateSettingsResponse{Problems: problems}, nil
	}
	hosts, err := projectExecutionHosts(request.Document.Document)
	if err != nil {
		return &pb.ValidateSettingsResponse{
			Problems: []*pb.SettingsProblem{{Path: "ssh.hosts", ReasonCode: "invalidExecutionHostRegistry"}},
		}, nil
	}
	return &pb.ValidateSettingsResponse{Ok: true, ExecutionHosts: hosts}, nil
}

// documentProblems is the structural check, reported as a list rather than as
// the first failure so one save round trip can fix everything at once.
func documentProblems(value *pb.SettingsDocument) []*pb.SettingsProblem {
	problem := func(path, reason string) *pb.SettingsProblem {
		return &pb.SettingsProblem{Path: path, ReasonCode: reason}
	}
	if value == nil {
		return []*pb.SettingsProblem{problem("", "missingDocument")}
	}
	problems := []*pb.SettingsProblem{}
	if _, err := documentKey(value.Scope, value.DeviceId); err != nil {
		problems = append(problems, problem("", "invalidScope"))
	}
	if value.SchemaVersion != DocumentSchemaVersion {
		problems = append(problems, problem("", "unknownSchemaVersion"))
	}
	switch {
	case len(value.Document) == 0:
		problems = append(problems, problem("", "emptyDocument"))
	case len(value.Document) > MaxDocumentBytes:
		problems = append(problems, problem("", "tooLarge"))
	default:
		if _, err := topLevelKeys(value.Document); err != nil {
			problems = append(problems, problem("", "notAnObject"))
		}
	}
	// The digest is only checked when there are bytes to check it against;
	// reporting "wrong digest" for an empty document would name the wrong
	// problem.
	if len(value.Document) > 0 && !bytes.Equal(value.Sha256, digest(value.Document)) {
		problems = append(problems, problem("", "digestMismatch"))
	}
	return problems
}

/* ---------------------------- export and import --------------------------- */

// ExportPackage hands out the document and the registry it projects to, without
// the revision the destination store has no business inheriting. The name is
// not `Export` because that one already belongs to the rollback's on-disk
// package (export.go); the wire method is still `Export`.
func (s *Service) ExportPackage(ctx context.Context, caller Caller, scope pb.SettingsScope, deviceID string) (*pb.ExportSettingsResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	key, err := documentKey(scope, deviceID)
	if err != nil {
		return nil, err
	}
	document, err := s.document(ctx, key)
	if err != nil {
		return nil, err
	}
	hosts := []*pb.ExecutionHost{}
	if scope == pb.SettingsScope_SETTINGS_SCOPE_GLOBAL {
		if hosts, err = projectExecutionHosts(document.Document); err != nil {
			return nil, err
		}
	}
	return &pb.ExportSettingsResponse{
		Package: &pb.SettingsPackage{
			Version:          PackageVersion,
			Document:         document.Document,
			SchemaVersion:    document.SchemaVersion,
			ExecutionHosts:   hosts,
			ExportedAtUnixMs: s.now(),
		},
		Revision: document.Revision,
	}, nil
}

// ImportPackage writes a package as the document, under the same compare-and-set
// and the same idempotency as an ordinary save. The wire method is `Import`.
//
// The package's own `execution_hosts` are not written: they are what the
// exporter saw, and the importer re-projects from the document so the two can
// never be stored disagreeing.
func (s *Service) ImportPackage(ctx context.Context, caller Caller, request *pb.ImportSettingsRequest) (*pb.ImportSettingsResponse, error) {
	if request == nil || request.Package == nil {
		return nil, ErrInvalid
	}
	if request.Package.Version != PackageVersion {
		return nil, ErrInvalid
	}
	document := &pb.SettingsDocument{
		Scope:         request.Scope,
		DeviceId:      request.DeviceId,
		Document:      request.Package.Document,
		Sha256:        digest(request.Package.Document),
		SchemaVersion: request.Package.SchemaVersion,
	}
	saved, err := s.Put(ctx, caller, &pb.PutSettingsRequest{
		Meta:             request.Meta,
		OperationId:      request.OperationId,
		ExpectedRevision: request.ExpectedRevision,
		Document:         document,
	})
	if err != nil {
		return nil, err
	}
	hosts, err := s.executionHosts(ctx)
	if err != nil {
		return nil, err
	}
	return &pb.ImportSettingsResponse{Document: saved.Document, Receipt: saved.Receipt, ExecutionHosts: hosts}, nil
}

/* --------------------------- one host at a time --------------------------- */

// PutExecutionHost replaces or appends one entry of `settings.ssh.hosts[]`.
func (s *Service) PutExecutionHost(ctx context.Context, caller Caller, request *pb.PutExecutionHostRequest) (*pb.PutExecutionHostResponse, error) {
	if request == nil || request.ExecutionHost == nil {
		return nil, ErrInvalid
	}
	host := request.ExecutionHost
	// This machine is always in the list and is never stored. Its identifier is
	// the empty string, which is not a storage key at all, so a request to
	// write it is asking for a row that cannot exist.
	if !validExecutionHostID(host.ExecutionHostId) {
		return nil, ErrInvalid
	}
	if host.Kind != pb.ExecutionHostKind_EXECUTION_HOST_KIND_SSH {
		return nil, ErrInvalid
	}
	saved, err := s.writeRegistry(ctx, caller, request.Meta, request.OperationId, request.ExpectedRevision,
		func(hosts []*pb.ExecutionHost) ([]*pb.ExecutionHost, error) {
			for index, existing := range hosts {
				if existing.ExecutionHostId == host.ExecutionHostId {
					hosts[index] = host
					return hosts, nil
				}
			}
			if len(hosts) >= MaxExecutionHosts {
				return nil, ErrTooManyChanges
			}
			return append(hosts, host), nil
		})
	if err != nil {
		return nil, err
	}
	stored, err := s.storedExecutionHost(ctx, host.ExecutionHostId)
	if err != nil {
		return nil, err
	}
	return &pb.PutExecutionHostResponse{ExecutionHost: stored, Receipt: saved.Receipt, Document: saved.Document}, nil
}

// DeleteExecutionHost removes one entry. An identifier the registry does not
// hold is NOT_FOUND rather than a no-op receipt: a client that thought it was
// deleting something has to be told it was not.
func (s *Service) DeleteExecutionHost(ctx context.Context, caller Caller, request *pb.DeleteExecutionHostRequest) (*pb.DeleteExecutionHostResponse, error) {
	if request == nil || !validExecutionHostID(request.ExecutionHostId) {
		return nil, ErrInvalid
	}
	found := false
	saved, err := s.writeRegistry(ctx, caller, request.Meta, request.OperationId, request.ExpectedRevision,
		func(hosts []*pb.ExecutionHost) ([]*pb.ExecutionHost, error) {
			remaining := make([]*pb.ExecutionHost, 0, len(hosts))
			for _, existing := range hosts {
				if existing.ExecutionHostId == request.ExecutionHostId {
					found = true
					continue
				}
				remaining = append(remaining, existing)
			}
			if !found {
				return nil, storage.ErrNotFound
			}
			return remaining, nil
		})
	if err != nil {
		return nil, err
	}
	return &pb.DeleteExecutionHostResponse{Receipt: saved.Receipt, Document: saved.Document}, nil
}

func (s *Service) storedExecutionHost(ctx context.Context, id string) (*pb.ExecutionHost, error) {
	entity, err := s.store.Read(ctx, executionHostKey(id))
	if err != nil {
		return nil, err
	}
	if entity.Deleted {
		return nil, storage.ErrNotFound
	}
	return decodeHost(entity)
}

// writeRegistry is the shared shape of both host writes: read the global
// document at the caller's revision, edit `ssh.hosts` and nothing else, and
// save it through the one writer.
func (s *Service) writeRegistry(
	ctx context.Context,
	caller Caller,
	meta *pb.CommandMeta,
	operationID string,
	expectedRevision uint64,
	edit func([]*pb.ExecutionHost) ([]*pb.ExecutionHost, error),
) (*pb.PutSettingsResponse, error) {
	// Authorized before the read so an unauthorized caller cannot use the error
	// shape to learn whether a document exists.
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	key := storage.Key{Kind: KindDocument, ID: GlobalEntityID}
	document, err := s.document(ctx, key)
	if err != nil {
		return nil, err
	}
	if document.Revision != expectedRevision {
		return nil, &storage.RevisionConflict{Key: key, Expected: expectedRevision, Actual: document.Revision}
	}
	hosts, err := projectExecutionHosts(document.Document)
	if err != nil {
		return nil, err
	}
	edited, err := edit(hosts)
	if err != nil {
		return nil, err
	}
	next, err := spliceExecutionHosts(document.Document, edited)
	if err != nil {
		return nil, err
	}
	return s.Put(ctx, caller, &pb.PutSettingsRequest{
		Meta:             meta,
		OperationId:      operationID,
		ExpectedRevision: expectedRevision,
		Document: &pb.SettingsDocument{
			Scope:         pb.SettingsScope_SETTINGS_SCOPE_GLOBAL,
			Document:      next,
			Sha256:        digest(next),
			SchemaVersion: document.SchemaVersion,
		},
	})
}

/* ------------------------------- the JSON edit ---------------------------- */

// spliceExecutionHosts rewrites `ssh.hosts` and leaves the rest of the document
// exactly as it was.
//
// Every other top-level member keeps its stored bytes and its stored position,
// and so does every key inside `ssh` other than `hosts`. That matters twice: a
// whole-document re-marshal in Go would sort keys the Runtime wrote in another
// order, changing the digest a switch compares for no reason anybody could
// read; and it would drop nothing visibly while quietly re-encoding numbers the
// Runtime had written differently.
func spliceExecutionHosts(document []byte, hosts []*pb.ExecutionHost) ([]byte, error) {
	members, err := topLevelMembers(document)
	if err != nil {
		return nil, err
	}
	encoded, err := encodeHostArray(hosts)
	if err != nil {
		return nil, err
	}
	ssh, err := replaceMember(members.value("ssh"), "hosts", encoded)
	if err != nil {
		return nil, err
	}
	return members.with("ssh", ssh).marshal()
}

// jsonMembers is one JSON object read as an ordered list of members, each
// keeping the raw bytes it was stored with.
type jsonMembers []jsonMember

type jsonMember struct {
	key   string
	value json.RawMessage
}

func (m jsonMembers) value(key string) json.RawMessage {
	for _, member := range m {
		if member.key == key {
			return member.value
		}
	}
	return nil
}

// with replaces a member in place, or appends it when the document never had
// one. Appending at the end is the only position that is not a guess.
func (m jsonMembers) with(key string, value json.RawMessage) jsonMembers {
	for index, member := range m {
		if member.key == key {
			m[index].value = value
			return m
		}
	}
	return append(m, jsonMember{key: key, value: value})
}

func (m jsonMembers) marshal() ([]byte, error) {
	buffer := bytes.NewBuffer(make([]byte, 0, 256))
	buffer.WriteByte('{')
	for index, member := range m {
		if index > 0 {
			buffer.WriteByte(',')
		}
		key, err := json.Marshal(member.key)
		if err != nil {
			return nil, ErrInvalid
		}
		buffer.Write(key)
		buffer.WriteByte(':')
		buffer.Write(member.value)
	}
	buffer.WriteByte('}')
	if buffer.Len() > MaxDocumentBytes {
		return nil, ErrInvalid
	}
	return buffer.Bytes(), nil
}

// topLevelMembers streams the object's members so their order and their bytes
// both survive. `json.Unmarshal` into a map would lose the order and
// `json.Marshal` would then sort it.
func topLevelMembers(document []byte) (jsonMembers, error) {
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, ErrInvalid
	}
	members := jsonMembers{}
	seen := map[string]bool{}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return nil, ErrInvalid
		}
		name, ok := key.(string)
		// A repeated key would make "which one is the document" a question
		// about the decoder rather than about the bytes.
		if !ok || seen[name] {
			return nil, ErrInvalid
		}
		seen[name] = true
		value := json.RawMessage{}
		if err := decoder.Decode(&value); err != nil {
			return nil, ErrInvalid
		}
		members = append(members, jsonMember{key: name, value: value})
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return nil, ErrInvalid
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return nil, ErrInvalid
	}
	if len(members) > MaxTopLevelKeys {
		return nil, ErrInvalid
	}
	return members, nil
}

// replaceMember sets one key inside a nested object, preserving the rest. A
// missing or null section becomes a fresh object with just this key.
func replaceMember(section json.RawMessage, key string, value json.RawMessage) (json.RawMessage, error) {
	if len(bytes.TrimSpace(section)) == 0 || bytes.Equal(bytes.TrimSpace(section), []byte("null")) {
		return jsonMembers{{key: key, value: value}}.marshal()
	}
	members, err := topLevelMembers(section)
	if err != nil {
		return nil, err
	}
	return members.with(key, value).marshal()
}

// sshHostJSONOut is the shape written back into `settings.ssh.hosts[]`. It is
// the reading half's shape (`sshHostJSON`) with the omissions the Runtime's
// own serializer makes, so a host written here and one written by the Runtime
// parse to the same entry.
//
// A field the Host does not model — `extraArgs`, say — is not lost by a write
// through this door: a host is only ever *replaced* whole by a caller that
// read it, and the caller that reads it is the front end, which does model
// them. What is not modelled here is simply not something this Host decides.
type sshHostJSONOut struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Host         string            `json:"host"`
	User         string            `json:"user,omitempty"`
	Port         uint32            `json:"port,omitempty"`
	IdentityFile string            `json:"identityFile,omitempty"`
	Worker       *sshWorkerJSONOut `json:"worker,omitempty"`
}

type sshWorkerJSONOut struct {
	Path     string `json:"path"`
	StateDir string `json:"stateDir,omitempty"`
}

func encodeHostArray(hosts []*pb.ExecutionHost) (json.RawMessage, error) {
	sorted := make([]*pb.ExecutionHost, 0, len(hosts))
	seen := map[string]bool{}
	for _, host := range hosts {
		if host == nil || !validExecutionHostID(host.ExecutionHostId) || seen[host.ExecutionHostId] {
			return nil, ErrInvalid
		}
		seen[host.ExecutionHostId] = true
		sorted = append(sorted, host)
	}
	sort.SliceStable(sorted, func(a, b int) bool {
		return sorted[a].ExecutionHostId < sorted[b].ExecutionHostId
	})
	entries := make([]sshHostJSONOut, 0, len(sorted))
	for _, host := range sorted {
		entry := sshHostJSONOut{
			ID:           host.ExecutionHostId,
			Name:         host.Name,
			Host:         host.GetSsh().GetHost(),
			User:         host.GetSsh().GetUser(),
			Port:         host.GetSsh().GetPort(),
			IdentityFile: host.GetSsh().GetIdentityFile(),
		}
		if path := host.GetSsh().GetWorkerPath(); path != "" {
			entry.Worker = &sshWorkerJSONOut{Path: path, StateDir: host.GetSsh().GetStateDir()}
		}
		entries = append(entries, entry)
	}
	encoded, err := json.Marshal(entries)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalid, err)
	}
	return encoded, nil
}
