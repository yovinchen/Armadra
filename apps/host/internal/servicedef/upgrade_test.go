package servicedef

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// script writes a tiny executable that prints what a Host binary would print
// for `version`. No real binary is ever replaced by these tests.
func script(t *testing.T, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("candidate probing uses a shell script; covered on Unix")
	}
	path := filepath.Join(t.TempDir(), "candidate")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestVerifyCandidateRefusesUnsafeFiles(t *testing.T) {
	directory := t.TempDir()
	if _, err := VerifyCandidate("armadra-host"); !errors.Is(err, ErrUpgradeRefused) {
		t.Fatal("accepted a relative candidate")
	}
	if runtime.GOOS == "windows" {
		return
	}
	plain := filepath.Join(directory, "plain")
	if err := os.WriteFile(plain, []byte("binary"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyCandidate(plain); !errors.Is(err, ErrUpgradeRefused) {
		t.Fatal("accepted a non-executable candidate")
	}
	loose := filepath.Join(directory, "loose")
	if err := os.WriteFile(loose, []byte("binary"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(loose, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyCandidate(loose); !errors.Is(err, ErrUpgradeRefused) {
		t.Fatal("accepted a world-writable candidate")
	}
	empty := filepath.Join(directory, "empty")
	if err := os.WriteFile(empty, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyCandidate(empty); !errors.Is(err, ErrUpgradeRefused) {
		t.Fatal("accepted an empty candidate")
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink(loose, link); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyCandidate(link); !errors.Is(err, ErrUpgradeRefused) {
		t.Fatal("accepted a symbolic link")
	}
	good := filepath.Join(directory, "good")
	if err := os.WriteFile(good, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyCandidate(good); err != nil {
		t.Fatalf("refused a well-formed candidate: %v", err)
	}
}

func TestProbeReadsTheCandidateIdentity(t *testing.T) {
	path := script(t, `echo '{"component":"armadra-host","protocolMajor":1,"protocolMinor":1}'`)
	version, err := Probe(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if version.ProtocolMajor != 1 || version.ProtocolMinor != 1 {
		t.Fatalf("probed %+v", version)
	}
	if err := CheckCompatible(version, 1); err != nil {
		t.Fatal(err)
	}
	if err := CheckCompatible(version, 2); !errors.Is(err, ErrUpgradeRefused) {
		t.Fatal("accepted a different protocol major")
	}
}

func TestProbeRefusesForeignAndSilentBinaries(t *testing.T) {
	foreign := script(t, `echo '{"component":"something-else","protocolMajor":1}'`)
	if _, err := Probe(context.Background(), foreign); !errors.Is(err, ErrUpgradeRefused) {
		t.Fatal("accepted a binary that is not a Host")
	}
	silent := script(t, `exit 3`)
	if _, err := Probe(context.Background(), silent); !errors.Is(err, ErrUpgradeRefused) {
		t.Fatal("accepted a candidate that failed to report")
	}
	noise := script(t, `echo not-json`)
	if _, err := Probe(context.Background(), noise); !errors.Is(err, ErrUpgradeRefused) {
		t.Fatal("accepted an unparsable report")
	}
}

func TestReplaceIsAtomicAndKeepsTheMode(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "armadra-host")
	if err := os.WriteFile(target, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	candidate := filepath.Join(directory, "candidate")
	if err := os.WriteFile(candidate, []byte("new binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Replace(candidate, target); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "new binary" {
		t.Fatalf("target holds %q", content)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Lstat(target)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o100 == 0 {
			t.Fatalf("replaced binary is %v", info.Mode().Perm())
		}
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("replacement left %d files behind", len(entries))
	}
	// A missing target is refused before anything is staged.
	if err := Replace(candidate, filepath.Join(directory, "absent")); err == nil {
		t.Fatal("replaced a binary that does not exist")
	}
}
