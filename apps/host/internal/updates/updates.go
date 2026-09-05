// Package updates answers the application update contract (platform design
// §3 S03, roadmap §3.12).
//
// It reads a release index and decides one thing: whether a release exists that
// this build could safely move to. It never downloads a payload, never verifies
// a signature, and never installs anything — applying an update is the shell's
// own explicit act, and verification belongs to the installer that holds the
// public key. A Host with no configured source answers UNSUPPORTED: not looking
// is not the same as looking and finding nothing.
package updates

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
)

// ErrInvalid is a request this Host cannot act on at all — no target, no
// installed version. It is not a check result; it is a caller error.
var ErrInvalid = errors.New("invalid update request")

// Stable machine tokens. A reason code is never a URL, a response body or an
// operator's source address: it is a word a UI can translate and a log can keep.
const (
	ReasonNotConfigured = "UPDATES_NOT_CONFIGURED"
	ReasonUnreachable   = "SOURCE_UNREACHABLE"
	ReasonMalformed     = "SOURCE_MALFORMED"
	ReasonIncompatible  = "COMPATIBILITY_REFUSED"
	ReasonNoArtifact    = "NO_ARTIFACT_FOR_TARGET"
	// A locally built or side-loaded build never auto-updates, so a check on
	// the development channel is answered as unsupported rather than refused.
	ReasonDevelopment = "CHANNEL_NOT_UPDATABLE"
	// Neither transfer nor apply is implemented. They report it in their own
	// state rather than returning a success nothing performed.
	ReasonTransferUnsupported = "DOWNLOAD_NOT_IMPLEMENTED"
	ReasonApplyUnsupported    = "APPLY_NOT_IMPLEMENTED"
)

const (
	defaultTimeout   = 8 * time.Second
	defaultMaxBody   = 1 << 20
	unreachableRetry = 15 * 60 * 1000
	releasesPath     = "/releases?per_page=50"
)

type Options struct {
	// Source is the releases API base, e.g.
	// "https://api.github.com/repos/OWNER/REPO". Empty means update checks are
	// unsupported on this Host; nothing is inferred from the build.
	Source string
	// Channel pins this Host to one channel regardless of what a caller asks
	// for. UNSPECIFIED lets the request choose, defaulting to stable.
	Channel pb.ReleaseChannel
	// ProtocolMajor/ProtocolMinor are what this Host speaks. A release that
	// demands another major is reported, never offered.
	ProtocolMajor, ProtocolMinor uint32
	Client                       *http.Client
	Clock                        func() time.Time
	Timeout                      time.Duration
	MaxBodyBytes                 int64
}

// Configured reports whether the operator gave this Host a release source.
func Configured(options Options) bool { return strings.TrimSpace(options.Source) != "" }

type Service struct {
	source       string
	channel      pb.ReleaseChannel
	major, minor uint32
	client       *http.Client
	clock        func() time.Time
	maxBody      int64
}

// New validates the configuration once, at startup, so a bad source is a
// refusal to start rather than a surprise on the first check.
func New(options Options) (*Service, error) {
	if !Configured(options) {
		return nil, ErrSource
	}
	source, err := ParseSource(options.Source)
	if err != nil {
		return nil, err
	}
	if options.ProtocolMajor == 0 {
		return nil, errors.New("update service requires the Host protocol version")
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	client := options.Client
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	clock := options.Clock
	if clock == nil {
		clock = time.Now
	}
	body := options.MaxBodyBytes
	if body <= 0 {
		body = defaultMaxBody
	}
	channel := options.Channel
	switch channel {
	case pb.ReleaseChannel_RELEASE_CHANNEL_UNSPECIFIED,
		pb.ReleaseChannel_RELEASE_CHANNEL_STABLE,
		pb.ReleaseChannel_RELEASE_CHANNEL_BETA,
		pb.ReleaseChannel_RELEASE_CHANNEL_DEVELOPMENT:
	default:
		return nil, errors.New("unknown pinned release channel")
	}
	return &Service{source: source, channel: channel, major: options.ProtocolMajor, minor: options.ProtocolMinor, client: client, clock: clock, maxBody: body}, nil
}

func (s *Service) now() time.Time {
	if s == nil || s.clock == nil {
		return time.Now()
	}
	return s.clock()
}

// Check answers the contract's CheckForUpdate. A nil Service is the Host that
// was started without a release source: it authenticates the caller and then
// says UNSUPPORTED, which is never rendered as "up to date".
func (s *Service) Check(ctx context.Context, request *pb.CheckForUpdateRequest) (*pb.CheckForUpdateResponse, error) {
	installed := request.GetInstalledVersion()
	// An empty target means "this machine": a browser is told neither the CPU
	// nor the ABI, and a guessed target would silently offer the wrong build.
	// A target that is spelled out must still be one the contract documents.
	target := request.GetTarget()
	if target == "" {
		target = LocalTarget()
	}
	// An empty component means "desktop": the shell was the only caller before
	// protocol minor 2, and an old client must keep getting the answer it
	// already understood. A component this Host does not publish is a caller
	// error, not an empty answer.
	component := request.GetComponent()
	if component == "" {
		component = ComponentDesktop
	}
	if installed == nil || !ValidTarget(target) || !ValidComponent(component) {
		return nil, ErrInvalid
	}
	channel := request.GetChannel()
	if channel == pb.ReleaseChannel_RELEASE_CHANNEL_UNSPECIFIED {
		channel = pb.ReleaseChannel_RELEASE_CHANNEL_STABLE
	}
	if s != nil && s.channel != pb.ReleaseChannel_RELEASE_CHANNEL_UNSPECIFIED {
		channel = s.channel
	}
	answer := func(state pb.UpdateCheckState, reason string) *pb.CheckForUpdateResponse {
		return &pb.CheckForUpdateResponse{
			State:            state,
			Channel:          channel,
			InstalledVersion: installed,
			ReasonCode:       reason,
			CheckedAtUnixMs:  s.now().UnixMilli(),
		}
	}
	if s == nil {
		return answer(pb.UpdateCheckState_UPDATE_CHECK_STATE_UNSUPPORTED, ReasonNotConfigured), nil
	}
	if channel == pb.ReleaseChannel_RELEASE_CHANNEL_DEVELOPMENT {
		return answer(pb.UpdateCheckState_UPDATE_CHECK_STATE_UNSUPPORTED, ReasonDevelopment), nil
	}
	body, err := s.fetch(ctx)
	switch {
	case errors.Is(err, errOversize):
		// A body past the budget was never read to the end, so it is not a
		// release index this Host can reason about — it is an unusable source.
		return answer(pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE, ReasonMalformed), nil
	case err != nil:
		response := answer(pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE, ReasonUnreachable)
		response.RetryAfterMs = unreachableRetry
		return response, nil
	}
	documents, err := decodeReleases(body)
	if err != nil {
		return answer(pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE, ReasonMalformed), nil
	}
	candidate := newest(documents, channel)
	// Nothing published, or nothing newer: the source was read and it holds no
	// release this build should move to.
	if candidate == nil || Compare(candidate.GetVersion(), installed) <= 0 {
		return answer(pb.UpdateCheckState_UPDATE_CHECK_STATE_UP_TO_DATE, ""), nil
	}
	if !s.accepts(candidate.GetCompatibility(), installed) {
		return answer(pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE, ReasonIncompatible), nil
	}
	artifact := artifactFor(candidate, target, component)
	if artifact == nil {
		return answer(pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE, ReasonNoArtifact), nil
	}
	// Only the caller's own artifact is returned: the response describes one
	// download, so nothing downstream has to choose between platforms.
	offered := &pb.ReleaseInfo{
		Version:           candidate.GetVersion(),
		Channel:           candidate.GetChannel(),
		PublishedAtUnixMs: candidate.GetPublishedAtUnixMs(),
		NotesUrl:          candidate.GetNotesUrl(),
		Compatibility:     candidate.GetCompatibility(),
		Artifacts:         []*pb.UpdateArtifact{artifact},
	}
	response := answer(pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE, "")
	response.Release = offered
	return response, nil
}

// Download is declared by the contract so its states exist; this Host does not
// transfer bytes. It reports UNSUPPORTED rather than a zero-byte success.
func (s *Service) Download(_ context.Context, request *pb.DownloadUpdateRequest) (*pb.DownloadUpdateResponse, error) {
	if request.GetVersion() == nil || !ValidTarget(request.GetTarget()) {
		return nil, ErrInvalid
	}
	return &pb.DownloadUpdateResponse{State: pb.UpdateTransferState_UPDATE_TRANSFER_STATE_UNSUPPORTED, ReasonCode: ReasonTransferUnsupported}, nil
}

// Apply likewise reports UNSUPPORTED. A staged install that nothing verified
// must never be reported as staged.
func (s *Service) Apply(_ context.Context, request *pb.ApplyUpdateRequest) (*pb.ApplyUpdateResponse, error) {
	if request.GetVersion() == nil || len(request.GetExpectedSha256()) != 32 {
		return nil, ErrInvalid
	}
	return &pb.ApplyUpdateResponse{State: pb.UpdateApplyState_UPDATE_APPLY_STATE_UNSUPPORTED, ReasonCode: ReasonApplyUnsupported}, nil
}

// fetch reads the release index under a request timeout and a body budget. The
// returned error is deliberately opaque: it exists to select a reason code, and
// carrying the URL or the body into it would put both into a log line.
func (s *Service) fetch(parent context.Context) ([]byte, error) {
	timeout := defaultTimeout
	if s.client != nil && s.client.Timeout > 0 {
		timeout = s.client.Timeout
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.source+releasesPath, nil)
	if err != nil {
		return nil, errors.New("release source is unreachable")
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	response, err := s.client.Do(request)
	if err != nil {
		return nil, errors.New("release source is unreachable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, errors.New("release source is unreachable")
	}
	// One byte over the budget is read on purpose: a body that fills the cap
	// exactly is indistinguishable from a truncated one otherwise.
	body, err := io.ReadAll(io.LimitReader(response.Body, s.maxBody+1))
	if err != nil {
		return nil, errors.New("release source is unreachable")
	}
	if int64(len(body)) > s.maxBody {
		return nil, errOversize
	}
	return body, nil
}

var errOversize = errors.New("release index exceeds its budget")

// newest picks the highest release the channel accepts. A draft, an unparseable
// tag, or a pre-release on the stable channel is skipped rather than repaired.
func newest(documents []releaseDocument, channel pb.ReleaseChannel) *pb.ReleaseInfo {
	var best *pb.ReleaseInfo
	for _, document := range documents {
		if document.Draft {
			continue
		}
		info, err := release(document)
		if err != nil {
			continue
		}
		if channel == pb.ReleaseChannel_RELEASE_CHANNEL_STABLE && info.GetChannel() != pb.ReleaseChannel_RELEASE_CHANNEL_STABLE {
			continue
		}
		if best == nil || Compare(info.GetVersion(), best.GetVersion()) > 0 {
			best = info
		}
	}
	return best
}

// accepts applies the release's declared range. A release that declares no
// range is refused: an upgrade whose migration path nobody stated is a data
// hazard, and silence is not a promise of compatibility.
func (s *Service) accepts(compatibility *pb.UpdateCompatibility, installed *pb.SemanticVersion) bool {
	if compatibility == nil || compatibility.GetMinimumInstalled() == nil {
		return false
	}
	if Compare(installed, compatibility.GetMinimumInstalled()) < 0 {
		return false
	}
	if maximum := compatibility.GetMaximumInstalled(); maximum != nil && Compare(installed, maximum) > 0 {
		return false
	}
	if compatibility.GetProtocolMajor() != s.major {
		return false
	}
	return compatibility.GetMinimumProtocolMinor() <= s.minor
}

// artifactFor picks the one download that answers a caller's target and
// component. Two components are published once for every platform — the
// updater manifest and the checksum list, and the built web bundle — and only
// those may answer a request whose target they do not name. For every other
// component an unreadable target is as good as a wrong one: an asset whose
// name this Host cannot place is never offered to a machine it might not run
// on. An artifact that declares no component answers nobody, because a
// publisher who did not say which program a file carries has not offered it.
func artifactFor(info *pb.ReleaseInfo, target, component string) *pb.UpdateArtifact {
	for _, artifact := range info.GetArtifacts() {
		if artifact.GetComponent() != component {
			continue
		}
		if TargetlessComponent(component) {
			if artifact.GetTarget() != "" {
				continue
			}
		} else if artifact.GetTarget() != target {
			continue
		}
		return artifact
	}
	return nil
}
