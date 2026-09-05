package updates

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"runtime"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
)

// ErrSource means the configured release source is not a usable address. Its
// text never contains the value: an operator's URL can carry a token, and a
// startup error is the one place it would end up in a log file.
var ErrSource = errors.New("release source must be an absolute HTTPS URL without credentials, query or fragment")

// CompatibilityFence is the marker a release note carries its compatibility
// declaration under. GitHub has nowhere else to put one, and the Host refuses
// to invent it: a release that does not say which installed versions it accepts
// is never offered, only reported.
const CompatibilityFence = "armadra-compatibility"

const (
	maxReleases      = 50
	maxAssets        = 60
	maxCompatibility = 4096
)

// ParseSource validates and canonicalizes a releases API base, for example
// "https://api.github.com/repos/OWNER/REPO". Loopback HTTP is allowed so a
// test (or an air-gapped mirror on this machine) can serve one without TLS.
func ParseSource(value string) (string, error) {
	text := strings.TrimSpace(value)
	if text == "" || text != value || len(text) > 2048 {
		return "", ErrSource
	}
	parsed, err := url.Parse(text)
	if err != nil || parsed.User != nil || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.Host == "" {
		return "", ErrSource
	}
	switch parsed.Scheme {
	case "https":
	case "http":
		if !loopback(parsed.Hostname()) {
			return "", ErrSource
		}
	default:
		return "", ErrSource
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed.String(), nil
}

func loopback(host string) bool {
	return host == "localhost" || host == "::1" || host == "127.0.0.1" || strings.HasPrefix(host, "127.")
}

// releaseDocument mirrors only the GitHub Releases fields this Host reads.
// Everything else in the payload is ignored rather than retained.
type releaseDocument struct {
	Tag         string          `json:"tag_name"`
	Draft       bool            `json:"draft"`
	Prerelease  bool            `json:"prerelease"`
	PublishedAt string          `json:"published_at"`
	HTMLURL     string          `json:"html_url"`
	Body        string          `json:"body"`
	Assets      []assetDocument `json:"assets"`
}

type assetDocument struct {
	Name   string `json:"name"`
	URL    string `json:"browser_download_url"`
	Size   uint64 `json:"size"`
	Digest string `json:"digest"`
}

// compatibilityDocument is the declaration embedded in a release note. Absent
// or unreadable, the release is refused rather than assumed compatible.
type compatibilityDocument struct {
	MinimumInstalled     string `json:"minimumInstalled"`
	MaximumInstalled     string `json:"maximumInstalled"`
	ProtocolMajor        uint32 `json:"protocolMajor"`
	MinimumProtocolMinor uint32 `json:"minimumProtocolMinor"`
}

// decodeReleases reads the releases array. A body that is not the shape this
// Host expects is a malformed source, never an empty list of releases: "no
// releases" and "could not read the releases" are different answers.
func decodeReleases(body []byte) ([]releaseDocument, error) {
	var documents []releaseDocument
	if err := json.Unmarshal(body, &documents); err != nil {
		return nil, err
	}
	if len(documents) > maxReleases {
		documents = documents[:maxReleases]
	}
	return documents, nil
}

// release converts one document into the contract's ReleaseInfo, or reports
// that it is not a release this Host can reason about.
func release(document releaseDocument) (*pb.ReleaseInfo, error) {
	version, err := ParseVersion(document.Tag)
	if err != nil {
		return nil, err
	}
	// GitHub's own "prerelease" flag and a pre-release suffix are both taken as
	// authoritative: whichever says pre-release wins.
	prerelease := document.Prerelease || version.GetPrerelease() != ""
	info := &pb.ReleaseInfo{Version: version, Channel: pb.ReleaseChannel_RELEASE_CHANNEL_STABLE}
	if prerelease {
		info.Channel = pb.ReleaseChannel_RELEASE_CHANNEL_BETA
	}
	if notes, err := url.Parse(document.HTMLURL); err == nil && notes.Scheme == "https" && notes.Host != "" {
		info.NotesUrl = notes.String()
	}
	if stamp, err := time.Parse(time.RFC3339, document.PublishedAt); err == nil {
		info.PublishedAtUnixMs = stamp.UnixMilli()
	}
	info.Compatibility = compatibility(document.Body)
	info.Artifacts = artifacts(document.Assets)
	return info, nil
}

// compatibility extracts the fenced declaration from a release note. Nothing
// else in the note is read, and the note itself is never returned or logged.
func compatibility(body string) *pb.UpdateCompatibility {
	marker := "```" + CompatibilityFence
	start := strings.Index(body, marker)
	if start < 0 {
		return nil
	}
	rest := body[start+len(marker):]
	if end := strings.Index(rest, "```"); end >= 0 {
		rest = rest[:end]
	}
	if len(rest) > maxCompatibility {
		return nil
	}
	var document compatibilityDocument
	decoder := json.NewDecoder(strings.NewReader(rest))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return nil
	}
	minimum, err := ParseVersion(document.MinimumInstalled)
	if err != nil {
		return nil
	}
	result := &pb.UpdateCompatibility{
		MinimumInstalled:     minimum,
		ProtocolMajor:        document.ProtocolMajor,
		MinimumProtocolMinor: document.MinimumProtocolMinor,
	}
	if strings.TrimSpace(document.MaximumInstalled) != "" {
		maximum, err := ParseVersion(document.MaximumInstalled)
		if err != nil {
			return nil
		}
		result.MaximumInstalled = maximum
	}
	return result
}

// artifacts pairs each downloadable asset with its detached signature. The
// Host reads names and digests only; it never fetches an asset's bytes.
func artifacts(assets []assetDocument) []*pb.UpdateArtifact {
	if len(assets) > maxAssets {
		assets = assets[:maxAssets]
	}
	signatures := make(map[string]string, len(assets))
	for _, asset := range assets {
		if strings.HasSuffix(asset.Name, ".sig") {
			signatures[strings.TrimSuffix(asset.Name, ".sig")] = asset.Name
		}
	}
	result := make([]*pb.UpdateArtifact, 0, len(assets))
	for _, asset := range assets {
		if strings.HasSuffix(asset.Name, ".sig") || asset.Name == "" {
			continue
		}
		download, err := url.Parse(asset.URL)
		if err != nil || download.Host == "" || (download.Scheme != "https" && !(download.Scheme == "http" && loopback(download.Hostname()))) {
			continue
		}
		artifact := &pb.UpdateArtifact{
			Target:    assetTarget(asset.Name),
			Url:       download.String(),
			SizeBytes: asset.Size,
			Sha256:    digest(asset.Digest),
			Signature: &pb.UpdateSignature{State: pb.UpdateSignatureState_UPDATE_SIGNATURE_STATE_ABSENT},
		}
		// PRESENT means the release published a detached signature next to the
		// artifact. The Host does not read it and never claims it verified one.
		if _, signed := signatures[asset.Name]; signed {
			artifact.Signature = &pb.UpdateSignature{State: pb.UpdateSignatureState_UPDATE_SIGNATURE_STATE_PRESENT}
		}
		result = append(result, artifact)
	}
	return result
}

func digest(value string) []byte {
	text, found := strings.CutPrefix(value, "sha256:")
	if !found || len(text) != 64 {
		return nil
	}
	sum, err := hex.DecodeString(text)
	if err != nil {
		return nil
	}
	return sum
}

// assetTarget is the build target an asset name declares, e.g.
// "Armadra_0.2.0_darwin-aarch64.tar.gz" -> "darwin-aarch64". A name that
// declares none gets an empty target and matches no caller.
func assetTarget(name string) string {
	lower := strings.ToLower(name)
	for _, system := range []string{"darwin", "linux", "windows"} {
		index := strings.Index(lower, system+"-")
		if index < 0 {
			continue
		}
		// The operating system name must start a name segment, so "xdarwin-"
		// never reads as a target. "_" is a segment break in the published
		// names even though an architecture may contain one ("x86_64").
		if index > 0 && alphanumeric(lower[index-1]) {
			continue
		}
		rest := lower[index+len(system)+1:]
		end := 0
		for end < len(rest) && (alphanumeric(rest[end]) || rest[end] == '_') {
			end++
		}
		if end == 0 {
			continue
		}
		return system + "-" + rest[:end]
	}
	return ""
}

func alphanumeric(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= '0' && c <= '9'
}

// LocalTarget is the build target of the machine this Host runs on, in the
// contract's "<os>-<arch>" spelling. It exists so a caller that cannot name its
// own target — a browser, which is told neither the CPU nor the ABI — does not
// have to guess one. The Host only ever serves loopback and its own origin, so
// its machine is the caller's machine.
func LocalTarget() string {
	arch := runtime.GOARCH
	switch arch {
	case "arm64":
		arch = "aarch64"
	case "amd64":
		arch = "x86_64"
	}
	target := runtime.GOOS + "-" + arch
	if !ValidTarget(target) {
		return ""
	}
	return target
}

// ValidTarget accepts the "<os>-<arch>" shape the contract documents. A caller
// asking for anything else is an invalid request, not an empty answer.
func ValidTarget(value string) bool {
	system, arch, found := strings.Cut(value, "-")
	if !found || len(value) > 64 {
		return false
	}
	switch system {
	case "darwin", "linux", "windows":
	default:
		return false
	}
	if arch == "" {
		return false
	}
	for i := 0; i < len(arch); i++ {
		c := arch[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}
