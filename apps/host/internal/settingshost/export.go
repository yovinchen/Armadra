package settingshost

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// The reverse export a rollback owes the Runtime
// (host protocol design §4, step 6; Go Host 业务所有权迁移 §2.12).
//
// Handing the epoch back is not the whole of a rollback. Whatever the Host
// stored while it owned settings has to travel back, so a rollback writes this
// package first and refuses to move the epoch if it cannot. The package is
// written, then read back off the disk and re-hashed: a digest taken from the
// buffer that was just written proves nothing about what reached the disk, and
// this package is the only copy of a domain the Host is about to stop owning.
//
// The index names the domain, the epoch and the event watermark, so a package
// cannot be applied to the wrong database, at the wrong epoch, or after the
// Host has written something the package does not carry.

// ExportFormatVersion is the package's own contract version. A reader that does
// not recognise it must refuse the package rather than parse it optimistically.
const ExportFormatVersion = 2

// ExportDomain is written into the index so a reader refuses a package meant
// for another domain instead of applying it to the settings file.
const ExportDomain = "settings"

const (
	ExportIndexFile    = "export.json"
	ExportDocumentFile = "settings-document.pb"
	ExportHostsFile    = "execution-hosts.pb"
)

type exportFile struct {
	Name   string `json:"name"`
	Bytes  uint64 `json:"bytes"`
	Sha256 string `json:"sha256"`
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

// Export writes the settings document and its execution hosts into `directory`
// and verifies the result. The directory must not already contain an export:
// overwriting one would destroy the only copy of a previous reversal attempt.
func (s *Service) Export(ctx context.Context, directory string, epoch uint64) (*pb.OwnershipReport, error) {
	if err := prepareExportDirectory(directory); err != nil {
		return nil, err
	}
	document, err := s.document(ctx, storage.Key{Kind: KindDocument, ID: GlobalEntityID})
	if err != nil {
		return nil, err
	}
	hosts, err := s.storedExecutionHosts(ctx)
	if err != nil {
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
		EntityCount:   uint64(1 + len(hosts)),
	}
	// The revision is a Host-side fact the Runtime has nowhere to store, so it
	// is cleared before the bytes go into the package: leaving it in would make
	// the Runtime's own re-read differ from the package for a reason that says
	// nothing about whether the settings arrived.
	encoded, err := encodeDocument(document, document.UpdatedAtUnixMs)
	if err != nil {
		return nil, err
	}
	hostPayload, err := encodeHosts(hosts)
	if err != nil {
		return nil, err
	}
	for _, file := range []struct {
		name    string
		payload []byte
	}{{ExportDocumentFile, encoded}, {ExportHostsFile, hostPayload}} {
		if err = writeExactly(filepath.Join(directory, file.name), file.payload); err != nil {
			return nil, err
		}
		index.Files = append(index.Files, exportFile{Name: file.name, Bytes: uint64(len(file.payload)), Sha256: hex.EncodeToString(digest(file.payload))})
	}
	description, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		return nil, err
	}
	if err = writeExactly(filepath.Join(directory, ExportIndexFile), append(description, '\n')); err != nil {
		return nil, err
	}

	builder := &checkBuilder{}
	differences := []string{}
	for _, file := range index.Files {
		stored, err := os.ReadFile(filepath.Join(directory, file.Name))
		if err != nil {
			return nil, err
		}
		if uint64(len(stored)) != file.Bytes || hex.EncodeToString(digest(stored)) != file.Sha256 {
			differences = append(differences, file.Name)
		}
	}
	// A per-device overlay the Host holds is not carried by this package: the
	// Worker frame writes one document, and the Runtime's settings file is the
	// account-wide one. Rather than drop it silently, the export reports it as
	// a difference, so a rollback refuses instead of losing a device's own
	// keybinding layer.
	stranded, err := s.strandedDocuments(ctx)
	if err != nil {
		return nil, err
	}
	builder.record("settings.export", uint64(len(index.Files)), uint64(len(index.Files)-len(differences)), append(differences, stranded...))

	report := &pb.OwnershipReport{
		Domain:           pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_SETTINGS,
		Checks:           builder.checks,
		EntityCount:      index.EntityCount,
		Matched:          builder.matched(),
		VerifiedAtUnixMs: s.now(),
	}
	if !report.Matched {
		return report, ownership.ErrNotVerified
	}
	return report, nil
}

// strandedDocuments names every stored document the package does not carry.
func (s *Service) strandedDocuments(ctx context.Context) ([]string, error) {
	page, err := s.store.List(ctx, storage.ListOptions{Kind: KindDocument, Limit: storage.MaxPageSize})
	if err != nil {
		return nil, err
	}
	result := []string{}
	for _, entity := range page.Entities {
		if entity.ID != GlobalEntityID {
			result = append(result, entity.ID)
		}
	}
	return result, nil
}

// prepareExportDirectory refuses anything but an empty or absent directory, and
// makes the one it creates private.
func prepareExportDirectory(directory string) error {
	if !filepath.IsAbs(directory) {
		return ErrInvalid
	}
	if info, err := os.Lstat(directory); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return ErrInvalid
		}
		entries, err := os.ReadDir(directory)
		if err != nil {
			return err
		}
		if len(entries) != 0 {
			return ErrInvalid
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	} else if err = os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	return storage.ProtectArtifactDirectory(directory)
}

// encodeHosts writes the host file: a four-byte big-endian length before each
// record, matching the Worker frame convention, so a reader takes one host at a
// time and a truncated file is a short read rather than a half-decoded registry.
func encodeHosts(hosts []*pb.ExecutionHost) ([]byte, error) {
	payload := []byte{}
	for _, host := range hosts {
		encoded, err := encodeHost(host, host.UpdatedAtUnixMs)
		if err != nil {
			return nil, err
		}
		if len(encoded) == 0 {
			// An empty record decodes to "no host", which a reader refuses.
			// Producing one would write a package nobody can apply.
			return nil, ErrInvalid
		}
		payload = binary.BigEndian.AppendUint32(payload, uint32(len(encoded)))
		payload = append(payload, encoded...)
	}
	return payload, nil
}

func decodeHosts(payload []byte) ([]*pb.ExecutionHost, error) {
	result := []*pb.ExecutionHost{}
	for len(payload) > 0 {
		if len(payload) < 4 {
			return nil, ErrInvalid
		}
		size := binary.BigEndian.Uint32(payload[:4])
		payload = payload[4:]
		if size == 0 || uint64(size) > uint64(len(payload)) {
			return nil, ErrInvalid
		}
		host := new(pb.ExecutionHost)
		if err := proto.Unmarshal(payload[:size], host); err != nil {
			return nil, ErrInvalid
		}
		result = append(result, host)
		payload = payload[size:]
	}
	return result, nil
}

// writeExactly refuses to replace an existing file. A rollback package is
// written once; a second attempt uses a new directory so the first is intact.
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

// ReadExportPackage reads back a package this Host wrote, re-hashing every file
// against the index. A package edited between writing and applying is refused
// by the reader rather than trusted because we wrote it.
func ReadExportPackage(directory string) (*pb.SettingsDocument, []*pb.ExecutionHost, error) {
	index, _, err := readExportIndex(directory)
	if err != nil {
		return nil, nil, err
	}
	payloads := map[string][]byte{}
	for _, file := range index.Files {
		stored, err := os.ReadFile(filepath.Join(directory, file.Name))
		if err != nil {
			return nil, nil, err
		}
		if uint64(len(stored)) != file.Bytes || hex.EncodeToString(digest(stored)) != file.Sha256 {
			return nil, nil, ErrInvalid
		}
		payloads[file.Name] = stored
	}
	document := new(pb.SettingsDocument)
	if err = proto.Unmarshal(payloads[ExportDocumentFile], document); err != nil {
		return nil, nil, ErrInvalid
	}
	hosts, err := decodeHosts(payloads[ExportHostsFile])
	if err != nil {
		return nil, nil, err
	}
	return document, hosts, nil
}

func readExportIndex(directory string) (*exportIndex, []byte, error) {
	raw, err := os.ReadFile(filepath.Join(directory, ExportIndexFile))
	if err != nil {
		return nil, nil, err
	}
	index := new(exportIndex)
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(index); err != nil {
		return nil, nil, ErrInvalid
	}
	if index.FormatVersion != ExportFormatVersion || index.Domain != ExportDomain {
		return nil, nil, ErrInvalid
	}
	return index, digest(raw), nil
}

// reverseImport applies a package this Host just wrote and appends the
// comparison to `report`. It returns an error unless the Runtime's own re-read
// carries the document and the registry the package named.
//
// The re-read is what makes the comparison worth doing. A report assembled from
// the request would say what the Runtime was asked to store; the digest of a
// re-read says what it actually holds.
func (s *Service) reverseImport(ctx context.Context, importer ownership.ReverseImporter, directory string, epoch uint64, report *pb.OwnershipReport) error {
	channel, ok := importer.(Channel)
	if !ok {
		// The link cannot carry a settings frame. The package is written and
		// intact, so the operator's remaining option is the danger switch, and
		// the epoch has not moved.
		return ownership.ErrReverseImportUnsupported
	}
	index, indexDigest, err := readExportIndex(directory)
	if err != nil {
		return err
	}
	if index.Epoch != epoch {
		return fmt.Errorf("%w: the package names epoch %d, not %d", ownership.ErrReverseImportFailed, index.Epoch, epoch)
	}
	document, hosts, err := ReadExportPackage(directory)
	if err != nil {
		return err
	}
	// The identifier is the package's own index digest, so re-running an
	// interrupted rollback replays the same import instead of starting another.
	importID := hex.EncodeToString(indexDigest)
	snapshot, err := channel.ImportSettings(ctx, &pb.WorkerSettingsRequest{
		Document:      document,
		ExpectedEpoch: epoch,
		ImportId:      importID,
		Direction:     pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_IMPORT,
	})
	if err != nil {
		return errors.Join(ownership.ErrReverseImportFailed, err)
	}

	builder := &checkBuilder{}
	stored := snapshot.GetDocument()

	digestDifferences := []string{}
	if !bytes.Equal(stored.GetSha256(), document.GetSha256()) {
		digestDifferences = append(digestDifferences, GlobalEntityID)
	}
	builder.record("reverse.settings.document_sha256", 1, 1, digestDifferences)

	packageKeys, err := topLevelKeys(document.GetDocument())
	if err != nil {
		return err
	}
	// A re-read that is not a JSON object at all is a difference on every key,
	// not a reason to stop comparing.
	storedKeys, keysErr := topLevelKeys(stored.GetDocument())
	if keysErr != nil {
		storedKeys = nil
	}
	builder.record("reverse.settings.keys", uint64(len(packageKeys)), uint64(len(storedKeys)), keyDifferences(packageKeys, storedKeys))

	workerHosts := sshOnly(snapshot.GetExecutionHosts())
	builder.record("reverse.settings.execution_hosts", uint64(len(hosts)), uint64(len(workerHosts)), compareExecutionHosts(hosts, workerHosts))

	// The Host's watermark must not have moved while the package was travelling.
	// If it did, the Host wrote something the package does not carry, and the
	// Runtime would resume from a document that is already behind.
	_, watermark, err := s.store.Watermark(ctx)
	if err != nil {
		return err
	}
	builder.record("reverse.event_sequence", index.EventSequence, watermark, nil)

	report.Checks = append(report.Checks, builder.checks...)
	if !builder.matched() {
		report.Matched = false
		return ownership.ErrReverseImportFailed
	}
	return nil
}
