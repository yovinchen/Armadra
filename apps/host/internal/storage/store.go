package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db       *sql.DB
	file     *os.File
	hostID   string
	path     string
	once     sync.Once
	closeErr error
}

var hostPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// sqliteURIPath is separate from the local OS so canonical Windows path cases
// can be tested without a Windows runner. It never returns a relative path.
func sqliteURIPath(path, platform string) (string, error) {
	if strings.IndexByte(path, 0) >= 0 {
		return "", ErrInvalid
	}
	if platform != "windows" {
		if !strings.HasPrefix(path, "/") {
			return "", ErrInvalid
		}
		return path, nil
	}
	value := strings.ReplaceAll(path, string(rune(92)), "/")
	if strings.HasPrefix(value, "//./") {
		return "", ErrInvalid
	}
	drive := func(value string) bool {
		return len(value) >= 3 && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) && value[1] == ':' && value[2] == '/'
	}
	if strings.HasPrefix(value, "//?/") {
		rest := value[4:]
		if strings.HasPrefix(strings.ToUpper(rest), "UNC/") {
			value = "//" + rest[4:]
		} else if drive(rest) {
			value = rest
		} else {
			return "", ErrInvalid
		}
	}
	if drive(value) {
		return "/" + value, nil
	}
	if strings.HasPrefix(value, "//") {
		parts := strings.Split(value[2:], "/")
		if len(parts) < 2 || parts[0] == "" || parts[1] == "" || parts[0] == "." || parts[0] == "?" || parts[1] == "." || parts[1] == ".." {
			return "", ErrInvalid
		}
		return value, nil
	}
	return "", ErrInvalid
}

func dataSource(path, mode string) (string, error) {
	slash, err := sqliteURIPath(path, runtime.GOOS)
	if err != nil {
		return "", err
	}
	value := url.URL{Scheme: "file", Path: slash}
	query := url.Values{"mode": {mode}, "_pragma": {"busy_timeout(5000)", "foreign_keys(1)", "trusted_schema(0)"}}
	if mode != "ro" {
		query.Set("_txlock", "immediate")
		query.Add("_pragma", "synchronous(FULL)")
	} else {
		query.Add("_pragma", "query_only(1)")
	}
	value.RawQuery = query.Encode()
	return value.String(), nil
}

// SQLiteReadOnlyURI constructs a read-only URI without opening or creating a
// database. WAL is honored; callers opening verified, immutable offline snapshots
// may additionally set immutable=1 so unmanifested sidecars cannot affect reads.
func SQLiteReadOnlyURI(path string) (string, error) { return dataSource(path, "ro") }

func openSQL(path, mode string) (*sql.DB, error) {
	source, err := dataSource(path, mode)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", source)
	if err != nil {
		return nil, err
	}
	// One connection serializes local writers. Separate Store handles still use
	// BEGIN IMMEDIATE and conditional updates to enforce cross-connection CAS.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db, nil
}

// Open never opens canvas.db. It rejects an incompatible existing database
// before any SQL writes or journal-mode changes, then checks again in the write
// transaction. Files are never renamed aside or recreated on migration failure.
func Open(dataDir, hostID string) (*Store, error) {
	if !hostPattern.MatchString(hostID) {
		return nil, fmt.Errorf("%w: host ID must be 32 lowercase hexadecimal characters", ErrInvalid)
	}
	path, file, err := databaseFile(dataDir)
	if err != nil {
		return nil, err
	}
	keep := false
	defer func() {
		if !keep {
			file.Close()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err = verifyCompanions(path); err != nil {
		return nil, err
	}
	reader, err := openSQL(path, "ro")
	if err != nil {
		return nil, err
	}
	_, validation := validateSchema(ctx, reader, hostID)
	closeErr := reader.Close()
	if validation != nil {
		return nil, validation
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if err = verifyFileIdentity(file, path); err != nil {
		return nil, err
	}
	if err = verifyCompanions(path); err != nil {
		return nil, err
	}
	db, err := openSQL(path, "rw")
	if err != nil {
		return nil, err
	}
	complete := false
	defer func() {
		if !complete {
			db.Close()
		}
	}()
	if err = migrate(ctx, db, hostID); err != nil {
		return nil, err
	}
	if err = verifyFileIdentity(file, path); err != nil {
		return nil, err
	}
	var journal string
	if err = db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&journal); err != nil {
		return nil, err
	}
	if strings.ToLower(journal) != "wal" {
		return nil, errors.New("host storage requires SQLite WAL mode")
	}
	if _, err = db.ExecContext(ctx, "PRAGMA synchronous=FULL"); err != nil {
		return nil, err
	}
	var integrity string
	if err = db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&integrity); err != nil {
		return nil, errors.Join(ErrCorrupt, err)
	}
	if integrity != "ok" {
		return nil, ErrCorrupt
	}
	complete = true
	keep = true
	return &Store{db: db, file: file, hostID: hostID, path: path}, nil
}

func (s *Store) Close() error {
	if s == nil {
		return nil
	}
	s.once.Do(func() { s.closeErr = errors.Join(s.db.Close(), s.file.Close()) })
	return s.closeErr
}
func (s *Store) HostID() string { return s.hostID }
func (s *Store) Path() string   { return s.path }
