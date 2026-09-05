package updates

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// signingKey is a minisign key pair produced in-process. Nothing here reads a
// key from disk: a test that needed one would either ship a private key or skip
// itself on a machine without minisign installed, and both are worse than
// generating a throwaway.
type signingKey struct {
	id      [8]byte
	public  ed25519.PublicKey
	private ed25519.PrivateKey
}

func newKey(t *testing.T) signingKey {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key := signingKey{public: public, private: private}
	if _, err := rand.Read(key.id[:]); err != nil {
		t.Fatal(err)
	}
	return key
}

// publicKeyFile renders the two-line minisign public key file.
func (k signingKey) publicKeyFile() string {
	body := append(append([]byte("Ed"), k.id[:]...), k.public...)
	return "untrusted comment: minisign public key\n" + base64.StdEncoding.EncodeToString(body) + "\n"
}

// sign renders the four-line detached signature the release pipeline writes.
func (k signingKey) sign(data []byte, trusted string) string {
	signature := ed25519.Sign(k.private, data)
	body := append(append([]byte("Ed"), k.id[:]...), signature...)
	global := ed25519.Sign(k.private, append(append([]byte{}, signature...), []byte(trusted)...))
	return strings.Join([]string{
		"untrusted comment: signature from armadra release key",
		base64.StdEncoding.EncodeToString(body),
		"trusted comment: " + trusted,
		base64.StdEncoding.EncodeToString(global),
		"",
	}, "\n")
}

var payload = []byte("armadra-host binary bytes\n")

func TestASignatureOverTheseBytesIsAccepted(t *testing.T) {
	key := newKey(t)
	trusted, err := VerifySignature(key.publicKeyFile(), key.sign(payload, "file:armadra-host_0.2.0_linux-x86_64.tar.gz"), payload)
	if err != nil {
		t.Fatal(err)
	}
	if trusted != "file:armadra-host_0.2.0_linux-x86_64.tar.gz" {
		t.Fatalf("trusted comment came back as %q", trusted)
	}
	// The key body alone is what the release pipeline stamps into a binary, so
	// it must be accepted without the comment line around it.
	body := strings.Split(strings.TrimSpace(key.publicKeyFile()), "\n")[1]
	if _, err := VerifySignature(body, key.sign(payload, "file:x"), payload); err != nil {
		t.Fatalf("refused a bare public key body: %v", err)
	}
}

func TestChangedBytesAndForeignKeysAreRefused(t *testing.T) {
	key := newKey(t)
	signature := key.sign(payload, "file:a")
	tampered := append([]byte{}, payload...)
	tampered[0] ^= 0xff
	for name, check := range map[string]func() error{
		"changed bytes": func() error {
			_, err := VerifySignature(key.publicKeyFile(), signature, tampered)
			return err
		},
		"another key": func() error {
			_, err := VerifySignature(newKey(t).publicKeyFile(), signature, payload)
			return err
		},
		"rewritten trusted comment": func() error {
			_, err := VerifySignature(key.publicKeyFile(), strings.Replace(signature, "trusted comment: file:a", "trusted comment: file:b", 1), payload)
			return err
		},
		"no signature": func() error {
			_, err := VerifySignature(key.publicKeyFile(), "", payload)
			return err
		},
		"truncated signature": func() error {
			_, err := VerifySignature(key.publicKeyFile(), "untrusted comment: x\n", payload)
			return err
		},
	} {
		if err := check(); !errors.Is(err, ErrVerify) {
			t.Fatalf("%s was accepted or misreported: %v", name, err)
		}
	}
}

// A build with no key must refuse, never install unverified. There is no
// "probably fine" between holding a key and not holding one.
func TestNoPublicKeyIsARefusalRatherThanASkip(t *testing.T) {
	key := newKey(t)
	_, err := VerifySignature("", key.sign(payload, "file:a"), payload)
	if !errors.Is(err, ErrVerify) || !strings.Contains(err.Error(), ReasonNoPublicKey) {
		t.Fatalf("an unconfigured key produced %v", err)
	}
}

// The prehashed variant is refused by name. Accepting it without checking the
// hash would be worse than admitting this build cannot verify it.
func TestPrehashedSignaturesAreRefusedByName(t *testing.T) {
	key := newKey(t)
	lines := strings.Split(key.sign(payload, "file:a"), "\n")
	body, err := base64.StdEncoding.DecodeString(lines[1])
	if err != nil {
		t.Fatal(err)
	}
	copy(body[:2], []byte("ED"))
	lines[1] = base64.StdEncoding.EncodeToString(body)
	_, err = VerifySignature(key.publicKeyFile(), strings.Join(lines, "\n"), payload)
	if !errors.Is(err, ErrVerify) || !strings.Contains(err.Error(), ReasonSignatureAlgorithm) {
		t.Fatalf("a prehashed signature produced %v", err)
	}
}

// A valid signature for another artifact is not a signature for this one. The
// trusted comment is the only thing tying the two together.
func TestASignatureIssuedForAnotherArtifactIsRefused(t *testing.T) {
	key := newKey(t)
	signature := key.sign(payload, "file:armadra-hook_0.2.0_linux-x86_64.tar.gz")
	err := VerifyArtifactSignature(key.publicKeyFile(), signature, "armadra-host_0.2.0_linux-x86_64.tar.gz", payload)
	if !errors.Is(err, ErrVerify) {
		t.Fatalf("a relabelled signature was accepted: %v", err)
	}
	if err := VerifyArtifactSignature(key.publicKeyFile(), signature, "armadra-hook_0.2.0_linux-x86_64.tar.gz", payload); err != nil {
		t.Fatal(err)
	}
	// The pipeline appends the version after the file name, so a comment that
	// starts with the expected name and continues is still this artifact's.
	withVersion := key.sign(payload, "file:armadra-host_0.2.0_linux-x86_64.tar.gz version:0.2.0")
	if err := VerifyArtifactSignature(key.publicKeyFile(), withVersion, "armadra-host_0.2.0_linux-x86_64.tar.gz", payload); err != nil {
		t.Fatal(err)
	}
}

// tarGz writes an archive from a list of entries.
func tarGz(t *testing.T, entries []*tar.Header, bodies [][]byte) string {
	t.Helper()
	var buffer bytes.Buffer
	compressed := gzip.NewWriter(&buffer)
	writer := tar.NewWriter(compressed)
	for index, header := range entries {
		if header.Typeflag == tar.TypeReg {
			header.Size = int64(len(bodies[index]))
		}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Typeflag == tar.TypeReg {
			if _, err := writer.Write(bodies[index]); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "archive.tar.gz")
	if err := os.WriteFile(path, buffer.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestUnpackExtractsExactlyTheExpectedFile(t *testing.T) {
	archive := tarGz(t,
		[]*tar.Header{
			{Name: "./armadra-host", Typeflag: tar.TypeReg, Mode: 0o755},
			{Name: "README", Typeflag: tar.TypeReg, Mode: 0o644},
		},
		[][]byte{payload, []byte("notes")},
	)
	destination := filepath.Join(t.TempDir(), "armadra-host")
	if err := Unpack(archive, "armadra-host", destination); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(destination)
	if err != nil || !bytes.Equal(content, payload) {
		t.Fatalf("unpacked %q (%v)", content, err)
	}
	// Nothing else in the archive is written: the caller named one file and
	// gets one file, at the path it chose.
	if _, err := os.Lstat(filepath.Join(filepath.Dir(destination), "README")); err == nil {
		t.Fatal("an unrequested entry was extracted")
	}
}

// An archive must not be able to decide where a file lands, or what kind of
// file it is. Every one of these would be a way to write outside the
// destination or to install something that is not a binary.
func TestUnpackRefusesUnsafeArchives(t *testing.T) {
	cases := map[string]struct {
		headers []*tar.Header
		bodies  [][]byte
	}{
		"path traversal": {
			[]*tar.Header{{Name: "../armadra-host", Typeflag: tar.TypeReg, Mode: 0o755}},
			[][]byte{payload},
		},
		"absolute path": {
			[]*tar.Header{{Name: "/armadra-host", Typeflag: tar.TypeReg, Mode: 0o755}},
			[][]byte{payload},
		},
		"nested directory": {
			[]*tar.Header{{Name: "bin/armadra-host", Typeflag: tar.TypeReg, Mode: 0o755}},
			[][]byte{payload},
		},
		"symbolic link": {
			[]*tar.Header{{Name: "armadra-host", Typeflag: tar.TypeSymlink, Linkname: "/bin/sh"}},
			[][]byte{nil},
		},
		"directory": {
			[]*tar.Header{{Name: "armadra-host", Typeflag: tar.TypeDir, Mode: 0o755}},
			[][]byte{nil},
		},
		"wrong name": {
			[]*tar.Header{{Name: "armadra-worker", Typeflag: tar.TypeReg, Mode: 0o755}},
			[][]byte{payload},
		},
		"empty file": {
			[]*tar.Header{{Name: "armadra-host", Typeflag: tar.TypeReg, Mode: 0o755}},
			[][]byte{{}},
		},
	}
	for name, archive := range cases {
		t.Run(name, func(t *testing.T) {
			destination := filepath.Join(t.TempDir(), "armadra-host")
			err := Unpack(tarGz(t, archive.headers, archive.bodies), "armadra-host", destination)
			if !errors.Is(err, ErrVerify) {
				t.Fatalf("accepted %s: %v", name, err)
			}
			if _, statErr := os.Lstat(destination); statErr == nil {
				t.Fatal("a refused archive left a file behind")
			}
		})
	}
}

func TestUnpackRefusesAnExpectedNameThatIsAPath(t *testing.T) {
	archive := tarGz(t, []*tar.Header{{Name: "armadra-host", Typeflag: tar.TypeReg, Mode: 0o755}}, [][]byte{payload})
	for _, wanted := range []string{"", "bin/armadra-host", "../armadra-host", `bin\armadra-host`} {
		if err := Unpack(archive, wanted, filepath.Join(t.TempDir(), "out")); !errors.Is(err, ErrVerify) {
			t.Fatalf("accepted the expected name %q: %v", wanted, err)
		}
	}
}

func TestUnpackReadsAZipTheSameWay(t *testing.T) {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entry, err := writer.Create("armadra-host.exe")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "archive.zip")
	if err := os.WriteFile(archive, buffer.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "armadra-host.exe")
	if err := Unpack(archive, "armadra-host.exe", destination); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(destination)
	if err != nil || !bytes.Equal(content, payload) {
		t.Fatalf("unpacked %q (%v)", content, err)
	}
	if err := Unpack(archive, "armadra-worker.exe", filepath.Join(t.TempDir(), "out")); !errors.Is(err, ErrVerify) {
		t.Fatal("a zip yielded a file nobody asked for")
	}
}
