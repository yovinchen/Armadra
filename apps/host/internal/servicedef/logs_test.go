package servicedef

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeLines(t *testing.T, path string, count int) {
	t.Helper()
	var builder strings.Builder
	for index := range count {
		fmt.Fprintf(&builder, "line %d\n", index)
	}
	if err := os.WriteFile(path, []byte(builder.String()), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestTailReturnsTheEndOfTheFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.log")
	writeLines(t, path, 5000)
	lines, err := Tail(path, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 3 {
		t.Fatalf("read %d lines, want 3", len(lines))
	}
	if lines[0] != "line 4997" || lines[2] != "line 4999" {
		t.Fatalf("tail is %v", lines)
	}
}

func TestTailHandlesSmallAndEmptyFiles(t *testing.T) {
	directory := t.TempDir()
	short := filepath.Join(directory, "short.log")
	writeLines(t, short, 2)
	lines, err := Tail(short, DefaultLogLines)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || lines[0] != "line 0" {
		t.Fatalf("short tail is %v", lines)
	}
	empty := filepath.Join(directory, "empty.log")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if lines, err := Tail(empty, 10); err != nil || len(lines) != 0 {
		t.Fatalf("empty tail is %v (%v)", lines, err)
	}
	unterminated := filepath.Join(directory, "partial.log")
	if err := os.WriteFile(unterminated, []byte("first\nsecond"), 0o600); err != nil {
		t.Fatal(err)
	}
	lines, err = Tail(unterminated, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || lines[1] != "second" {
		t.Fatalf("unterminated tail is %v", lines)
	}
}

func TestTailCapsTheRequestedCount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.log")
	writeLines(t, path, MaxLogLines+500)
	lines, err := Tail(path, MaxLogLines+400)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != MaxLogLines {
		t.Fatalf("read %d lines, want the %d line cap", len(lines), MaxLogLines)
	}
	// A zero or negative request falls back to the default rather than reading
	// the whole file.
	if lines, err := Tail(path, 0); err != nil || len(lines) != DefaultLogLines {
		t.Fatalf("default tail read %d lines (%v)", len(lines), err)
	}
}

func TestLatestStartupLogPicksTheNewest(t *testing.T) {
	directory := t.TempDir()
	if _, err := LatestStartupLog(directory); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("empty directory reported a log: %v", err)
	}
	older := filepath.Join(directory, "startup-1.log")
	newer := filepath.Join(directory, "startup-2.log")
	writeLines(t, older, 1)
	writeLines(t, newer, 1)
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(older, past, past); err != nil {
		t.Fatal(err)
	}
	found, err := LatestStartupLog(directory)
	if err != nil {
		t.Fatal(err)
	}
	if found != newer {
		t.Fatalf("chose %s, want %s", found, newer)
	}
}
