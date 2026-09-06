package settingshost

import (
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
)

// The settings domain's half of a write-ownership switch
// (Go Host 业务所有权迁移 §2.11, steps 3 and 4).
//
// The state machine lives in internal/ownership and knows nothing about
// settings. What it needs is three answers: how the data is taken over, how it
// is handed back, and where the Host's event stream stands.
//
// Taking settings over is not like taking the canvas over. The canvas arrives
// as a bundle `armadra-host import` staged on disk before the switch begins;
// the settings document has none, so it is read across the same live link the
// epoch moves on. That is why the adoption carries the link, and why a link
// that cannot answer a settings frame is refused here — before anything is
// written — rather than discovered halfway through a projection.

// Domain is the name this projector is registered under.
const Domain = storage.OwnershipDomainSettings

// Channel is the narrow part of the Runtime link this domain needs: read the
// execution host's document, and write one back. It is deliberately smaller
// than the Worker client that implements it, so a test supplies two functions
// rather than a process, and so a link without these frames fails a type
// assertion instead of a request that has already changed something.
type Channel interface {
	ExportSettings(ctx context.Context) (*pb.WorkerSettingsSnapshot, error)
	ImportSettings(ctx context.Context, request *pb.WorkerSettingsRequest) (*pb.WorkerSettingsSnapshot, error)
}

// Projector is the settings service seen as one domain of the switch.
type Projector struct{ service *Service }

// AsProjector exposes the settings service to the ownership state machine.
func (s *Service) AsProjector() Projector { return Projector{service: s} }

// Adopt reads the Runtime's document across the live link, projects it into
// entities, and verifies the result item for item. A report that did not match
// is returned with ErrNotVerified, not swallowed: the operator needs to see
// which check failed.
func (p Projector) Adopt(ctx context.Context, adoption ownership.Adoption) (*pb.OwnershipReport, error) {
	channel, ok := adoption.Link.(Channel)
	if !ok {
		// The link cannot carry a settings frame, so there is nothing to adopt.
		// Refusing here means no row was written and no epoch was touched.
		return nil, ownership.ErrUnsupportedDomain
	}
	if !validImportID(adoption.ImportID) {
		return nil, ErrInvalid
	}
	snapshot, err := channel.ExportSettings(ctx)
	if err != nil {
		return nil, err
	}
	document := snapshot.GetDocument()
	// Structure only. A digest that does not describe the bytes is not refused
	// here: it is what `settings.document_sha256` is for, and the operator
	// needs to see which check failed rather than a request-shaped error.
	if err = validateStructure(document); err != nil {
		return nil, err
	}
	// Only the account-wide document moves. A per-device overlay belongs to the
	// device that wrote it, and adopting one under the global key would hand
	// every device one laptop's keybindings.
	if document.Scope != pb.SettingsScope_SETTINGS_SCOPE_GLOBAL {
		return nil, ErrInvalid
	}
	if err = p.service.project(ctx, adoption.ImportID, document); err != nil {
		return nil, err
	}
	report, err := p.service.verifyAdoption(ctx, snapshot, adoption.ImportID)
	if err != nil {
		return nil, err
	}
	if !report.Matched {
		return report, ownership.ErrNotVerified
	}
	return report, nil
}

// Release hands the settings domain back. The export is only the first of the
// four steps: the package then goes to the Runtime, the Runtime re-reads its
// own file, and reverseImport compares those digests with the ones the package
// named.
//
// AcceptExportOnly is the one path that stops after the export. It exists
// because a Runtime too old to import at all would otherwise strand a Host that
// has to give the domain back, and everything the Host wrote then stays only
// inside the package.
func (p Projector) Release(ctx context.Context, handback ownership.Handback) (*pb.OwnershipReport, error) {
	report, err := p.service.Export(ctx, handback.Directory, handback.Epoch)
	if err != nil || handback.AcceptExportOnly {
		return report, err
	}
	// The epoch has not moved and the Host still holds every row, so a failed
	// import is recoverable: fix the cause, use a new export directory, run the
	// same rollback again.
	err = p.service.reverseImport(ctx, handback.Importer, handback.Directory, handback.Epoch, report)
	return report, err
}

// Watermark is the Host's event sequence right now.
func (p Projector) Watermark(ctx context.Context) (uint64, error) {
	_, watermark, err := p.service.store.Watermark(ctx)
	return watermark, err
}

// project writes the exported document and the hosts it implies in one
// transaction. The operation id is namespaced by the import, so re-running an
// interrupted switch replays rather than writing a second time — and when the
// first attempt did commit, the derived change set is empty and nothing is
// applied at all.
func (s *Service) project(ctx context.Context, importID string, document *pb.SettingsDocument) error {
	key, err := documentKey(document.Scope, document.DeviceId)
	if err != nil {
		return err
	}
	hosts, err := projectExecutionHosts(document.Document)
	if err != nil {
		return err
	}
	updatedAt := s.now()
	payload, err := encodeDocument(document, updatedAt)
	if err != nil {
		return err
	}
	changes := []storage.Change{}
	existing, err := s.store.Read(ctx, key)
	switch {
	case err == nil:
		same, err := sameStoredDocument(existing, document)
		if err != nil {
			return err
		}
		if existing.Deleted || !same {
			changes = append(changes, storage.Change{Key: key, ExpectedRevision: existing.Revision, Payload: payload})
		}
	case errors.Is(err, storage.ErrNotFound):
		changes = append(changes, storage.Change{Key: key, Payload: payload})
	default:
		return err
	}
	hostChanges, err := s.executionHostChanges(ctx, hosts, updatedAt)
	if err != nil {
		return err
	}
	changes = append(changes, hostChanges...)
	if len(changes) == 0 {
		return nil
	}
	if len(changes) > storage.MaxChanges {
		return ErrTooManyChanges
	}
	_, err = s.store.Apply(ctx, "ownership/settings/"+importID, changes)
	return err
}

func sameStoredDocument(entity storage.Entity, next *pb.SettingsDocument) (bool, error) {
	current, err := decodeDocument(entity)
	if err != nil {
		return false, err
	}
	return sameDocument(current, next)
}
