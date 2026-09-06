package fshost

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// The reverse export a rollback owes the Runtime (Go Host 业务所有权迁移 §2.12).
//
// The package format is the one `canvashost/export.go` writes and the Runtime's
// single reader applies: format version 2, a JSON `export.json` naming the
// domain, the epoch and one file per workspace, each file a length-prefixed
// sequence of `ReverseExportRecord`. Two Host-side writers of one format is one
// more than anyone wants; what keeps them honest is that there is exactly one
// reader, in the Runtime, and it refuses anything it cannot describe.
//
// What differs is only the content: a filesystem package carries one
// `WorkspaceRoot` per workspace, and its canonical digest clears the revision —
// a Host-side fact the Runtime has nowhere to store, so including it would make
// the comparison that decides whether the rollback landed permanently false.

const (
	// ExportFormatVersion is the package's own contract version. A reader that
	// does not recognise it refuses the package rather than parsing it
	// optimistically.
	ExportFormatVersion = 2
	// ExportDomain is written into the index so a reader refuses a package
	// meant for another domain instead of applying it to this one.
	ExportDomain = storage.OwnershipDomainFilesystem
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

func digest(value []byte) []byte {
	sum := sha256.Sum256(value)
	return sum[:]
}

// pathProof is the registration proof carried for a remote root: the digest of
// the execution host and the frozen path together. It is not a secret and not a
// capability — it is a fingerprint that makes "the same path on a different
// host" a different proof, so a package cannot be applied to a workspace whose
// files are somewhere else.
func pathProof(executionHostID, path string) []byte {
	sum := sha256.New()
	var size [8]byte
	for _, part := range []string{"armadra.filesystem.root.v1", executionHostID, path} {
		binary.BigEndian.PutUint64(size[:], uint64(len(part)))
		sum.Write(size[:])
		sum.Write([]byte(part))
	}
	return sum.Sum(nil)
}

// Export writes every registration this Host holds into `directory` and reads
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
	index := exportIndex{
		FormatVersion: ExportFormatVersion,
		HostID:        s.options.HostID,
		Epoch:         epoch,
		EventSequence: watermark,
		Domain:        ExportDomain,
	}
	roots, err := s.allRoots(ctx)
	if err != nil {
		return nil, err
	}
	for _, root := range roots {
		payload, content, err := encodeRoot(root)
		if err != nil {
			return nil, err
		}
		name := hex.EncodeToString(digest([]byte(root.WorkspaceID))[:16]) + ".pb"
		if err = writeExactly(filepath.Join(directory, name), payload); err != nil {
			return nil, err
		}
		index.EntityCount++
		index.Files = append(index.Files, exportFile{
			Name:          name,
			WorkspaceID:   root.WorkspaceID,
			Bytes:         uint64(len(payload)),
			Sha256:        hex.EncodeToString(digest(payload)),
			ContentSha256: hex.EncodeToString(content),
			EntityCount:   1,
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
	builder.record("filesystem.export_roots", uint64(len(index.Files)), uint64(len(index.Files)), differences)
	report := &pb.OwnershipReport{
		Domain:           pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_FILESYSTEM,
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

// allRoots reads every live registration, in workspace order. The read is
// complete on purpose: a partial package would be a rollback that quietly
// dropped a workspace's root.
func (s *Service) allRoots(ctx context.Context) ([]storage.WorkspaceRoot, error) {
	result := []storage.WorkspaceRoot{}
	after := ""
	for {
		page, more, err := s.store.ListWorkspaceRoots(ctx, after, MaxPage)
		if err != nil {
			return nil, err
		}
		result = append(result, page...)
		if !more || len(page) == 0 {
			return result, nil
		}
		after = page[len(page)-1].WorkspaceID
	}
}

// encodeRoot writes one workspace's entity file and its canonical digest. The
// file is a length-prefixed record sequence, matching the Worker frame
// convention, so a truncated file is a short read rather than a half-decoded
// registration.
func encodeRoot(root storage.WorkspaceRoot) (payload []byte, content []byte, err error) {
	value := message(root)
	encoded, err := (proto.MarshalOptions{Deterministic: true}).Marshal(&pb.ReverseExportRecord{
		Entity: &pb.ReverseExportRecord_WorkspaceRoot{WorkspaceRoot: value},
	})
	if err != nil {
		return nil, nil, err
	}
	if len(encoded) == 0 {
		// An empty record decodes to "no entity", which a reader refuses.
		return nil, nil, ErrInvalid
	}
	payload = binary.BigEndian.AppendUint32(nil, uint32(len(encoded)))
	payload = append(payload, encoded...)

	// The canonical form is what the Runtime's re-read is compared against, so
	// it carries only what the Runtime can store: the workspace, the execution
	// host, the frozen path and the three permission bits. The revision, the
	// registration proof and the registration timestamps are facts about this
	// Host's record rather than about where the files are, and including them
	// would make the comparison that decides whether a rollback landed
	// permanently false.
	canonical := &pb.WorkspaceRoot{
		WorkspaceId:     value.GetWorkspaceId(),
		ExecutionHostId: value.GetExecutionHostId(),
		CanonicalPath:   value.GetCanonicalPath(),
		Permissions:     value.GetPermissions(),
	}
	canonicalEncoded, err := (proto.MarshalOptions{Deterministic: true}).Marshal(&pb.ReverseExportRecord{
		Entity: &pb.ReverseExportRecord_WorkspaceRoot{WorkspaceRoot: canonical},
	})
	if err != nil {
		return nil, nil, err
	}
	framed := binary.BigEndian.AppendUint32(nil, uint32(len(canonicalEncoded)))
	return payload, digest(append(framed, canonicalEncoded...)), nil
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
