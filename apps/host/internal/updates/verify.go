package updates

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Minisign verification and safe unpacking.
//
// The Host will replace its own executable with what comes out of here, so
// both halves refuse rather than repair. A signature this build cannot check
// is not a signature it may skip: without a public key the answer is "refused",
// never "installed unverified". An archive is unpacked one expected name at a
// time, so nothing a release published can decide where a file lands.

// ErrVerify marks every refusal in this file. None of them leave a file behind.
var ErrVerify = errors.New("update refused")

// Stable reason tokens, in the same spelling the shell uses (design §2.1).
const (
	ReasonSignatureMissing     = "signatureMissing"
	ReasonSignatureMalformed   = "signatureMalformed"
	ReasonSignatureMismatch    = "signatureMismatch"
	ReasonSignatureKeyMismatch = "signatureKeyMismatch"
	ReasonSignatureAlgorithm   = "signatureAlgorithmUnsupported"
	ReasonNoPublicKey          = "publicKeyUnconfigured"
	ReasonDigestMismatch       = "digestMismatch"
	ReasonArchiveUnsafe        = "archiveUnsafe"
)

// legacyAlgorithm is the only minisign algorithm this Host verifies: an
// Ed25519 signature over the file's own bytes. The prehashed variant hashes
// with BLAKE2b first, which the standard library does not carry; the release
// pipeline therefore writes legacy signatures, and a prehashed one is refused
// by name rather than accepted without being checked.
const legacyAlgorithm = "Ed"
const prehashedAlgorithm = "ED"

const (
	keyIDBytes     = 8
	publicKeyBytes = ed25519.PublicKeySize
	signatureBytes = ed25519.SignatureSize
)

// PublicKey is a parsed minisign public key.
type PublicKey struct {
	KeyID [keyIDBytes]byte
	Key   ed25519.PublicKey
}

// ParsePublicKey reads the two-line minisign public key file, or just its
// base64 body — the release pipeline stamps the body alone into the binary.
func ParsePublicKey(text string) (PublicKey, error) {
	var key PublicKey
	body := ""
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "untrusted comment:") {
			continue
		}
		body = trimmed
		break
	}
	if body == "" {
		return key, fmt.Errorf("%w: %s", ErrVerify, ReasonNoPublicKey)
	}
	raw, err := base64.StdEncoding.DecodeString(body)
	if err != nil || len(raw) != 2+keyIDBytes+publicKeyBytes {
		return key, fmt.Errorf("%w: %s", ErrVerify, ReasonSignatureMalformed)
	}
	if string(raw[:2]) != legacyAlgorithm {
		return key, fmt.Errorf("%w: %s", ErrVerify, ReasonSignatureAlgorithm)
	}
	copy(key.KeyID[:], raw[2:2+keyIDBytes])
	key.Key = ed25519.PublicKey(raw[2+keyIDBytes:])
	return key, nil
}

// signature is a parsed minisign signature file.
type signature struct {
	algorithm string
	keyID     [keyIDBytes]byte
	value     []byte
	trusted   string
	global    []byte
}

func parseSignature(text string) (signature, error) {
	var parsed signature
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	if len(lines) < 4 {
		return parsed, fmt.Errorf("%w: %s", ErrVerify, ReasonSignatureMalformed)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(lines[1]))
	if err != nil || len(raw) != 2+keyIDBytes+signatureBytes {
		return parsed, fmt.Errorf("%w: %s", ErrVerify, ReasonSignatureMalformed)
	}
	trusted, found := strings.CutPrefix(strings.TrimSpace(lines[2]), "trusted comment: ")
	if !found {
		return parsed, fmt.Errorf("%w: %s", ErrVerify, ReasonSignatureMalformed)
	}
	global, err := base64.StdEncoding.DecodeString(strings.TrimSpace(lines[3]))
	if err != nil || len(global) != signatureBytes {
		return parsed, fmt.Errorf("%w: %s", ErrVerify, ReasonSignatureMalformed)
	}
	parsed.algorithm = string(raw[:2])
	copy(parsed.keyID[:], raw[2:2+keyIDBytes])
	parsed.value = raw[2+keyIDBytes:]
	parsed.trusted = trusted
	parsed.global = global
	return parsed, nil
}

// VerifySignature checks a detached minisign signature over data and returns
// the trusted comment it carries. The comment is only returned once the global
// signature has covered it: handing back attacker-chosen text as if it were
// verified is exactly the mistake the second signature exists to prevent.
func VerifySignature(publicKeyText, signatureText string, data []byte) (string, error) {
	if strings.TrimSpace(publicKeyText) == "" {
		return "", fmt.Errorf("%w: %s; pass --updates-pubkey or use a build that carries one", ErrVerify, ReasonNoPublicKey)
	}
	if strings.TrimSpace(signatureText) == "" {
		return "", fmt.Errorf("%w: %s", ErrVerify, ReasonSignatureMissing)
	}
	key, err := ParsePublicKey(publicKeyText)
	if err != nil {
		return "", err
	}
	parsed, err := parseSignature(signatureText)
	if err != nil {
		return "", err
	}
	if parsed.algorithm == prehashedAlgorithm {
		return "", fmt.Errorf("%w: %s: this build verifies only unprehashed minisign signatures", ErrVerify, ReasonSignatureAlgorithm)
	}
	if parsed.algorithm != legacyAlgorithm {
		return "", fmt.Errorf("%w: %s", ErrVerify, ReasonSignatureMalformed)
	}
	if parsed.keyID != key.KeyID {
		return "", fmt.Errorf("%w: %s", ErrVerify, ReasonSignatureKeyMismatch)
	}
	if !ed25519.Verify(key.Key, data, parsed.value) {
		return "", fmt.Errorf("%w: %s", ErrVerify, ReasonSignatureMismatch)
	}
	global := append(append([]byte{}, parsed.value...), []byte(parsed.trusted)...)
	if !ed25519.Verify(key.Key, global, parsed.global) {
		return "", fmt.Errorf("%w: %s", ErrVerify, ReasonSignatureMismatch)
	}
	return parsed.trusted, nil
}

// VerifyArtifactSignature checks the signature of a downloaded file and
// asserts that the trusted comment names that same file. A valid signature for
// other bytes is not a signature for this artifact, and the comment is the only
// thing tying the two together.
func VerifyArtifactSignature(publicKeyText, signatureText, assetName string, data []byte) error {
	trusted, err := VerifySignature(publicKeyText, signatureText, data)
	if err != nil {
		return err
	}
	expected := "file:" + assetName
	if trusted != expected && !strings.HasPrefix(trusted, expected+" ") {
		return fmt.Errorf("%w: %s: the signature was issued for another artifact", ErrVerify, ReasonSignatureMismatch)
	}
	return nil
}

// maxUnpackedBytes bounds what one archive may expand to. A component binary is
// tens of megabytes; anything past this is not a release this Host published.
const maxUnpackedBytes = 512 << 20

// Unpack extracts exactly one expected file name out of an archive and writes
// it to destination. Nothing else in the archive is read: no directories, no
// symbolic links, no second entry, and no name that is not the one asked for.
// A release cannot decide where a file lands, because the caller already did.
func Unpack(archivePath, wanted, destination string) error {
	if wanted == "" || wanted != filepath.Base(wanted) || strings.ContainsAny(wanted, `/\`) {
		return fmt.Errorf("%w: %s: the expected name must be a plain file name", ErrVerify, ReasonArchiveUnsafe)
	}
	if strings.HasSuffix(archivePath, ".zip") {
		return unpackZip(archivePath, wanted, destination)
	}
	return unpackTarGz(archivePath, wanted, destination)
}

func unpackTarGz(archivePath, wanted, destination string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("%w: %s: not a gzip archive", ErrVerify, ReasonArchiveUnsafe)
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("%w: %s: archive is unreadable", ErrVerify, ReasonArchiveUnsafe)
		}
		if !safeEntry(header.Name, wanted) {
			continue
		}
		// Only a regular file is ever extracted. A symbolic link, a device or a
		// hard link would let an archive write outside the destination or point
		// the installed binary at something else entirely.
		if header.Typeflag != tar.TypeReg {
			return fmt.Errorf("%w: %s: %s is not a regular file in the archive", ErrVerify, ReasonArchiveUnsafe, wanted)
		}
		return writeExtracted(destination, io.LimitReader(reader, maxUnpackedBytes+1))
	}
	return fmt.Errorf("%w: %s: the archive does not contain %s", ErrVerify, ReasonArchiveUnsafe, wanted)
}

func unpackZip(archivePath, wanted, destination string) error {
	archive, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("%w: %s: not a zip archive", ErrVerify, ReasonArchiveUnsafe)
	}
	defer archive.Close()
	for _, entry := range archive.File {
		if !safeEntry(entry.Name, wanted) {
			continue
		}
		if !entry.Mode().IsRegular() {
			return fmt.Errorf("%w: %s: %s is not a regular file in the archive", ErrVerify, ReasonArchiveUnsafe, wanted)
		}
		opened, err := entry.Open()
		if err != nil {
			return err
		}
		defer opened.Close()
		return writeExtracted(destination, io.LimitReader(opened, maxUnpackedBytes+1))
	}
	return fmt.Errorf("%w: %s: the archive does not contain %s", ErrVerify, ReasonArchiveUnsafe, wanted)
}

// safeEntry reports whether an archive entry is the file being asked for. The
// name must be exactly that file, at the archive's top level: a "./" prefix is
// tolerated because tar writes one, and everything else — a directory
// component, a parent reference, an absolute path, a backslash — is skipped
// rather than normalised into something that looks acceptable.
func safeEntry(name, wanted string) bool {
	trimmed := strings.TrimPrefix(name, "./")
	if trimmed != wanted {
		return false
	}
	return !strings.ContainsAny(name, `\`) &&
		!strings.HasPrefix(name, "/") &&
		!strings.Contains(name, "..")
}

func writeExtracted(destination string, source io.Reader) (err error) {
	file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			os.Remove(destination)
		}
	}()
	written, err := io.Copy(file, source)
	if err != nil {
		return err
	}
	if written > maxUnpackedBytes {
		return fmt.Errorf("%w: %s: the archive expands past its budget", ErrVerify, ReasonArchiveUnsafe)
	}
	if written == 0 {
		return fmt.Errorf("%w: %s: the archive holds an empty file", ErrVerify, ReasonArchiveUnsafe)
	}
	return file.Sync()
}
