package agenthost

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// The reverse export a rollback owes the Runtime (Go Host 业务所有权迁移 §2.12).
//
// The package format is the one `canvashost`, `fshost` and `sessionhost` write
// and the Runtime's single reader applies: format version 2, a JSON
// `export.json` naming the domain, the epoch and one file per workspace, each
// file a length-prefixed sequence of `ReverseExportRecord`. What keeps four
// writers of one format honest is that there is exactly one reader, in the
// Runtime, and it refuses anything it cannot describe.
//
// What differs is only the content. An agent package carries, per workspace,
// every record the domain holds in a fixed order — statuses, approvals, mailbox
// messages, deliveries, handoffs, context links — because they reference each
// other: an approval whose node has no status is an approval no board can draw,
// and a handoff whose message is missing is a bundle nobody can read.
//
// The canonical digest clears everything the Runtime has nowhere to store: this
// Host's revisions, the digests it computed itself, and the claim fields the
// folded outbox added. Including them would make the comparison that decides
// whether a rollback landed permanently false.

const (
	// ExportFormatVersion is the package's own contract version.
	ExportFormatVersion = 2
	// ExportDomain is written into the index so a reader refuses a package
	// meant for another domain instead of applying it to this one.
	ExportDomain = storage.OwnershipDomainAgent
	// ExportIndexFile is the package's own description, JSON so an operator can
	// read a rollback package without a decoder.
	ExportIndexFile = "export.json"
)

type exportFile struct {
	Name          string `json:"name"`
	WorkspaceID   string `json:"workspaceId"`
	Bytes         uint64 `json:"bytes"`
	Sha256        string `json:"sha256"`
	ContentSha256 string `json:"contentSha256"`
	EntityCount   uint64 `json:"entityCount"`
}

type exportIndex struct {
	FormatVersion int          `json:"formatVersion"`
	HostID        string       `json:"hostId"`
	Epoch         uint64       `json:"epoch"`
	EventSequence uint64       `json:"eventSequence"`
	Domain        string       `json:"domain"`
	EntityCount   uint64       `json:"entityCount"`
	Files         []exportFile `json:"files"`
}

// workspaceRecords is one workspace's whole agent domain, in the order both
// sides serialize it. The order is part of the contract: a digest over the same
// records in a different order is a different digest.
type workspaceRecords struct {
	statuses   []storage.AgentStatus
	approvals  []storage.Approval
	messages   []storage.MailboxMessage
	deliveries []storage.Delivery
	handoffs   []storage.Handoff
	links      []storage.ContextLinks
}

func (w workspaceRecords) count() uint64 {
	return uint64(len(w.statuses) + len(w.approvals) + len(w.messages) + len(w.deliveries) + len(w.handoffs) + len(w.links))
}

// records builds the package's own sequence. `canonical` clears what the
// Runtime cannot store, which is what both sides hash.
func (w workspaceRecords) records(canonical bool) []*pb.ReverseExportRecord {
	out := make([]*pb.ReverseExportRecord, 0, w.count())
	for _, status := range w.statuses {
		value := statusMessage(status)
		if canonical {
			value.Revision = 0
			value.UpdatedAtUnixMs = 0
		}
		out = append(out, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_AgentStatus{AgentStatus: value}})
	}
	for _, approval := range w.approvals {
		value := approvalMessage(approval)
		if canonical {
			value.Revision = 0
			// The digest is this Host's own computation over a body the Runtime
			// stores as text. Comparing it would compare an artefact of the
			// projection rather than the question.
			value.RequestSha256 = nil
			value.ReasonCode = ""
		}
		out = append(out, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_Approval{Approval: value}})
	}
	for _, message := range w.messages {
		value := mailboxMessage(message)
		if canonical {
			value.Revision = 0
		}
		out = append(out, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_MailboxMessage{MailboxMessage: value}})
	}
	for _, delivery := range w.deliveries {
		value := deliveryMessage(delivery)
		if canonical {
			value.Revision = 0
			value.ReasonCode = ""
		}
		out = append(out, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_Delivery{Delivery: value}})
	}
	for _, handoff := range w.handoffs {
		value := handoffMessage(handoff)
		if canonical {
			value.Revision = 0
			value.BundleSha256 = nil
			value.UpdatedAtUnixMs = 0
		}
		out = append(out, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_Handoff{Handoff: value}})
	}
	for _, links := range w.links {
		value, err := contextLinksMessage(links)
		if err != nil {
			continue
		}
		if canonical {
			value.Revision = 0
			value.UpdatedAtUnixMs = 0
		}
		out = append(out, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_ContextLinks{ContextLinks: value}})
	}
	return out
}

// Export writes every agent record this Host holds into `directory` and reads
// the result back. The directory must be empty: overwriting a package would
// destroy the only copy of a previous reversal attempt.
func (s *Service) Export(ctx context.Context, directory string, epoch uint64) (*pb.OwnershipReport, error) {
	if !filepath.IsAbs(directory) {
		return nil, ErrInvalid
	}
	if info, err := os.Lstat(directory); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, ErrInvalid
		}
		entries, err := os.ReadDir(directory)
		if err != nil {
			return nil, err
		}
		if len(entries) != 0 {
			return nil, ErrInvalid
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	} else if err = os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	if err := storage.ProtectArtifactDirectory(directory); err != nil {
		return nil, err
	}
	_, watermark, err := s.store.Watermark(ctx)
	if err != nil {
		return nil, err
	}
	grouped, order, err := s.grouped(ctx)
	if err != nil {
		return nil, err
	}
	index := exportIndex{
		FormatVersion: ExportFormatVersion,
		HostID:        s.options.HostID,
		Epoch:         epoch,
		EventSequence: watermark,
		Domain:        ExportDomain,
	}
	for _, workspaceID := range order {
		group := grouped[workspaceID]
		encoded, err := encodeRecords(group.records(false))
		if err != nil {
			return nil, err
		}
		canonical, err := encodeRecords(group.records(true))
		if err != nil {
			return nil, err
		}
		name := hex.EncodeToString(digest([]byte(workspaceID))[:16]) + ".pb"
		if err = writeExactly(filepath.Join(directory, name), encoded); err != nil {
			return nil, err
		}
		index.EntityCount += group.count()
		index.Files = append(index.Files, exportFile{
			Name:          name,
			WorkspaceID:   workspaceID,
			Bytes:         uint64(len(encoded)),
			Sha256:        hex.EncodeToString(digest(encoded)),
			ContentSha256: hex.EncodeToString(digest(canonical)),
			EntityCount:   group.count(),
		})
	}
	encoded, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		return nil, err
	}
	if err = writeExactly(filepath.Join(directory, ExportIndexFile), append(encoded, '\n')); err != nil {
		return nil, err
	}

	// Read the package back. A digest computed from the buffer that was just
	// written proves nothing about what reached the disk, and this package is
	// the only copy of a domain the Host is about to stop owning.
	differences := []string{}
	for _, file := range index.Files {
		stored, err := os.ReadFile(filepath.Join(directory, file.Name))
		if err != nil {
			return nil, err
		}
		if uint64(len(stored)) != file.Bytes || hex.EncodeToString(digest(stored)) != file.Sha256 {
			differences = append(differences, file.WorkspaceID)
		}
	}
	builder := new(checkBuilder)
	builder.record("agent.export_records", uint64(len(index.Files)), uint64(len(index.Files)), differences)
	report := &pb.OwnershipReport{
		Domain:           pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_AGENT,
		Checks:           builder.checks,
		Matched:          len(differences) == 0,
		EntityCount:      index.EntityCount,
		VerifiedAtUnixMs: s.now(),
	}
	if !report.Matched {
		return report, ownership.ErrNotVerified
	}
	return report, nil
}

// grouped reads every record, grouped by workspace and ordered so two exports
// of an unchanged Host produce identical bytes.
func (s *Service) grouped(ctx context.Context) (map[string]*workspaceRecords, []string, error) {
	grouped := map[string]*workspaceRecords{}
	order := []string{}
	group := func(workspaceID string) *workspaceRecords {
		if _, seen := grouped[workspaceID]; !seen {
			grouped[workspaceID] = &workspaceRecords{}
			order = append(order, workspaceID)
		}
		return grouped[workspaceID]
	}
	statuses, err := s.store.AllAgentStatus(ctx)
	if err != nil {
		return nil, nil, err
	}
	for _, status := range statuses {
		into := group(status.WorkspaceID)
		into.statuses = append(into.statuses, status)
	}
	approvals, err := s.store.AllApprovals(ctx)
	if err != nil {
		return nil, nil, err
	}
	for _, approval := range approvals {
		into := group(approval.WorkspaceID)
		into.approvals = append(into.approvals, approval)
	}
	messages, err := s.store.AllMailbox(ctx)
	if err != nil {
		return nil, nil, err
	}
	for _, message := range messages {
		into := group(message.WorkspaceID)
		into.messages = append(into.messages, message)
	}
	deliveries, err := s.store.AllDeliveries(ctx)
	if err != nil {
		return nil, nil, err
	}
	for _, delivery := range deliveries {
		into := group(delivery.WorkspaceID)
		into.deliveries = append(into.deliveries, delivery)
	}
	handoffs, err := s.store.AllHandoffs(ctx)
	if err != nil {
		return nil, nil, err
	}
	for _, handoff := range handoffs {
		into := group(handoff.WorkspaceID)
		into.handoffs = append(into.handoffs, handoff)
	}
	links, err := s.store.AllContextLinks(ctx)
	if err != nil {
		return nil, nil, err
	}
	for _, record := range links {
		into := group(record.WorkspaceID)
		into.links = append(into.links, record)
	}
	sort.Strings(order)
	return grouped, order, nil
}

// encodeRecords writes a length-prefixed record sequence, matching the Worker
// frame convention, so a truncated file is a short read rather than a
// half-decoded record.
func encodeRecords(records []*pb.ReverseExportRecord) ([]byte, error) {
	payload := []byte(nil)
	for _, record := range records {
		encoded, err := (proto.MarshalOptions{Deterministic: true}).Marshal(record)
		if err != nil {
			return nil, err
		}
		if len(encoded) == 0 {
			// An empty record decodes to "no entity", which a reader refuses.
			return nil, ErrInvalid
		}
		payload = binary.BigEndian.AppendUint32(payload, uint32(len(encoded)))
		payload = append(payload, encoded...)
	}
	return payload, nil
}

// readExportIndex reads back the index of a package this Host wrote, with the
// digest of the exact bytes on disk. That digest is what the Runtime is told to
// expect, so a package edited between writing and applying is refused by the
// reader rather than trusted because we wrote it.
func readExportIndex(directory string) (*exportIndex, []byte, error) {
	raw, err := os.ReadFile(filepath.Join(directory, ExportIndexFile))
	if err != nil {
		return nil, nil, err
	}
	index := new(exportIndex)
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(index); err != nil {
		return nil, nil, err
	}
	if index.FormatVersion != ExportFormatVersion || index.Domain != ExportDomain {
		return nil, nil, ErrInvalid
	}
	return index, digest(raw), nil
}

// writeExactly refuses to replace an existing file. A rollback package is
// written once; a second attempt uses a new directory so the first stays intact.
func writeExactly(path string, payload []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	written, err := file.Write(payload)
	if err == nil && written != len(payload) {
		err = errors.New("short write")
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	stored, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if !bytes.Equal(stored, payload) {
		return errors.New("export file changed while it was written")
	}
	return nil
}
