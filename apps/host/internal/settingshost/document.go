// Package settingshost is the Host's settings surface
// (Go Host 业务所有权迁移 §2.4, batch B1).
//
// Settings are one document, not a table: the whole camelCase JSON object
// carries one revision, because a settings page saves several sections at once
// and a per-key revision would let two saves interleave into a document neither
// of them ever read.
//
// Three rules from the contract are enforced here rather than restated:
//
//  1. The bytes are the document. What is stored is the exact content of the
//     Runtime's settings.json, never a re-serialization of a parsed tree, so a
//     digest depends on nothing but the bytes that were written.
//  2. The Host validates structure, not meaning. A JSON object, a size ceiling,
//     a schema version, printable top-level keys. Whether a custom agent
//     definition is coherent or a keybinding reachable is decided once, in
//     packages/shared and in the Runtime at startup; a second rule set here
//     could disagree with them and there would be no way to tell which was
//     right.
//  3. Execution hosts are a projection, never a second source. Writing one
//     means writing the document (execution_hosts.go).
//
// The package owns no execution. It never opens an SSH connection, never
// starts a Worker and never reads a file the document names.
package settingshost

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"sort"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const (
	ScopeRead  = "settings:read"
	ScopeWrite = "settings:write"

	// The two stored kinds. Both are host-wide: their entities carry an empty
	// workspace id, because the document belongs to the machine rather than to
	// any one project on it.
	KindDocument      = "settings.document"
	KindExecutionHost = "settings.executionHost"

	// GlobalEntityID is the document that follows the account. A per-device
	// overlay is stored under DevicePrefix + its device id, so the two can
	// never be read as each other.
	GlobalEntityID = "global"
	DevicePrefix   = "device:"

	// DocumentSchemaVersion is the document shape this Host recognises. An
	// unknown one is refused on the way in rather than stored and handed to a
	// Runtime that reads an older shape.
	DocumentSchemaVersion = 1

	// MaxDocumentBytes is the contract's own ceiling (settings.proto).
	MaxDocumentBytes = 1 << 20
	// MaxTopLevelKeys bounds the key set the consistency checks compare. A
	// document with more is refused rather than compared partially.
	MaxTopLevelKeys = 256
	// MaxExecutionHosts bounds one document's host registry, so a single write
	// cannot exceed what one transaction may carry.
	MaxExecutionHosts = 128
	// MaxOperationIDBytes matches the canvas surface: the identifier is an
	// idempotency key a client chose, never an authorization token.
	MaxOperationIDBytes = 200
)

var (
	ErrInvalid       = errors.New("invalid settings request")
	ErrAuthorization = errors.New("settings permission denied")
	// ErrOwnershipMoved is the stable refusal a write gets when this process is
	// not the settled owner of the settings domain. It is the same code the
	// canvas surface uses, so a client can act on it without having to tell
	// "the Host will not write" from "the Runtime will not".
	ErrOwnershipMoved = errors.New("ownership_moved")
	// ErrTooManyChanges means one write needs more changes than a single
	// transaction may carry. It is refused rather than split, because a split
	// write would publish a document whose host registry disagreed with it.
	ErrTooManyChanges = errors.New("settings request exceeds one transaction")
)

// Identifiers keep the shape the rest of the Host already uses. The separator
// entity ids are composed with is excluded from the first position, so a device
// overlay can never be spelled as the global document.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$`)

func validID(value string) bool { return idPattern.MatchString(value) }

// An execution host's identifier is not this Host's to define: it was already
// written into `settings.ssh.hosts[]` by the Runtime, whose own rule is
// `[A-Za-z0-9_-]` up to 64 characters (`terminal/ssh.rs`, `packages/shared`).
// Holding it to a narrower alphabet here would not reject a bad id — it would
// make a perfectly ordinary registry, one host called `build_box`, refuse to
// project, and the settings domain could then never be switched at all.
var executionHostIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,119}$`)

func validExecutionHostID(value string) bool {
	return executionHostIDPattern.MatchString(value)
}

// importIDPattern is the shape the ownership state machine already accepts.
// The identifier becomes part of a storage operation key, so it is held to the
// same alphabet here rather than trusted because it arrived from the CLI.
var importIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func validImportID(value string) bool { return importIDPattern.MatchString(value) }

func digest(value []byte) []byte {
	sum := sha256.Sum256(value)
	return sum[:]
}

// documentKey composes the storage key one scope reads and writes. A DEVICE
// document with no device id is refused rather than treated as the global one,
// which is exactly the confusion settings.proto names.
func documentKey(scope pb.SettingsScope, deviceID string) (storage.Key, error) {
	switch scope {
	case pb.SettingsScope_SETTINGS_SCOPE_GLOBAL:
		if deviceID != "" {
			return storage.Key{}, ErrInvalid
		}
		return storage.Key{Kind: KindDocument, ID: GlobalEntityID}, nil
	case pb.SettingsScope_SETTINGS_SCOPE_DEVICE:
		if !validID(deviceID) {
			return storage.Key{}, ErrInvalid
		}
		return storage.Key{Kind: KindDocument, ID: DevicePrefix + deviceID}, nil
	default:
		return storage.Key{}, ErrInvalid
	}
}

func executionHostKey(id string) storage.Key {
	return storage.Key{Kind: KindExecutionHost, ID: id}
}

// validateStructure is the whole of the Host's structural check. Each clause is
// something a reader on either side would otherwise have to guess about; none
// of them is a judgement about what a setting means.
func validateStructure(value *pb.SettingsDocument) error {
	if value == nil {
		return ErrInvalid
	}
	if _, err := documentKey(value.Scope, value.DeviceId); err != nil {
		return err
	}
	if value.SchemaVersion != DocumentSchemaVersion {
		return ErrInvalid
	}
	if len(value.Document) == 0 || len(value.Document) > MaxDocumentBytes {
		return ErrInvalid
	}
	if _, err := topLevelKeys(value.Document); err != nil {
		return err
	}
	return nil
}

// validateDocument additionally holds the caller to its own digest. A client
// that hashed something else — a re-encoded tree, or another document entirely
// — is making a claim about bytes it did not send, and storing it would make
// every later comparison silently false.
//
// It is deliberately not applied to a document that arrives from the Runtime
// during a switch: there, a digest that does not describe the bytes is a
// difference the operator has to see named in the report, not an opaque
// refusal (verify.go, `settings.document_sha256`).
func validateDocument(value *pb.SettingsDocument) error {
	if err := validateStructure(value); err != nil {
		return err
	}
	if !bytes.Equal(value.Sha256, digest(value.Document)) {
		return ErrInvalid
	}
	return nil
}

// topLevelKeys reads the document's own key set, which is what the consistency
// checks compare across a switch. It is also the parse that proves the payload
// is one JSON object and nothing else: a fragment, an array or a trailing
// second value would each read as a document that had lost keys.
func topLevelKeys(document []byte) ([]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	fields := map[string]json.RawMessage{}
	if err := decoder.Decode(&fields); err != nil {
		return nil, ErrInvalid
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return nil, ErrInvalid
	}
	if len(fields) > MaxTopLevelKeys {
		return nil, ErrInvalid
	}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		// An empty or control-bearing key cannot be reported in a difference
		// list or matched against the Runtime's own, so it is refused here
		// rather than compared later and always found unequal.
		if key == "" || len(key) > 256 || strings.ContainsFunc(key, func(r rune) bool { return r < 32 || r == 127 }) {
			return nil, ErrInvalid
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys, nil
}

// Payloads are stored without their revision and with the timestamp this
// service set: storage owns the revision, and a second copy inside the bytes
// would let the two drift. Marshalling is deterministic so an unchanged object
// produces identical bytes and therefore no event.
func encode(message proto.Message) ([]byte, error) {
	return (proto.MarshalOptions{Deterministic: true}).Marshal(message)
}

// encodeDocument stores the bytes and a digest taken from those bytes. The
// digest is derived here rather than carried through, so what is stored can
// never claim to be a hash of something it is not — which is what makes the
// consistency check against the Worker's own reported digest a real comparison.
func encodeDocument(value *pb.SettingsDocument, updatedAt int64) ([]byte, error) {
	clone, _ := proto.Clone(value).(*pb.SettingsDocument)
	clone.Revision = 0
	clone.UpdatedAtUnixMs = updatedAt
	clone.Sha256 = digest(clone.Document)
	return encode(clone)
}

func decodeDocument(entity storage.Entity) (*pb.SettingsDocument, error) {
	value := new(pb.SettingsDocument)
	if err := proto.Unmarshal(entity.Payload, value); err != nil {
		return nil, storage.ErrCorrupt
	}
	value.Revision = entity.Revision
	return value, nil
}

func encodeHost(value *pb.ExecutionHost, updatedAt int64) ([]byte, error) {
	clone, _ := proto.Clone(value).(*pb.ExecutionHost)
	clone.Revision = 0
	clone.UpdatedAtUnixMs = updatedAt
	return encode(clone)
}

func decodeHost(entity storage.Entity) (*pb.ExecutionHost, error) {
	value := new(pb.ExecutionHost)
	if err := proto.Unmarshal(entity.Payload, value); err != nil {
		return nil, storage.ErrCorrupt
	}
	value.Revision = entity.Revision
	return value, nil
}

// comparable strips the two facts storage and this service own — the revision
// and the timestamp — so "did this change" is a question about the content.
// Without it every save would rewrite every execution host, and the stream
// would name hosts nobody touched.
func comparable(message proto.Message) ([]byte, error) {
	switch value := proto.Clone(message).(type) {
	case *pb.SettingsDocument:
		value.Revision, value.UpdatedAtUnixMs = 0, 0
		// The digest is derived from the bytes being compared, so comparing it
		// as well would only let a caller's wrong digest look like a change.
		value.Sha256 = nil
		return encode(value)
	case *pb.ExecutionHost:
		value.Revision, value.UpdatedAtUnixMs = 0, 0
		return encode(value)
	default:
		return nil, ErrInvalid
	}
}

// operationKey namespaces the caller-supplied id by principal, so two devices
// cannot collide on a plain "save-1" and a replay is only ever matched against
// the same principal's own earlier request. There is no workspace in the key
// because there is no workspace in the document.
func operationKey(principalID, operationID string) (string, error) {
	if operationID == "" || len(operationID) > MaxOperationIDBytes || strings.ContainsAny(operationID, "\x00\n") {
		return "", ErrInvalid
	}
	return "settings/" + principalID + "/" + operationID, nil
}

// receipt echoes the operation id the caller sent, not the storage key it was
// namespaced into: a composed key would put this device's principal id in a
// response that never needs to carry one.
func receipt(operationID string, result storage.ApplyResult) *pb.CanvasOperationReceipt {
	value := &pb.CanvasOperationReceipt{
		OperationId:   operationID,
		TransactionId: result.TransactionID,
		FirstSequence: result.FirstSequence,
		LastSequence:  result.LastSequence,
		Replayed:      result.Replayed,
	}
	for _, revision := range result.Revisions {
		// The kind enum on this receipt has only canvas members, so it stays
		// unspecified rather than borrowing one that would name the wrong
		// thing. The entity id is what a client reconciles against, and it is
		// the identifier the client itself sent: the document's scope, or an
		// execution host id out of the document it just wrote.
		value.Revisions = append(value.Revisions, &pb.CanvasRevision{
			EntityId: revision.ID,
			Revision: revision.Revision,
			Deleted:  revision.Deleted,
		})
	}
	return value
}
