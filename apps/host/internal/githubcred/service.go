package githubcred

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/githubapi"
	"armadra.local/host/internal/storage"
)

// Service owns the single GitHub credential selection for this Host and the
// API client built from it.
//
// A token is produced per request and held only in memory, with a short cache
// so a page of Issues does not re-enter the keychain a dozen times. Revoking
// clears that cache immediately: an in-memory copy must not outlive the
// decision to stop using it.
type Service struct {
	store   *storage.Store
	secrets SecretStore
	gh      GhCLI
	now     func() time.Time
	// options lets a deployment point the client at another API base, and lets
	// tests point it at a local mock, without this package knowing which.
	options githubapi.Options
	// defaultBase is where a first configuration lands when the request names
	// no API base. It is an operator setting, never a client's choice.
	defaultBase string

	mu       sync.Mutex
	token    string
	tokenAt  int64
	client   *githubapi.Client
	base     string
	scopes   []string
	checked  int64
	failure  string
	revision uint64
}

// tokenTTL keeps a keychain prompt or a gh invocation off every request without
// letting a revoked credential survive meaningfully longer than the decision.
const tokenTTL = 60 * time.Second

type Options struct {
	Store   *storage.Store
	Secrets SecretStore
	Gh      GhCLI
	Now     func() time.Time
	// Client is the transport the API client uses. Tests supply one pointed at
	// a local mock; production leaves it nil.
	Client githubapi.Options
	// DefaultAPIBase is the operator's API base for a first configuration.
	// Empty means the public service.
	DefaultAPIBase string
}

func New(options Options) (*Service, error) {
	if options.Store == nil || options.Secrets == nil {
		return nil, ErrInvalid
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	base, err := githubapi.NormalizeAPIBase(options.DefaultAPIBase)
	if err != nil {
		return nil, ErrInvalid
	}
	return &Service{store: options.Store, secrets: options.Secrets, gh: options.Gh, now: now, options: options.Client, defaultBase: base}, nil
}

func sourceOf(value string) pb.GithubCredentialSource {
	switch value {
	case storage.GithubSourceGhCLI:
		return pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_GH_CLI
	case storage.GithubSourceTokenRef:
		return pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF
	}
	return pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_NONE
}

func storeOf(value string) pb.GithubSecretStore {
	switch value {
	case storage.GithubStoreOSKeychain:
		return pb.GithubSecretStore_GITHUB_SECRET_STORE_OS_KEYCHAIN
	case storage.GithubStoreFileFallback:
		return pb.GithubSecretStore_GITHUB_SECRET_STORE_FILE_FALLBACK
	}
	return pb.GithubSecretStore_GITHUB_SECRET_STORE_NONE
}

func sourceName(value pb.GithubCredentialSource) (string, error) {
	switch value {
	case pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_NONE:
		return storage.GithubSourceNone, nil
	case pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_GH_CLI:
		return storage.GithubSourceGhCLI, nil
	case pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF:
		return storage.GithubSourceTokenRef, nil
	}
	return "", ErrInvalid
}

func (s *Service) config(ctx context.Context) (storage.GithubConfig, error) {
	record, err := s.store.GithubConfig(ctx)
	if errors.Is(err, storage.ErrNotFound) {
		return storage.GithubConfig{Source: storage.GithubSourceNone, APIBase: s.defaultBase, SecretStore: storage.GithubStoreNone}, nil
	}
	return record, err
}

// Status describes the configured credential without spending remote quota. It
// reports whether a token can be produced right now, which is not the same as
// "a source is configured": a revoked gh login is configured and unusable.
func (s *Service) Status(ctx context.Context) (*pb.GithubCredentialStatus, error) {
	record, err := s.config(ctx)
	if err != nil {
		return nil, err
	}
	status := &pb.GithubCredentialStatus{
		Source:     sourceOf(record.Source),
		Store:      storeOf(record.SecretStore),
		ApiBase:    record.APIBase,
		Enterprise: record.APIBase != githubapi.PublicAPIBase,
		Revision:   record.Revision,
	}
	if record.Source == storage.GithubSourceNone {
		status.ReasonCode = "NOT_CONFIGURED"
		return status, nil
	}
	s.mu.Lock()
	status.AccountLogin = record.AccountLogin
	status.TokenScopes = append([]string(nil), s.scopes...)
	status.CheckedAtUnixMs = s.checked
	failure := s.failure
	s.mu.Unlock()
	if _, err = s.tokenFor(ctx, record); err != nil {
		status.ReasonCode = reasonFor(err)
		return status, nil
	}
	status.Available = true
	if failure != "" {
		// A token exists but the last request it was used for was rejected.
		// Saying only "available" would hide a token the remote no longer honours.
		status.ReasonCode = failure
	}
	return status, nil
}

func reasonFor(err error) string {
	switch {
	case errors.Is(err, ErrUnsupported):
		return "SOURCE_UNAVAILABLE"
	case errors.Is(err, ErrInvalid):
		return "CONFIGURATION_INVALID"
	default:
		return "TOKEN_UNAVAILABLE"
	}
}

func (s *Service) tokenFor(ctx context.Context, record storage.GithubConfig) (string, error) {
	now := s.now().UnixMilli()
	s.mu.Lock()
	if s.token != "" && s.base == record.APIBase && s.revision == record.Revision && now-s.tokenAt < int64(tokenTTL/time.Millisecond) {
		token := s.token
		s.mu.Unlock()
		return token, nil
	}
	s.mu.Unlock()
	var token string
	var err error
	switch record.Source {
	case storage.GithubSourceGhCLI:
		token, err = s.gh.Token(ctx, githubapi.WebHostFor(record.APIBase))
	case storage.GithubSourceTokenRef:
		token, err = s.secrets.Get(ctx, record.SecretRef)
	default:
		return "", ErrUnavailable
	}
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.token, s.tokenAt, s.base, s.revision = token, now, record.APIBase, record.Revision
	s.mu.Unlock()
	return token, nil
}

// forget drops every in-memory copy of the credential and the client built from
// it. Called whenever the configuration changes or is revoked.
func (s *Service) forget() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.token, s.tokenAt, s.client, s.base, s.revision = "", 0, nil, "", 0
	s.scopes, s.checked, s.failure = nil, 0, ""
}

// Client builds (or reuses) the API client for the configured base. It refuses
// rather than returning a client with no credential, so no caller can send an
// anonymous request that silently reads only public data.
func (s *Service) Client(ctx context.Context) (*githubapi.Client, error) {
	record, err := s.config(ctx)
	if err != nil {
		return nil, err
	}
	if record.Source == storage.GithubSourceNone {
		return nil, ErrUnavailable
	}
	s.mu.Lock()
	if s.client != nil && s.base == record.APIBase && s.revision == record.Revision {
		client := s.client
		s.mu.Unlock()
		return client, nil
	}
	s.mu.Unlock()
	options := s.options
	options.APIBase = record.APIBase
	options.Token = func(ctx context.Context) (string, error) {
		current, err := s.config(ctx)
		if err != nil {
			return "", err
		}
		if current.Source == storage.GithubSourceNone {
			return "", ErrUnavailable
		}
		return s.tokenFor(ctx, current)
	}
	client, err := githubapi.New(options)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.client, s.base, s.revision = client, record.APIBase, record.Revision
	s.mu.Unlock()
	return client, nil
}

// Configure records the source and API base, verifies the credential once, and
// only then stores it. Verifying first means a status never claims an account
// the Host has not actually reached.
func (s *Service) Configure(ctx context.Context, source pb.GithubCredentialSource, token, apiBase string, expectedRevision uint64) (*pb.GithubCredentialStatus, error) {
	name, err := sourceName(source)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(apiBase) == "" {
		apiBase = s.defaultBase
	}
	base, err := githubapi.NormalizeAPIBase(apiBase)
	if err != nil {
		return nil, ErrInvalid
	}
	token = strings.TrimSpace(token)
	if name != storage.GithubSourceTokenRef && token != "" {
		// A token sent for a source that does not store one would be silently
		// discarded; refusing says so instead.
		return nil, ErrInvalid
	}
	if name == storage.GithubSourceTokenRef && !ValidToken(token) {
		return nil, ErrInvalid
	}
	now := s.now().UnixMilli()
	previous, err := s.config(ctx)
	if err != nil {
		return nil, err
	}
	if previous.Revision != expectedRevision {
		return nil, storage.ErrConflict
	}
	record := storage.GithubConfig{Source: name, APIBase: base, SecretStore: storage.GithubStoreNone, CreatedAtMS: now, UpdatedAtMS: now}
	if name == storage.GithubSourceNone {
		return s.commit(ctx, record, previous, expectedRevision, "")
	}
	reference := ""
	if name == storage.GithubSourceTokenRef {
		if reference, err = Reference(githubapi.APIHost(base)); err != nil {
			return nil, err
		}
		if err = s.secrets.Put(ctx, reference, token); err != nil {
			return nil, err
		}
		record.SecretRef = reference
		record.SecretStore = string(s.secrets.Kind())
	}
	// Verification uses a client bound to the value being configured, not to
	// whatever is currently stored.
	login, scopes, err := s.verify(ctx, base, func(context.Context) (string, error) {
		if name == storage.GithubSourceGhCLI {
			return s.gh.Token(ctx, githubapi.WebHostFor(base))
		}
		return token, nil
	})
	if err != nil {
		if reference != "" {
			_ = s.secrets.Delete(ctx, reference)
		}
		return nil, err
	}
	record.AccountLogin = login
	status, err := s.commit(ctx, record, previous, expectedRevision, reference)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.scopes, s.checked = scopes, now
	s.mu.Unlock()
	status.TokenScopes = scopes
	status.CheckedAtUnixMs = now
	return status, nil
}

func (s *Service) commit(ctx context.Context, record, previous storage.GithubConfig, expectedRevision uint64, reference string) (*pb.GithubCredentialStatus, error) {
	stored, err := s.store.PutGithubConfig(ctx, record, expectedRevision)
	if err != nil {
		if reference != "" {
			_ = s.secrets.Delete(ctx, reference)
		}
		return nil, err
	}
	// A replaced token reference is only removed after the new one is durable,
	// so a failed write never leaves the Host with no credential at all.
	if previous.SecretRef != "" && previous.SecretRef != stored.SecretRef {
		_ = s.secrets.Delete(ctx, previous.SecretRef)
	}
	s.forget()
	return &pb.GithubCredentialStatus{
		Source:       sourceOf(stored.Source),
		Store:        storeOf(stored.SecretStore),
		Available:    stored.Source != storage.GithubSourceNone,
		ApiBase:      stored.APIBase,
		Enterprise:   stored.APIBase != githubapi.PublicAPIBase,
		AccountLogin: stored.AccountLogin,
		Revision:     stored.Revision,
		ReasonCode:   map[bool]string{true: "NOT_CONFIGURED", false: ""}[stored.Source == storage.GithubSourceNone],
	}, nil
}

// Revoke removes the stored secret and returns the Host to "not configured".
// It never touches the user's gh login: this Host stops using it, and that is
// a different thing from logging them out.
func (s *Service) Revoke(ctx context.Context, expectedRevision uint64) (*pb.GithubCredentialStatus, error) {
	previous, err := s.config(ctx)
	if err != nil {
		return nil, err
	}
	if previous.Revision != expectedRevision || expectedRevision == 0 {
		return nil, storage.ErrConflict
	}
	now := s.now().UnixMilli()
	record := storage.GithubConfig{Source: storage.GithubSourceNone, APIBase: previous.APIBase, SecretStore: storage.GithubStoreNone, CreatedAtMS: now, UpdatedAtMS: now}
	return s.commit(ctx, record, previous, expectedRevision, "")
}

// verify proves the credential reaches an account before it is stored.
func (s *Service) verify(ctx context.Context, base string, token githubapi.TokenSource) (string, []string, error) {
	options := s.options
	options.APIBase = base
	options.Token = token
	client, err := githubapi.New(options)
	if err != nil {
		return "", nil, ErrInvalid
	}
	login, scopes, err := client.Viewer(ctx)
	if err != nil {
		return "", nil, ErrUnavailable
	}
	if login == "" {
		return "", nil, ErrUnavailable
	}
	return login, scopes, nil
}

// NoteFailure records that a request using the current credential was refused,
// so the next status can say the token stopped working instead of only that it
// exists.
func (s *Service) NoteFailure(code githubapi.Code) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch code {
	case githubapi.CodeUnauthenticated:
		s.failure = "TOKEN_REJECTED"
		// A rejected token must not be replayed from the cache.
		s.token, s.tokenAt = "", 0
	case githubapi.CodePermission:
		s.failure = "INSUFFICIENT_SCOPES"
	case "":
		s.failure = ""
	}
}
