package storage

import (
	"errors"
	"net/url"
	"runtime"
	"strings"
	"testing"
)

func TestSQLitePathsRemainAbsoluteAcrossPlatforms(t *testing.T) {
	slash := string(rune(92))
	extended := strings.Repeat(slash, 2) + "?" + slash
	drive := strings.Join([]string{"C:", "repo space", "host.db"}, slash)
	unc := strings.Repeat(slash, 2) + strings.Join([]string{"server", "share", "repo", "host.db"}, slash)
	for _, tc := range []struct{ input, want string }{
		{drive, "/C:/repo space/host.db"},
		{extended + drive, "/C:/repo space/host.db"},
		{unc, "//server/share/repo/host.db"},
		{extended + "UNC" + slash + unc[2:], "//server/share/repo/host.db"},
		{extended + "unc" + slash + unc[2:], "//server/share/repo/host.db"},
	} {
		result, err := sqliteURIPath(tc.input, "windows")
		if err != nil || result != tc.want {
			t.Fatalf("path %q -> %q, %v; want %q", tc.input, result, err, tc.want)
		}
		serialized := (&url.URL{Scheme: "file", Path: result}).String()
		decoded, err := url.Parse(serialized)
		if err != nil || decoded.Host != "" || decoded.Path != tc.want {
			t.Fatalf("URI changed absolute path: %s", serialized)
		}
	}
	posix := "/tmp/host # 中文 ?/host.db"
	if result, err := sqliteURIPath(posix, "darwin"); err != nil || result != posix {
		t.Fatal("POSIX path changed")
	}
}

func TestSQLitePathsRejectDeviceAndRelativeNamespaces(t *testing.T) {
	slash := string(rune(92))
	extended := strings.Repeat(slash, 2) + "?" + slash
	for _, path := range []string{
		strings.Repeat(slash, 2) + "." + slash + "pipe" + slash + "host.db",
		extended + "Volume{2f6f43d0-1234-4567-890a-123456789abc}" + slash + "host.db",
		extended + strings.Join([]string{"GLOBALROOT", "Device", "HarddiskVolume1", "host.db"}, slash),
		"UNC/server/share/host.db", "C:host.db", "host.db", "//server/", "//?/UNC/server/", "//?/Device/host.db",
	} {
		if _, err := sqliteURIPath(path, "windows"); !errors.Is(err, ErrInvalid) {
			t.Fatalf("accepted unsafe namespace %q: %v", path, err)
		}
	}
	if _, err := sqliteURIPath("host.db", "linux"); !errors.Is(err, ErrInvalid) {
		t.Fatal("accepted relative POSIX database path")
	}
}

func TestReadOnlyURIConstructionDoesNotOpenOrCreateAFile(t *testing.T) {
	path := "/not-created/host # 中文 ?/source.sqlite"
	if runtime.GOOS == "windows" {
		path = "C:/not-created/host # 中文 ?/source.sqlite"
	}
	encoded, err := SQLiteReadOnlyURI(path)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Query().Get("mode") != "ro" {
		t.Fatal("not read only")
	}
	pragmas := parsed.Query()["_pragma"]
	found := false
	for _, pragma := range pragmas {
		if pragma == "query_only(1)" {
			found = true
		}
	}
	if !found {
		t.Fatal("connection query-only guard missing")
	}
	if _, err := SQLiteReadOnlyURI(path + string(rune(0)) + "suffix"); !errors.Is(err, ErrInvalid) {
		t.Fatal("accepted NUL-truncated file path")
	}
}
