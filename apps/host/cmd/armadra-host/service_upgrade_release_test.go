package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"armadra.local/host/internal/buildinfo"
	"armadra.local/host/internal/hoststate"
	"armadra.local/host/internal/servicedef"
	"armadra.local/host/internal/updates"
)

// upgrade --from-release, end to end against a release served from this
// process. Nothing here reaches GitHub, registers a service or replaces a real
// installed binary: hostExecutable points at a copy the test owns, and the
// "Host" the release ships is a shell script that answers `version`.

// releaseKey is a throwaway minisign key. The release the test publishes is
// signed with it and the upgrade is told to verify with its public half, so the
// signature path is exercised rather than skipped.
type releaseKey struct {
	id      [8]byte
	public  ed25519.PublicKey
	private ed25519.PrivateKey
}

func newReleaseKey(t *testing.T) releaseKey {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key := releaseKey{public: public, private: private}
	if _, err := rand.Read(key.id[:]); err != nil {
		t.Fatal(err)
	}
	return key
}

func (k releaseKey) publicKeyFile() string {
	body := append(append([]byte("Ed"), k.id[:]...), k.public...)
	return "untrusted comment: minisign public key\n" + base64.StdEncoding.EncodeToString(body) + "\n"
}

func (k releaseKey) sign(data []byte, trusted string) string {
	signature := ed25519.Sign(k.private, data)
	body := append(append([]byte("Ed"), k.id[:]...), signature...)
	global := ed25519.Sign(k.private, append(append([]byte{}, signature...), []byte(trusted)...))
	return strings.Join([]string{
		"untrusted comment: signature",
		base64.StdEncoding.EncodeToString(body),
		"trusted comment: " + trusted,
		base64.StdEncoding.EncodeToString(global),
		"",
	}, "\n")
}

// hostArchive packs a script that identifies itself as a Host of the given
// version into the tar.gz a release publishes.
func hostArchive(t *testing.T, version string) []byte {
	t.Helper()
	script := fmt.Sprintf("#!/bin/sh\necho '{\"component\":\"armadra-host\",\"version\":\"%s\",\"channel\":\"stable\",\"protocolMajor\":1,\"protocolMinor\":2}'\n", version)
	var buffer bytes.Buffer
	compressed := gzip.NewWriter(&buffer)
	writer := tar.NewWriter(compressed)
	header := &tar.Header{Name: "armadra-host", Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len(script))}
	if err := writer.WriteHeader(header); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte(script)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

type publishedRelease struct {
	source string
	key    releaseKey
	// corrupt flips a byte in the served archive so the digest check has
	// something to catch; unsigned drops the detached signature.
	corrupt  bool
	unsigned bool
}

// publish serves a one-release index and its assets from loopback. The Host
// accepts a plain-HTTP release source on loopback, which is what makes this
// possible without inventing a certificate.
func publish(t *testing.T, version string) *publishedRelease {
	t.Helper()
	r := &publishedRelease{key: newReleaseKey(t)}
	archive := hostArchive(t, version)
	asset := fmt.Sprintf("armadra-host_%s_%s.tar.gz", version, updates.LocalTarget())
	signature := r.key.sign(archive, "file:"+asset+" version:"+version)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case strings.HasSuffix(request.URL.Path, "/releases"):
			sum := sha256.Sum256(archive)
			assets := []map[string]any{{
				"name":                 asset,
				"browser_download_url": "http://" + request.Host + "/download/" + asset,
				"size":                 len(archive),
				"digest":               "sha256:" + hex.EncodeToString(sum[:]),
			}}
			if !r.unsigned {
				assets = append(assets, map[string]any{
					"name":                 asset + ".sig",
					"browser_download_url": "http://" + request.Host + "/download/" + asset + ".sig",
					"size":                 len(signature),
				})
			}
			body, _ := json.Marshal([]map[string]any{{
				"tag_name":     "v" + version,
				"draft":        false,
				"prerelease":   false,
				"published_at": "2026-09-01T10:00:00Z",
				"html_url":     "https://releases.invalid/v" + version,
				"body": "Notes.\n\n```" + updates.CompatibilityFence +
					"\n{\"minimumInstalled\":\"0.1.0\",\"protocolMajor\":1,\"minimumProtocolMinor\":1}\n```\n",
				"assets": assets,
			}})
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(body)
		case strings.HasSuffix(request.URL.Path, ".sig"):
			_, _ = w.Write([]byte(signature))
		default:
			payload := archive
			if r.corrupt {
				payload = append([]byte{}, archive...)
				payload[0] ^= 0xff
			}
			_, _ = w.Write(payload)
		}
	}))
	t.Cleanup(server.Close)
	r.source = server.URL + "/repos/armadra/armadra"
	return r
}

// releaseUpgradeConfig points the command at a Host binary the test owns and
// at a public key file holding the release's key.
func releaseUpgradeConfig(t *testing.T, r *publishedRelease, confirm bool, extra ...string) config {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the released Host is a shell script; the release path is covered on Unix")
	}
	installedCopy(t)
	keyFile := filepath.Join(t.TempDir(), "armadra-release.pub")
	if err := os.WriteFile(keyFile, []byte(r.key.publicKeyFile()), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{
		"upgrade", "--from-release", "--data-dir", hostDataDir(t),
		"--updates-source", r.source, "--updates-pubkey", keyFile,
	}
	if confirm {
		args = append(args, "--confirm")
	}
	c, err := parseConfig(append(args, extra...))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// withInstalledVersion makes this build claim to be a release, so the update
// check has something to compare against. A development build never updates.
func withInstalledVersion(t *testing.T, version string) {
	t.Helper()
	originalVersion, originalChannel := buildinfo.Version, buildinfo.Channel
	buildinfo.Version, buildinfo.Channel = version, buildinfo.ChannelStable
	t.Cleanup(func() { buildinfo.Version, buildinfo.Channel = originalVersion, originalChannel })
}

func TestFromReleaseWithoutConfirmChangesNothing(t *testing.T) {
	withInstalledVersion(t, "0.1.0")
	r := publish(t, "0.2.0")
	c := releaseUpgradeConfig(t, r, false)
	output, err := captureStdout(t, func() error { return upgradeHost(context.Background(), c) })
	if err != nil {
		t.Fatal(err)
	}
	var result upgradeResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("upgrade printed %q: %v", output, err)
	}
	if result.Applied || result.Mode != "from-release" || result.Candidate != "0.2.0" {
		t.Fatalf("a dry run reported %+v", result)
	}
	target, _ := hostExecutable()
	if content, err := os.ReadFile(target); err != nil || string(content) != "installed binary" {
		t.Fatalf("the installed binary was touched: %q (%v)", content, err)
	}
}

func TestFromReleaseInstallsAVerifiedRelease(t *testing.T) {
	withInstalledVersion(t, "0.1.0")
	r := publish(t, "0.2.0")
	c := releaseUpgradeConfig(t, r, true)
	output, err := captureStdout(t, func() error { return upgradeHost(context.Background(), c) })
	if err != nil {
		t.Fatal(err)
	}
	var result upgradeResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("upgrade printed %q: %v", output, err)
	}
	if !result.Applied || result.RolledBack {
		t.Fatalf("upgrade reported %+v", result)
	}
	target, _ := hostExecutable()
	content, err := os.ReadFile(target)
	if err != nil || !strings.Contains(string(content), `"version":"0.2.0"`) {
		t.Fatalf("the installed binary is %q (%v)", content, err)
	}
	// The displaced binary stays until the next successful upgrade, so a
	// rollback has something to go back to.
	previous, err := os.ReadFile(target + servicedef.PreviousSuffix)
	if err != nil || string(previous) != "installed binary" {
		t.Fatalf("the previous binary is %q (%v)", previous, err)
	}
	// The downloaded archive and everything unpacked from it are gone: a
	// verified binary that stayed on disk is one a later step might install
	// without going through any of these checks again.
	if _, err := os.Lstat(filepath.Join(c.dataDir, "updates", "0.2.0")); err == nil {
		t.Fatal("the staging directory survived a successful upgrade")
	}
}

// Every one of these leaves the installed binary exactly as it was. A release
// that cannot be verified is refused, never installed with a warning.
func TestFromReleaseRefusalsLeaveTheBinaryInPlace(t *testing.T) {
	cases := map[string]func(t *testing.T) config{
		"digest mismatch": func(t *testing.T) config {
			r := publish(t, "0.2.0")
			r.corrupt = true
			return releaseUpgradeConfig(t, r, true)
		},
		"no signature published": func(t *testing.T) config {
			r := publish(t, "0.2.0")
			r.unsigned = true
			return releaseUpgradeConfig(t, r, true)
		},
		"signed with another key": func(t *testing.T) config {
			r := publish(t, "0.2.0")
			c := releaseUpgradeConfig(t, r, true)
			other := newReleaseKey(t)
			keyFile := filepath.Join(t.TempDir(), "other.pub")
			if err := os.WriteFile(keyFile, []byte(other.publicKeyFile()), 0o600); err != nil {
				t.Fatal(err)
			}
			c.service.publicKey = keyFile
			return c
		},
		"a version the release does not offer": func(t *testing.T) config {
			r := publish(t, "0.2.0")
			return releaseUpgradeConfig(t, r, true, "--version", "0.3.0")
		},
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			withInstalledVersion(t, "0.1.0")
			c := build(t)
			target, _ := hostExecutable()
			if _, err := captureStdout(t, func() error { return upgradeHost(context.Background(), c) }); err == nil {
				t.Fatalf("accepted %s", name)
			}
			if content, err := os.ReadFile(target); err != nil || string(content) != "installed binary" {
				t.Fatalf("the installed binary changed: %q (%v)", content, err)
			}
			if _, err := os.Lstat(target + servicedef.PreviousSuffix); err == nil {
				t.Fatalf("%s moved the installed binary aside", name)
			}
		})
	}
}

// This build holds no key by default, and an unverifiable download is never
// installed. There is no "probably fine" between holding a key and not.
func TestFromReleaseRefusesWithNoPublicKeyAtAll(t *testing.T) {
	withInstalledVersion(t, "0.1.0")
	r := publish(t, "0.2.0")
	c := releaseUpgradeConfig(t, r, true)
	c.service.publicKey = ""
	if _, err := captureStdout(t, func() error { return upgradeHost(context.Background(), c) }); err == nil {
		t.Fatal("installed a release with no key to verify it")
	}
}

func TestFromReleaseNeedsASource(t *testing.T) {
	withInstalledVersion(t, "0.1.0")
	installedCopy(t)
	c, err := parseConfig([]string{"upgrade", "--from-release", "--data-dir", hostDataDir(t), "--confirm"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = captureStdout(t, func() error { return upgradeHost(context.Background(), c) })
	if err == nil || !strings.Contains(err.Error(), updates.ReasonNotConfigured) {
		t.Fatalf("an unconfigured source produced %v", err)
	}
}

// A release no newer than what is installed is reported, not installed.
func TestFromReleaseRefusesWhatIsNotNewer(t *testing.T) {
	withInstalledVersion(t, "0.2.0")
	r := publish(t, "0.2.0")
	c := releaseUpgradeConfig(t, r, true)
	if _, err := captureStdout(t, func() error { return upgradeHost(context.Background(), c) }); err == nil {
		t.Fatal("installed a release that is not newer")
	}
}

// Rolling back is the only way down, and only when the previous binaries are
// still there.
func TestRollbackRestoresTheDisplacedBinary(t *testing.T) {
	withInstalledVersion(t, "0.1.0")
	r := publish(t, "0.2.0")
	c := releaseUpgradeConfig(t, r, true)
	if _, err := captureStdout(t, func() error { return upgradeHost(context.Background(), c) }); err != nil {
		t.Fatal(err)
	}
	back, err := parseConfig([]string{"upgrade", "--rollback", "--data-dir", c.dataDir, "--confirm"})
	if err != nil {
		t.Fatal(err)
	}
	output, err := captureStdout(t, func() error { return upgradeHost(context.Background(), back) })
	if err != nil {
		t.Fatal(err)
	}
	var result upgradeResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("rollback printed %q: %v", output, err)
	}
	if !result.RolledBack {
		t.Fatalf("rollback reported %+v", result)
	}
	target, _ := hostExecutable()
	if content, err := os.ReadFile(target); err != nil || string(content) != "installed binary" {
		t.Fatalf("the binary came back as %q (%v)", content, err)
	}
	// The binary that was rolled back stays for inspection.
	if _, err := os.Lstat(target + ".failed"); err != nil {
		t.Fatalf("the replaced binary was deleted rather than kept: %v", err)
	}
}

func TestRollbackWithNothingToGoBackToIsRefused(t *testing.T) {
	installedCopy(t)
	c, err := parseConfig([]string{"upgrade", "--rollback", "--data-dir", hostDataDir(t), "--confirm"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := captureStdout(t, func() error { return upgradeHost(context.Background(), c) }); err == nil {
		t.Fatal("rolled back with no previous binary")
	}
}

// The desktop app ships its own Host and replaces it when the app updates.
// Replacing that binary here would be undone by the next app update.
func TestUpgradeRefusesAHostTheDesktopAppOwns(t *testing.T) {
	installedCopy(t)
	dataDir := hostDataDir(t)
	record := hoststate.LauncherRecord{Launcher: hoststate.LauncherDesktop, InstanceID: "instance-1"}
	if err := hoststate.WriteLauncher(dataDir, record); err != nil {
		t.Fatal(err)
	}
	c, err := parseConfig([]string{"upgrade", "--rollback", "--data-dir", dataDir, "--confirm"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = captureStdout(t, func() error { return upgradeHost(context.Background(), c) })
	if err == nil || !strings.Contains(err.Error(), "owned by the desktop app") {
		t.Fatalf("a desktop-owned Host produced %v", err)
	}
}

func TestABinaryInsideAnApplicationBundleIsRefused(t *testing.T) {
	for _, path := range []string{
		"/Applications/Armadra.app/Contents/MacOS/armadra-host",
		"/Users/someone/Applications/Armadra.app/Contents/Resources/armadra-host",
		"/Applications/armadra-host",
	} {
		if !insideDesktopInstall(path) {
			t.Fatalf("%s was not recognised as a desktop installation", path)
		}
	}
	for _, path := range []string{"/usr/local/bin/armadra-host", "/opt/armadra/armadra-host"} {
		if insideDesktopInstall(path) {
			t.Fatalf("%s was mistaken for a desktop installation", path)
		}
	}
}

// The three modes name different sources for the binaries that replace this
// process, so a command that silently picked between them would be choosing
// which release gets installed.
func TestUpgradeModesAreMutuallyExclusive(t *testing.T) {
	// The flag wants an absolute path, which /tmp is not on Windows.
	binary := filepath.Join(t.TempDir(), "armadra-host")
	for _, args := range [][]string{
		{"upgrade"},
		{"upgrade", "--binary", binary, "--from-release"},
		{"upgrade", "--from-release", "--rollback"},
		{"upgrade", "--binary", binary, "--rollback"},
		{"upgrade", "--rollback", "--channel", "beta"},
		{"upgrade", "--binary", binary, "--version", "0.2.0"},
		{"upgrade", "--from-release", "--channel", "development"},
		{"upgrade", "--binary", "relative/path"},
		{"upgrade", "--from-release", "--updates-pubkey", "relative.pub"},
	} {
		if _, err := parseConfig(append(args, "--data-dir", t.TempDir())); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	for _, args := range [][]string{
		{"upgrade", "--binary", binary},
		{"upgrade", "--from-release"},
		{"upgrade", "--from-release", "--channel", "beta", "--version", "0.2.0"},
		{"upgrade", "--rollback"},
	} {
		if _, err := parseConfig(append(args, "--data-dir", t.TempDir())); err != nil {
			t.Fatalf("refused %v: %v", args, err)
		}
	}
}
