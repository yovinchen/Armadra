// Package migration verifies offline exports and stores a resumable, inactive
// import. It never opens the original canvas.db or grants business ownership.
package migration

import (
	"context"
	"crypto/sha256"
	"embed"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

//go:embed legacy/*.sql
var legacy embed.FS

// The Runtime's own numbered migrations, byte for byte. An export is only
// accepted when its ledger matches a prefix of this list, so the importer
// recognises exactly the schemas it can read rather than trusting a version
// number. Appending here is how support for a newer Runtime schema is added;
// an existing entry must never change, because its checksum is what an
// already-exported database was recorded against.
//
// The version each entry stands for is its own file name, not its position:
// migration numbers are allocated ahead of time across parallel work, so the
// series can have a hole while one of them is still unmerged. The order stays
// the order they are applied in, and a source ledger must still be a prefix of
// it.
var legacyMigrations = []string{
	"legacy/0001_initial.sql",
	"legacy/0002_agent_mailbox.sql",
	"legacy/0003_retire_kanban.sql",
	"legacy/0004_agent_handoffs.sql",
	"legacy/0005_browser_sessions.sql",
	"legacy/0006_agent_prompt_deliveries.sql",
	"legacy/0007_handoff_attempts.sql",
	"legacy/0008_write_ownership.sql",
	"legacy/0009_workspace_execution_host.sql",
	"legacy/0010_host_imports.sql",
	"legacy/0011_domain_ownership.sql",
	"legacy/0012_browser_process.sql",
	"legacy/0013_agent_status_source.sql",
}

// legacyVersion reads the migration number out of an embedded file name. SQLx
// derives the same number from the same prefix, so this is what the exported
// ledger has to agree with.
func legacyVersion(name string) (int64, error) {
	digits, _, found := strings.Cut(strings.TrimPrefix(name, "legacy/"), "_")
	if !found {
		return 0, errors.New("unnamed legacy migration")
	}
	version, err := strconv.ParseInt(digits, 10, 64)
	if err != nil || version < 1 {
		return 0, errors.New("unnumbered legacy migration")
	}
	return version, nil
}

const maxManifest = 64 << 20
const maxDatabase = int64(16 << 30)
const maxAsset = int64(256 << 20)

type Bundle struct {
	Directory string
	Manifest  *pb.MigrationExportManifest
	Digest    [32]byte
	raw       []byte
}

// Inspect validates before the CLI creates any Host state. A bundle may contain
// explicitly reported missing assets; it remains inactive and preserves issues.
func Inspect(ctx context.Context, directory string) (*Bundle, error) {
	root, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return nil, err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	path, err := relativeFile(root, "manifest.pb")
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxManifest+1))
	file.Close()
	if err != nil {
		return nil, err
	}
	if len(raw) > maxManifest {
		return nil, errors.New("export manifest is too large")
	}
	m := new(pb.MigrationExportManifest)
	if err = (proto.UnmarshalOptions{RecursionLimit: 64}).Unmarshal(raw, m); err != nil {
		return nil, err
	}
	if m.FormatVersion != 1 || m.ExportId == "" || m.DatabaseFile != "source.sqlite" || m.OwnershipSwitchAllowed {
		return nil, errors.New("unsupported export contract")
	}
	database, err := verifyFile(root, m.DatabaseFile, m.DatabaseBytes, m.DatabaseSha256, maxDatabase)
	if err != nil {
		return nil, err
	}
	db, err := openSnapshot(database)
	if err != nil {
		return nil, err
	}
	err = validateDatabase(ctx, db, m)
	if err == nil {
		err = validateManifestData(ctx, db, m)
	}
	db.Close()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var total uint64
	for _, asset := range m.Assets {
		if !asset.Copied {
			if m.AssetsComplete {
				return nil, errors.New("incomplete assets claimed complete")
			}
			continue
		}
		if !strings.HasPrefix(asset.BundlePath, "assets/") || seen[asset.BundlePath] {
			return nil, errors.New("duplicate or invalid asset path")
		}
		seen[asset.BundlePath] = true
		total += asset.Bytes
		if total > 2<<30 {
			return nil, errors.New("export assets exceed total limit")
		}
		if _, err = verifyFile(root, asset.BundlePath, asset.Bytes, asset.Sha256, maxAsset); err != nil {
			return nil, err
		}
	}
	return &Bundle{Directory: root, Manifest: m, Digest: sha256.Sum256(raw), raw: raw}, nil
}
