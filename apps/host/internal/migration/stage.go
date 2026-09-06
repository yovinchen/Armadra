// Staging a verified bundle into the Host store: every row lands under the
// import ID, isolated and inactive, and the pass is restartable.

package migration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"sort"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

func sqlColumn(name string, value any) (*pb.ImportedSqlColumn, error) {
	c := &pb.ImportedSqlColumn{Name: name}
	switch v := value.(type) {
	case nil:
		c.Value = &pb.ImportedSqlColumn_NullValue{NullValue: &pb.SqlNull{}}
	case string:
		c.Value = &pb.ImportedSqlColumn_TextValue{TextValue: v}
	case []byte:
		c.Value = &pb.ImportedSqlColumn_BlobValue{BlobValue: append([]byte(nil), v...)}
	case int64:
		c.Value = &pb.ImportedSqlColumn_IntegerValue{IntegerValue: v}
	case float64:
		c.Value = &pb.ImportedSqlColumn_RealValue{RealValue: v}
	default:
		return nil, fmt.Errorf("unsupported SQLite value %T", value)
	}
	return c, nil
}

// Stage is restartable by manifest digest. Partial batches remain isolated under
// this import ID; neither a completed nor partial import grants write ownership.
func Stage(ctx context.Context, store *storage.Store, bundle *Bundle) (*pb.MigrationImportReport, error) {
	importID := hex.EncodeToString(bundle.Digest[:])
	relative := "migration-imports/" + importID
	destination := filepath.Join(filepath.Dir(store.Path()), filepath.FromSlash(relative))
	reportKey := storage.Key{Kind: "migration.report", ID: importID}
	if entity, err := store.Read(ctx, reportKey); err == nil && !entity.Deleted {
		report := new(pb.MigrationImportReport)
		if err = proto.Unmarshal(entity.Payload, report); err != nil {
			return nil, err
		}
		return report, nil
	} else if err != nil && !errors.Is(err, storage.ErrNotFound) {
		return nil, err
	}
	stage, err := store.GetStaging(ctx, importID)
	if errors.Is(err, storage.ErrNotFound) {
		stage, err = store.PutStaging(ctx, storage.Staging{ID: importID, OwnerID: store.HostID(), Purpose: "migration.import", RelativePath: relative, LeaseUntilMS: math.MaxInt64, Metadata: bundle.Digest[:]}, "", 0)
	}
	if err != nil {
		return nil, err
	}
	if stage.OwnerID != store.HostID() || stage.RelativePath != relative || stage.Active || !bytes.Equal(stage.Metadata, bundle.Digest[:]) {
		return nil, storage.ErrOwnership
	}
	if _, err = ensureDirectory(filepath.Dir(store.Path()), relative); err != nil {
		return nil, err
	}
	source, err := relativeFile(bundle.Directory, "source.sqlite")
	if err != nil {
		return nil, err
	}
	if err = copyFile(ctx, source, filepath.Join(destination, "source.sqlite"), bundle.Manifest.DatabaseSha256, bundle.Manifest.DatabaseBytes); err != nil {
		return nil, err
	}
	for _, asset := range bundle.Manifest.Assets {
		if !asset.Copied {
			continue
		}
		source, err = relativeFile(bundle.Directory, asset.BundlePath)
		if err != nil {
			return nil, err
		}
		parent := strings.TrimSuffix(asset.BundlePath, "/"+filepath.Base(asset.BundlePath))
		if _, err = ensureDirectory(destination, parent); err != nil {
			return nil, err
		}
		if err = copyFile(ctx, source, filepath.Join(destination, filepath.FromSlash(asset.BundlePath)), asset.Sha256, asset.Bytes); err != nil {
			return nil, err
		}
	}
	source, err = relativeFile(bundle.Directory, "manifest.pb")
	if err != nil {
		return nil, err
	}
	if err = copyFile(ctx, source, filepath.Join(destination, "manifest.pb"), bundle.Digest[:], uint64(len(bundle.raw))); err != nil {
		return nil, err
	}
	db, err := openSnapshot(filepath.Join(destination, "source.sqlite"))
	if err != nil {
		return nil, err
	}
	defer db.Close()
	if err = validateDatabase(ctx, db, bundle.Manifest); err != nil {
		return nil, err
	}
	boardWorkspaces := map[string]string{}
	sessionWorkspaces := map[string]string{}
	for table, mapping := range map[string]map[string]string{"boards": boardWorkspaces, "terminal_sessions": sessionWorkspaces} {
		rows, e := db.QueryContext(ctx, "SELECT id,workspace_id FROM "+quote(table))
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			var id, workspace string
			if e = rows.Scan(&id, &workspace); e != nil {
				rows.Close()
				return nil, e
			}
			mapping[id] = workspace
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
	}
	report := &pb.MigrationImportReport{ImportId: importID, ExportId: bundle.Manifest.ExportId, HostId: store.HostID(), ManifestSha256: bundle.Digest[:], Tables: bundle.Manifest.Tables, Issues: bundle.Manifest.Issues, State: "staged"}
	names := make([]string, 0, len(bundle.Manifest.Tables))
	for _, table := range bundle.Manifest.Tables {
		names = append(names, table.Name)
	}
	sort.Strings(names)
	batch := []storage.Change{}
	batchBytes := 0
	batchIndex := 0
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		result, err := store.Apply(ctx, fmt.Sprintf("migration/%s/batch/%d", importID, batchIndex), batch)
		if err != nil {
			return err
		}
		report.LastEventSequence = result.LastSequence
		batchIndex++
		batch = nil
		batchBytes = 0
		return nil
	}
	for _, table := range names {
		info, err := db.QueryContext(ctx, "PRAGMA table_info("+quote(table)+")")
		if err != nil {
			return nil, err
		}
		primary := map[int]string{}
		projections := []string{}
		for info.Next() {
			var cid, notNull, pk int
			var name, typ string
			var def any
			if err = info.Scan(&cid, &name, &typ, &notNull, &def, &pk); err != nil {
				info.Close()
				return nil, err
			}
			// CASE retains the SQLite storage class but removes declared-type
			// conversion (e.g. TIMESTAMP -> time.Time) in database/sql drivers.
			projections = append(projections, "CASE WHEN 1 THEN "+quote(name)+" END AS "+quote(name))
			if pk > 0 {
				primary[pk] = name
			}
		}
		err = info.Err()
		info.Close()
		if err != nil {
			return nil, err
		}
		if len(primary) == 0 {
			return nil, fmt.Errorf("table %s has no stable primary key", table)
		}
		order := []string{}
		for i := 1; i <= len(primary); i++ {
			order = append(order, quote(primary[i]))
		}
		rows, err := db.QueryContext(ctx, "SELECT "+strings.Join(projections, ",")+" FROM "+quote(table)+" ORDER BY "+strings.Join(order, ","))
		if err != nil {
			return nil, err
		}
		columns, err := rows.Columns()
		if err != nil {
			rows.Close()
			return nil, err
		}
		for rows.Next() {
			values := make([]any, len(columns))
			dest := make([]any, len(columns))
			for i := range values {
				dest[i] = &values[i]
			}
			if err = rows.Scan(dest...); err != nil {
				rows.Close()
				return nil, err
			}
			row := &pb.ImportedSqlRow{Table: table}
			key := &pb.ImportedSqlRow{Table: table}
			workspace := ""
			for i, name := range columns {
				column, e := sqlColumn(name, values[i])
				if e != nil {
					rows.Close()
					return nil, e
				}
				row.Columns = append(row.Columns, column)
				if name == "workspace_id" {
					workspace = column.GetTextValue()
				}
				if table == "workspaces" && name == "id" {
					workspace = column.GetTextValue()
				}
				if (table == "nodes" || table == "edges") && name == "board_id" {
					workspace = boardWorkspaces[column.GetTextValue()]
				}
				if table == "terminal_logs" && name == "session_id" {
					workspace = sessionWorkspaces[column.GetTextValue()]
				}
				for _, p := range primary {
					if name == p {
						key.Columns = append(key.Columns, column)
					}
				}
			}
			encoded, e := proto.Marshal(row)
			if e != nil {
				rows.Close()
				return nil, e
			}
			keyBytes, e := proto.Marshal(key)
			if e != nil {
				rows.Close()
				return nil, e
			}
			sum := sha256.Sum256(keyBytes)
			if len(encoded) > storage.MaxPayloadBytes {
				rows.Close()
				return nil, errors.New("legacy row exceeds storage entity limit")
			}
			if len(batch) >= storage.MaxChanges || batchBytes+len(encoded) > storage.MaxBatchBytes-(1<<16) {
				if err = flush(); err != nil {
					rows.Close()
					return nil, err
				}
			}
			batch = append(batch, storage.Change{Key: storage.Key{Kind: "legacy." + table, ID: importID + "." + hex.EncodeToString(sum[:]), WorkspaceID: workspace}, Payload: encoded})
			batchBytes += len(encoded)
			report.EntityCount++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	if err = flush(); err != nil {
		return nil, err
	}
	if _, err = verifyFile(destination, "source.sqlite", bundle.Manifest.DatabaseBytes, bundle.Manifest.DatabaseSha256, maxDatabase); err != nil {
		return nil, err
	}
	if !bundle.Manifest.AssetsComplete {
		report.Issues = append(append([]*pb.ExportIssue(nil), report.Issues...), &pb.ExportIssue{Code: "assets_incomplete", Severity: "error", Entity: "import", Detail: "Managed assets require repair before ownership can change"})
	}
	payload, err := proto.Marshal(report)
	if err != nil {
		return nil, err
	}
	if _, err = store.Apply(ctx, "migration/"+importID+"/complete", []storage.Change{{Key: reportKey, Payload: payload}}); err != nil {
		return nil, err
	}
	return report, nil
}
