// Package githubhost serves the Host's authenticated GitHub surface. It owns
// authorization, the status mapping, external references and the remote
// read-before-write checks; githubapi owns the transport.
//
// Nothing here ever returns a token. External content — Issue bodies, comments,
// diffs — is transported as material for a reader and is never given authority.
package githubhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strconv"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/githubapi"
	"armadra.local/host/internal/githubcred"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

var (
	// ErrUnsupported means this Host cannot serve the request at all — no
	// credential service, or no credential configured. A caller answers
	// UNSUPPORTED rather than returning an empty list that reads as "none".
	ErrUnsupported = errors.New("this host has no usable github credential")
	ErrInvalid     = errors.New("invalid github request")
	ErrPermission  = errors.New("github permission denied")
	ErrRateLimited = errors.New("github rate limit reached")
	// ErrUnknownOutcome means a write left this process and its result was not
	// read. It is never softened into a failure, because a retry could
	// duplicate a comment, a review or a merge.
	ErrUnknownOutcome = errors.New("github write outcome is unknown")
)

const (
	ScopeRead  = "github:read"
	ScopeWrite = "github:write"
	// This deployment has no webhook, so the client polls at the interval the
	// Host names rather than one it invents.
	PollIntervalMS = 30_000
	MaxGroups      = 32
	MaxPageLimit   = 100
	maxCursorPage  = 1000
	maxComments    = 100
	maxFiles       = 300
)

var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$`)
var groupPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`)

// Caller is the verified session. Identity comes from the authenticated
// session alone; a request never supplies it.
type Caller struct {
	PrincipalID, DeviceID, WorkspaceID string
	DeviceEpoch                        uint64
	Scopes                             []auth.Scope
}

type Service struct {
	store       *storage.Store
	credentials *githubcred.Service
	hostID      string
	now         func() time.Time
}

type Options struct {
	Store       *storage.Store
	Credentials *githubcred.Service
	HostID      string
	Now         func() time.Time
}

func New(options Options) (*Service, error) {
	if options.Store == nil || options.Credentials == nil || options.HostID == "" {
		return nil, ErrInvalid
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Service{store: options.Store, credentials: options.Credentials, hostID: options.HostID, now: now}, nil
}

func (c Caller) valid() bool {
	return c.PrincipalID != "" && c.DeviceID != "" && c.DeviceEpoch > 0 && idPattern.MatchString(c.WorkspaceID) && len(c.Scopes) > 0
}

// authorize checks the verified session's own grants for this workspace and
// this execution host. It never widens an empty or host-wide request.
func (s *Service) authorize(caller Caller, permission string) error {
	if s == nil {
		return ErrUnsupported
	}
	if !caller.valid() {
		return ErrPermission
	}
	if !auth.Permits(caller.Scopes, []auth.Scope{{Permission: permission, WorkspaceID: caller.WorkspaceID, ExecutionHostID: s.hostID}}) {
		return ErrPermission
	}
	return nil
}

// client resolves the configured credential. A Host with none refuses rather
// than sending an anonymous request that would quietly read only public data.
func (s *Service) client(ctx context.Context) (*githubapi.Client, error) {
	client, err := s.credentials.Client(ctx)
	if err != nil {
		if errors.Is(err, githubcred.ErrUnavailable) || errors.Is(err, githubcred.ErrUnsupported) {
			return nil, ErrUnsupported
		}
		return nil, err
	}
	return client, nil
}

// translate maps a transport refusal onto a Host-level meaning and records a
// credential failure, so the settings page can say the token stopped working.
func (s *Service) translate(err error) error {
	if err == nil {
		return nil
	}
	code := githubapi.CodeOf(err)
	s.credentials.NoteFailure(code)
	switch code {
	case githubapi.CodeUnauthenticated:
		return ErrUnsupported
	case githubapi.CodePermission:
		return ErrPermission
	case githubapi.CodeNotFound:
		return storage.ErrNotFound
	case githubapi.CodeConflict:
		return storage.ErrConflict
	case githubapi.CodeRateLimited:
		return ErrRateLimited
	case githubapi.CodeUnknownOutcome:
		return ErrUnknownOutcome
	case githubapi.CodeInvalid, githubapi.CodeUnsupported:
		return ErrInvalid
	}
	return err
}

// repository normalizes and checks the reference a request named. The API base
// always comes from this Host's configuration, never from the request, so a
// client cannot retarget a call at another service.
func (s *Service) repository(ctx context.Context, ref *pb.GithubRepositoryRef) (*pb.GithubRepositoryRef, error) {
	client, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	if ref == nil || !githubapi.ValidName(ref.Owner) || !githubapi.ValidName(ref.Name) {
		return nil, ErrInvalid
	}
	base := client.APIBase()
	if ref.ApiBase != "" && ref.ApiBase != base {
		return nil, ErrInvalid
	}
	host := githubapi.WebHostFor(base)
	// A reference naming another web host would send this repository's name to
	// the wrong service; it is refused rather than rewritten.
	if ref.Host != "" && ref.Host != host {
		return nil, ErrInvalid
	}
	return &pb.GithubRepositoryRef{Owner: ref.Owner, Name: ref.Name, ApiBase: base, Host: host}, nil
}

func key(ref *pb.GithubRepositoryRef) storage.GithubRepositoryKey {
	return storage.GithubRepositoryKey{Owner: ref.Owner, Name: ref.Name, APIBase: ref.ApiBase, WebHost: ref.Host}
}

func rate(value githubapi.RateLimit) *pb.GithubRateLimit {
	return &pb.GithubRateLimit{Limit: value.Limit, Remaining: value.Remaining, ResetsAtUnixMs: value.ResetsAtMS, Throttled: value.Throttled, RetryAfterUnixMs: value.RetryAfterMS}
}

// cursor is a page number, not a remote URL. A cursor that was a URL would let
// a response steer the next request.
func decodeCursor(value string) (int, error) {
	if value == "" {
		return 1, nil
	}
	page, err := strconv.Atoi(value)
	if err != nil || page < 2 || page > maxCursorPage {
		return 0, ErrInvalid
	}
	return page, nil
}

func encodeCursor(page int) string {
	if page < 2 || page > maxCursorPage {
		return ""
	}
	return strconv.Itoa(page)
}

func pageLimit(value uint32) int {
	limit := int(value)
	if limit <= 0 || limit > MaxPageLimit {
		limit = 50
	}
	return limit
}

// referenceID is derived from what the link means, so linking the same Issue to
// the same target twice is the same record rather than two badges.
func referenceID(workspace string, ref *pb.GithubRepositoryRef, kind pb.GithubReferenceKind, number int64, targetKind pb.GithubReferenceTargetKind, target string) string {
	sum := sha256.Sum256([]byte(workspace + "\x00" + ref.ApiBase + "\x00" + ref.Owner + "/" + ref.Name + "\x00" + strconv.Itoa(int(kind)) + "\x00" + strconv.FormatInt(number, 10) + "\x00" + strconv.Itoa(int(targetKind)) + "\x00" + target))
	return hex.EncodeToString(sum[:16])
}
