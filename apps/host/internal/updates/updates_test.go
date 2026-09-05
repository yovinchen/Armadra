package updates

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
)

// Every test serves its own release index from an httptest server. Nothing
// here reaches a real release host: a unit test that needs the network is a
// test that silently stops testing when the network is down.

const testTarget = "darwin-aarch64"

func compatibilityNote(minimum, maximum string, major, minor uint32) string {
	body := "Release notes.\n\n```" + CompatibilityFence + "\n{\"minimumInstalled\":\"" + minimum + "\""
	if maximum != "" {
		body += ",\"maximumInstalled\":\"" + maximum + "\""
	}
	body += ",\"protocolMajor\":" + itoa(major) + ",\"minimumProtocolMinor\":" + itoa(minor) + "}\n```\n"
	return body
}

func itoa(value uint32) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}

// releaseJSON writes one GitHub-shaped release. Assets are given as names; a
// name ending in ".sig" is the detached signature of the asset before it.
func releaseJSON(tag string, prerelease bool, note string, assets ...string) string {
	entries := make([]string, 0, len(assets))
	for _, name := range assets {
		entries = append(entries, `{"name":"`+name+`","browser_download_url":"https://releases.invalid/`+name+
			`","size":1024,"digest":"sha256:`+strings.Repeat("ab", 32)+`"}`)
	}
	return `{"tag_name":"` + tag + `","draft":false,"prerelease":` + boolText(prerelease) +
		`,"published_at":"2026-09-01T10:00:00Z","html_url":"https://releases.invalid/` + tag +
		`","body":` + quote(note) + `,"assets":[` + strings.Join(entries, ",") + `]}`
}

func boolText(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

func quote(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return `"` + replacer.Replace(value) + `"`
}

func index(releases ...string) string { return "[" + strings.Join(releases, ",") + "]" }

type fixture struct {
	service *Service
	body    string
	status  int
	hits    int
}

func newFixture(t *testing.T, body string, options Options) *fixture {
	t.Helper()
	f := &fixture{body: body, status: http.StatusOK}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits++
		if !strings.HasSuffix(r.URL.Path, "/releases") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(f.status)
		_, _ = w.Write([]byte(f.body))
	}))
	t.Cleanup(server.Close)
	options.Source = server.URL + "/repos/armadra/armadra"
	if options.ProtocolMajor == 0 {
		options.ProtocolMajor = 1
	}
	if options.Clock == nil {
		options.Clock = func() time.Time { return time.UnixMilli(1_770_000_000_000) }
	}
	service, err := New(options)
	if err != nil {
		t.Fatalf("update service refused a valid configuration: %v", err)
	}
	f.service = service
	return f
}

func check(t *testing.T, service *Service, installed string, channel pb.ReleaseChannel, target string) *pb.CheckForUpdateResponse {
	t.Helper()
	version, err := ParseVersion(installed)
	if err != nil {
		t.Fatalf("test used an unparseable installed version %q", installed)
	}
	response, err := service.Check(context.Background(), &pb.CheckForUpdateRequest{
		Channel:          channel,
		InstalledVersion: version,
		Target:           target,
	})
	if err != nil {
		t.Fatalf("check returned an error instead of a state: %v", err)
	}
	return response
}

func expect(t *testing.T, response *pb.CheckForUpdateResponse, state pb.UpdateCheckState, reason string) {
	t.Helper()
	if response.GetState() != state || response.GetReasonCode() != reason {
		t.Fatalf("expected %v/%q, got %v/%q", state, reason, response.GetState(), response.GetReasonCode())
	}
	if state != pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE && response.GetRelease() != nil {
		t.Fatal("a release was offered by a state that is not AVAILABLE")
	}
	// A reason code is a token, never an address or a body fragment.
	if strings.Contains(response.GetReasonCode(), "://") || strings.Contains(response.GetReasonCode(), " ") {
		t.Fatalf("reason code leaked source detail: %q", response.GetReasonCode())
	}
}

// The table below walks every state the contract defines, each from its own
// server, so a change to one decision cannot quietly re-route another.
func TestCheckReportsEveryContractState(t *testing.T) {
	note := compatibilityNote("0.1.0", "", 1, 0)
	for _, test := range []struct {
		name      string
		body      string
		status    int
		installed string
		channel   pb.ReleaseChannel
		target    string
		options   Options
		state     pb.UpdateCheckState
		reason    string
	}{
		{
			name:      "a newer signed release for this target is offered",
			body:      index(releaseJSON("v0.2.0", false, note, "Armadra_0.2.0_darwin-aarch64.tar.gz", "Armadra_0.2.0_darwin-aarch64.tar.gz.sig")),
			installed: "0.1.0",
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE,
		},
		{
			name:      "the newest release is the installed one",
			body:      index(releaseJSON("v0.1.0", false, note, "Armadra_0.1.0_darwin-aarch64.tar.gz")),
			installed: "0.1.0",
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UP_TO_DATE,
		},
		{
			name:      "an older published release never moves a build backwards",
			body:      index(releaseJSON("v0.0.9", false, note, "Armadra_0.0.9_darwin-aarch64.tar.gz")),
			installed: "0.1.0",
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UP_TO_DATE,
		},
		{
			name:      "an empty index is not an update",
			body:      index(),
			installed: "0.1.0",
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UP_TO_DATE,
		},
		{
			name:      "a pre-release is invisible on the stable channel",
			body:      index(releaseJSON("v0.3.0-beta.1", true, note, "Armadra_0.3.0_darwin-aarch64.tar.gz", "Armadra_0.3.0_darwin-aarch64.tar.gz.sig")),
			installed: "0.1.0",
			channel:   pb.ReleaseChannel_RELEASE_CHANNEL_STABLE,
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UP_TO_DATE,
		},
		{
			name:      "the same pre-release is offered on the beta channel",
			body:      index(releaseJSON("v0.3.0-beta.1", true, note, "Armadra_0.3.0_darwin-aarch64.tar.gz", "Armadra_0.3.0_darwin-aarch64.tar.gz.sig")),
			installed: "0.1.0",
			channel:   pb.ReleaseChannel_RELEASE_CHANNEL_BETA,
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE,
		},
		{
			name:      "a release that refuses this installed version is reported, not offered",
			body:      index(releaseJSON("v0.2.0", false, compatibilityNote("0.5.0", "", 1, 0), "Armadra_0.2.0_darwin-aarch64.tar.gz")),
			installed: "0.1.0",
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE,
			reason:    ReasonIncompatible,
		},
		{
			name:      "a release with a ceiling below this build is refused",
			body:      index(releaseJSON("v0.2.0", false, compatibilityNote("0.0.1", "0.0.9", 1, 0), "Armadra_0.2.0_darwin-aarch64.tar.gz")),
			installed: "0.1.0",
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE,
			reason:    ReasonIncompatible,
		},
		{
			name:      "another protocol major is refused, not negotiated",
			body:      index(releaseJSON("v0.2.0", false, compatibilityNote("0.1.0", "", 2, 0), "Armadra_0.2.0_darwin-aarch64.tar.gz")),
			installed: "0.1.0",
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE,
			reason:    ReasonIncompatible,
		},
		{
			name:      "a protocol minor this Host cannot reach is refused",
			body:      index(releaseJSON("v0.2.0", false, compatibilityNote("0.1.0", "", 1, 9), "Armadra_0.2.0_darwin-aarch64.tar.gz")),
			installed: "0.1.0",
			options:   Options{ProtocolMajor: 1, ProtocolMinor: 1},
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE,
			reason:    ReasonIncompatible,
		},
		{
			name:      "a release that declares no compatibility is never offered",
			body:      index(releaseJSON("v0.2.0", false, "Just some notes.", "Armadra_0.2.0_darwin-aarch64.tar.gz")),
			installed: "0.1.0",
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE,
			reason:    ReasonIncompatible,
		},
		{
			name:      "a release that ships nothing for this target is reported",
			body:      index(releaseJSON("v0.2.0", false, note, "Armadra_0.2.0_linux-x86_64.tar.gz", "Armadra_0.2.0_windows-x86_64.zip")),
			installed: "0.1.0",
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE,
			reason:    ReasonNoArtifact,
		},
		{
			name:      "a body that is not a release index is malformed",
			body:      `{"message":"Not Found"}`,
			installed: "0.1.0",
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE,
			reason:    ReasonMalformed,
		},
		{
			name:      "truncated JSON is malformed",
			body:      `[{"tag_name":"v0.2.0"`,
			installed: "0.1.0",
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE,
			reason:    ReasonMalformed,
		},
		{
			name:      "a source error is never an offer",
			body:      index(releaseJSON("v0.2.0", false, note, "Armadra_0.2.0_darwin-aarch64.tar.gz")),
			status:    http.StatusInternalServerError,
			installed: "0.1.0",
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE,
			reason:    ReasonUnreachable,
		},
		{
			name:      "a rate-limited source is unreachable, not up to date",
			body:      `{"message":"API rate limit exceeded"}`,
			status:    http.StatusForbidden,
			installed: "0.1.0",
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE,
			reason:    ReasonUnreachable,
		},
		{
			name:      "a development build is never offered an update",
			body:      index(releaseJSON("v0.2.0", false, note, "Armadra_0.2.0_darwin-aarch64.tar.gz")),
			installed: "0.1.0",
			channel:   pb.ReleaseChannel_RELEASE_CHANNEL_DEVELOPMENT,
			state:     pb.UpdateCheckState_UPDATE_CHECK_STATE_UNSUPPORTED,
			reason:    ReasonDevelopment,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newFixture(t, test.body, test.options)
			if test.status != 0 {
				f.status = test.status
			}
			target := test.target
			if target == "" {
				target = testTarget
			}
			response := check(t, f.service, test.installed, test.channel, target)
			expect(t, response, test.state, test.reason)
			if response.GetInstalledVersion() == nil {
				t.Fatal("the response dropped the installed version it answered about")
			}
			if test.reason == ReasonUnreachable && response.GetRetryAfterMs() <= 0 {
				t.Fatal("an unreachable source gave no retry hint")
			}
		})
	}
}

// A body past the budget is never parsed: a source that can make this Host read
// unbounded memory is refused as unusable, not treated as "no update".
func TestOversizedIndexIsRefusedRatherThanRead(t *testing.T) {
	filler := strings.Repeat("x", 4096)
	note := compatibilityNote("0.1.0", "", 1, 0) + filler
	f := newFixture(t, index(releaseJSON("v0.2.0", false, note, "Armadra_0.2.0_darwin-aarch64.tar.gz")), Options{MaxBodyBytes: 512})
	expect(t, check(t, f.service, "0.1.0", pb.ReleaseChannel_RELEASE_CHANNEL_STABLE, testTarget), pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE, ReasonMalformed)
	// The same index under a budget that fits is read normally, so the refusal
	// above is the cap and not the document.
	generous := newFixture(t, index(releaseJSON("v0.2.0", false, note, "Armadra_0.2.0_darwin-aarch64.tar.gz")), Options{MaxBodyBytes: 1 << 16})
	expect(t, check(t, generous.service, "0.1.0", pb.ReleaseChannel_RELEASE_CHANNEL_STABLE, testTarget), pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE, "")
}

// A Host started without a release source authenticates and then says so. This
// is the one state that must never be shown to a person as "up to date".
func TestUnconfiguredHostReportsUnsupported(t *testing.T) {
	var service *Service
	response := check(t, service, "0.1.0", pb.ReleaseChannel_RELEASE_CHANNEL_STABLE, testTarget)
	expect(t, response, pb.UpdateCheckState_UPDATE_CHECK_STATE_UNSUPPORTED, ReasonNotConfigured)
	if response.GetCheckedAtUnixMs() == 0 {
		t.Fatal("an unsupported answer carried no timestamp")
	}
	if _, err := New(Options{ProtocolMajor: 1}); !errors.Is(err, ErrSource) {
		t.Fatalf("an empty source built a service: %v", err)
	}
}

// The offered release describes exactly one download, carries the signature
// state the source published, and never invents a verification.
func TestAvailableReleaseDescribesOneVerifiableArtifact(t *testing.T) {
	note := compatibilityNote("0.1.0", "1.0.0", 1, 1)
	body := index(
		releaseJSON("v0.2.0", false, note, "Armadra_0.2.0_darwin-aarch64.tar.gz", "Armadra_0.2.0_darwin-aarch64.tar.gz.sig", "Armadra_0.2.0_linux-x86_64.tar.gz"),
		releaseJSON("v0.1.5", false, note, "Armadra_0.1.5_darwin-aarch64.tar.gz"),
	)
	f := newFixture(t, body, Options{ProtocolMajor: 1, ProtocolMinor: 1})
	response := check(t, f.service, "0.1.0", pb.ReleaseChannel_RELEASE_CHANNEL_STABLE, testTarget)
	expect(t, response, pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE, "")
	release := response.GetRelease()
	if FormatVersion(release.GetVersion()) != "0.2.0" {
		t.Fatalf("the newest release was not chosen: %q", FormatVersion(release.GetVersion()))
	}
	if len(release.GetArtifacts()) != 1 || release.GetArtifacts()[0].GetTarget() != testTarget {
		t.Fatalf("the response did not narrow to the caller's own target: %v", release.GetArtifacts())
	}
	artifact := release.GetArtifacts()[0]
	if artifact.GetSignature().GetState() != pb.UpdateSignatureState_UPDATE_SIGNATURE_STATE_PRESENT {
		t.Fatal("a signed release did not report PRESENT")
	}
	if artifact.GetSignature().GetValue() != "" {
		t.Fatal("the Host echoed signature material it never read")
	}
	if len(artifact.GetSha256()) != 32 || artifact.GetSizeBytes() == 0 {
		t.Fatal("the artifact lost its published digest or size")
	}
	if release.GetNotesUrl() == "" || release.GetCompatibility() == nil {
		t.Fatal("the offer dropped the notes or the compatibility it was accepted under")
	}
	if f.hits != 1 {
		t.Fatalf("one check made %d requests", f.hits)
	}
}

// A release with no detached signature is offered as ABSENT rather than
// silently dropped: the shell decides whether an unsigned build is acceptable.
func TestUnsignedArtifactReportsAbsentSignature(t *testing.T) {
	f := newFixture(t, index(releaseJSON("v0.2.0", false, compatibilityNote("0.1.0", "", 1, 0), "Armadra_0.2.0_darwin-aarch64.tar.gz")), Options{})
	response := check(t, f.service, "0.1.0", pb.ReleaseChannel_RELEASE_CHANNEL_STABLE, testTarget)
	expect(t, response, pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE, "")
	if response.GetRelease().GetArtifacts()[0].GetSignature().GetState() != pb.UpdateSignatureState_UPDATE_SIGNATURE_STATE_ABSENT {
		t.Fatal("an unsigned artifact did not report ABSENT")
	}
}

// An operator pin overrides what a caller asks for, and the response says which
// channel was actually consulted.
func TestPinnedChannelOverridesTheRequest(t *testing.T) {
	note := compatibilityNote("0.1.0", "", 1, 0)
	body := index(releaseJSON("v0.3.0-beta.1", true, note, "Armadra_0.3.0_darwin-aarch64.tar.gz"))
	f := newFixture(t, body, Options{Channel: pb.ReleaseChannel_RELEASE_CHANNEL_STABLE})
	response := check(t, f.service, "0.1.0", pb.ReleaseChannel_RELEASE_CHANNEL_BETA, testTarget)
	expect(t, response, pb.UpdateCheckState_UPDATE_CHECK_STATE_UP_TO_DATE, "")
	if response.GetChannel() != pb.ReleaseChannel_RELEASE_CHANNEL_STABLE {
		t.Fatal("the response did not report the channel it actually consulted")
	}
	// An unspecified request channel defaults to the most conservative one.
	open := newFixture(t, body, Options{})
	if got := check(t, open.service, "0.1.0", pb.ReleaseChannel_RELEASE_CHANNEL_UNSPECIFIED, testTarget); got.GetChannel() != pb.ReleaseChannel_RELEASE_CHANNEL_STABLE {
		t.Fatalf("an unspecified channel was not defaulted to stable: %v", got.GetChannel())
	}
}

// A source this Host cannot dial at all is unreachable, and the failure text
// never carries the address the operator configured.
func TestUnreachableSourceNeverLeaksItsAddress(t *testing.T) {
	f := newFixture(t, index(), Options{})
	source := f.service.source
	closed := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	closed.Close()
	service, err := New(Options{Source: closed.URL, ProtocolMajor: 1, Timeout: 250 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	response := check(t, service, "0.1.0", pb.ReleaseChannel_RELEASE_CHANNEL_STABLE, testTarget)
	expect(t, response, pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE, ReasonUnreachable)
	if strings.Contains(response.GetReasonCode(), source) {
		t.Fatal("the reason code carried the configured source")
	}
	_, fetchErr := service.fetch(context.Background())
	if fetchErr == nil || strings.Contains(fetchErr.Error(), closed.URL) || strings.Contains(fetchErr.Error(), "127.0.0.1") {
		t.Fatalf("the fetch error carried the source address: %v", fetchErr)
	}
}

// A cancelled or timed-out check is a state, not a hang.
func TestSlowSourceIsBoundedByTheRequestTimeout(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	service, err := New(Options{Source: server.URL, ProtocolMajor: 1, Timeout: 150 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	expect(t, check(t, service, "0.1.0", pb.ReleaseChannel_RELEASE_CHANNEL_STABLE, testTarget), pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE, ReasonUnreachable)
	if time.Since(started) > 5*time.Second {
		t.Fatal("the check outlived its own timeout")
	}
}

// A request this Host cannot act on is an error the transport turns into
// INVALID_ARGUMENT, never a check result the caller could misread.
func TestMalformedRequestsAreRefusedRatherThanAnswered(t *testing.T) {
	f := newFixture(t, index(), Options{})
	for _, request := range []*pb.CheckForUpdateRequest{
		{Target: testTarget},
		{InstalledVersion: &pb.SemanticVersion{}, Target: "darwin"},
		{InstalledVersion: &pb.SemanticVersion{}, Target: "solaris-sparc"},
		{InstalledVersion: &pb.SemanticVersion{}, Target: "darwin-aarch64;rm"},
	} {
		if _, err := f.service.Check(context.Background(), request); !errors.Is(err, ErrInvalid) {
			t.Fatalf("an unusable request was answered: %v", request)
		}
	}
	if f.hits != 0 {
		t.Fatal("an invalid request still contacted the release source")
	}
}

// Downloading and applying exist in the contract so their states do; neither is
// implemented, and neither may answer with anything that reads as progress.
func TestTransferAndApplyReportUnsupported(t *testing.T) {
	f := newFixture(t, index(), Options{})
	version := &pb.SemanticVersion{Major: 0, Minor: 2}
	download, err := f.service.Download(context.Background(), &pb.DownloadUpdateRequest{Version: version, Target: testTarget})
	if err != nil {
		t.Fatal(err)
	}
	if download.GetState() != pb.UpdateTransferState_UPDATE_TRANSFER_STATE_UNSUPPORTED || download.GetReceivedBytes() != 0 || download.GetReasonCode() == "" {
		t.Fatalf("download did not report an honest unsupported state: %v", download)
	}
	apply, err := f.service.Apply(context.Background(), &pb.ApplyUpdateRequest{Version: version, ExpectedSha256: make([]byte, 32)})
	if err != nil {
		t.Fatal(err)
	}
	if apply.GetState() != pb.UpdateApplyState_UPDATE_APPLY_STATE_UNSUPPORTED || apply.GetReasonCode() == "" {
		t.Fatalf("apply did not report an honest unsupported state: %v", apply)
	}
	// An apply that names a digest nothing verified is refused outright.
	if _, err := f.service.Apply(context.Background(), &pb.ApplyUpdateRequest{Version: version}); !errors.Is(err, ErrInvalid) {
		t.Fatal("apply accepted a request with no expected digest")
	}
	if _, err := f.service.Download(context.Background(), &pb.DownloadUpdateRequest{Version: version, Target: "nonsense"}); !errors.Is(err, ErrInvalid) {
		t.Fatal("download accepted an unusable target")
	}
	if f.hits != 0 {
		t.Fatal("an unimplemented method still contacted the release source")
	}
}

func TestParseSourceRefusesUnusableAddresses(t *testing.T) {
	for _, value := range []string{
		"", " https://example.invalid", "https://example.invalid ", "ftp://example.invalid",
		"http://example.invalid", "https://user:secret@example.invalid/repos/a/b",
		"https://example.invalid/repos/a/b?token=secret", "https://example.invalid/repos#frag",
		"https:///repos/a/b", "not a url",
	} {
		if _, err := ParseSource(value); err == nil {
			t.Fatalf("an unusable source was accepted: %q", value)
		}
	}
	for _, value := range []string{
		"https://api.github.com/repos/armadra/armadra",
		"https://api.github.com/repos/armadra/armadra/",
		"http://127.0.0.1:8123/repos/armadra/armadra",
	} {
		normalized, err := ParseSource(value)
		if err != nil {
			t.Fatalf("a usable source was refused: %q (%v)", value, err)
		}
		if strings.HasSuffix(normalized, "/") {
			t.Fatalf("a source kept a trailing slash: %q", normalized)
		}
	}
	if !strings.Contains(ErrSource.Error(), "HTTPS") || strings.Contains(ErrSource.Error(), "http://") {
		t.Fatal("the source error text is not a value-free explanation")
	}
}

func TestVersionsAreComparedStructurally(t *testing.T) {
	for _, value := range []string{"", "1", "1.2", "1.2.3.4", "01.2.3", "1.2.x", "v", "1.2.3-", "1.2.3-bad!", strings.Repeat("1", 200)} {
		if _, err := ParseVersion(value); err == nil {
			t.Fatalf("an unparseable tag was accepted: %q", value)
		}
	}
	ordered := []string{"0.1.0", "0.2.0-alpha", "0.2.0-alpha.1", "0.2.0-alpha.2", "0.2.0-beta", "0.2.0", "0.2.1", "0.10.0", "1.0.0", "10.0.0"}
	for i := 0; i+1 < len(ordered); i++ {
		left, err := ParseVersion(ordered[i])
		if err != nil {
			t.Fatal(err)
		}
		right, err := ParseVersion(ordered[i+1])
		if err != nil {
			t.Fatal(err)
		}
		if Compare(left, right) >= 0 {
			t.Fatalf("%q did not sort below %q", ordered[i], ordered[i+1])
		}
		if Compare(right, left) <= 0 || Compare(left, left) != 0 {
			t.Fatalf("comparison is not a total order around %q", ordered[i])
		}
	}
	build, err := ParseVersion("v1.2.3+20260901")
	if err != nil || FormatVersion(build) != "1.2.3" {
		t.Fatalf("build metadata was not dropped: %q (%v)", FormatVersion(build), err)
	}
}

func TestAssetTargetIsReadFromTheName(t *testing.T) {
	for name, want := range map[string]string{
		"Armadra_0.2.0_darwin-aarch64.tar.gz": "darwin-aarch64",
		"Armadra_0.2.0_linux-x86_64.AppImage": "linux-x86_64",
		"Armadra_0.2.0_windows-x86_64.zip":    "windows-x86_64",
		"Armadra-0.2.0-universal.dmg":         "",
		"checksums.txt":                       "",
	} {
		if got := assetTarget(name); got != want {
			t.Fatalf("%q resolved to %q, expected %q", name, got, want)
		}
	}
	for _, valid := range []string{"darwin-aarch64", "linux-x86_64", "windows-x86_64"} {
		if !ValidTarget(valid) {
			t.Fatalf("a documented target was refused: %q", valid)
		}
	}
	for _, invalid := range []string{"", "darwin", "-aarch64", "plan9-amd64", "darwin-AARCH64", "darwin-aarch64-extra "} {
		if ValidTarget(invalid) {
			t.Fatalf("an unusable target was accepted: %q", invalid)
		}
	}
}

// A caller that cannot name its own build target — a browser is told neither
// the CPU nor the ABI — leaves it empty, and the Host answers about the machine
// it is itself running on rather than guessing one.
func TestAnEmptyTargetResolvesToThisMachine(t *testing.T) {
	local := LocalTarget()
	if !ValidTarget(local) {
		t.Skipf("this platform has no documented release target: %q", local)
	}
	note := compatibilityNote("0.1.0", "", 1, 0)
	asset := "Armadra_0.2.0_" + local + ".tar.gz"
	f := newFixture(t, index(releaseJSON("v0.2.0", false, note, asset, asset+".sig")), Options{})
	response := check(t, f.service, "0.1.0", pb.ReleaseChannel_RELEASE_CHANNEL_STABLE, "")
	expect(t, response, pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE, "")
	if response.GetRelease().GetArtifacts()[0].GetTarget() != local {
		t.Fatalf("the resolved target was not this machine: %v", response.GetRelease().GetArtifacts()[0].GetTarget())
	}
	// A release that ships nothing for this machine is still reported, not offered.
	other := newFixture(t, index(releaseJSON("v0.2.0", false, note, "Armadra_0.2.0_plan9-mips.tar.gz")), Options{})
	expect(t, check(t, other.service, "0.1.0", pb.ReleaseChannel_RELEASE_CHANNEL_STABLE, ""), pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE, ReasonNoArtifact)
}
