package githubcred

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/githubapi"
	"armadra.local/host/internal/storage"
)

const testHostID = "0123456789abcdef0123456789abcdef"

// memoryStore stands in for the OS secret store so no test touches a real
// keychain. It records what was written so a test can prove the token never
// reaches anywhere else.
type memoryStore struct {
	kind   Store
	values map[string]string
	fail   bool
}

func (m *memoryStore) Kind() Store { return m.kind }
func (m *memoryStore) Put(_ context.Context, reference, token string) error {
	if m.fail {
		return ErrUnavailable
	}
	if !ValidToken(token) {
		return ErrInvalid
	}
	m.values[reference] = token
	return nil
}
func (m *memoryStore) Get(_ context.Context, reference string) (string, error) {
	if value, ok := m.values[reference]; ok {
		return value, nil
	}
	return "", ErrUnavailable
}
func (m *memoryStore) Delete(_ context.Context, reference string) error {
	delete(m.values, reference)
	return nil
}

type fixture struct {
	service *Service
	secrets *memoryStore
	store   *storage.Store
	server  *httptest.Server
	calls   atomic.Int64
	login   atomic.Value
	status  atomic.Int64
}

// newFixture wires the credential service to a local mock. `viewer` is what the
// mock answers for /user; nothing here contacts api.github.com.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{secrets: &memoryStore{kind: StoreOSKeychain, values: map[string]string{}}}
	f.login.Store("octo-user")
	f.status.Store(int64(http.StatusOK))
	f.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		if status := int(f.status.Load()); status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		if r.Header.Get("Authorization") == "" || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-OAuth-Scopes", "repo, read:org")
		_, _ = w.Write([]byte(`{"login":"` + f.login.Load().(string) + `"}`))
	}))
	t.Cleanup(f.server.Close)
	var err error
	f.store, err = storage.Open(t.TempDir(), testHostID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.store.Close() })
	f.service, err = New(Options{
		Store:   f.store,
		Secrets: f.secrets,
		Gh: GhCLI{
			Lookup: func(string) (string, error) { return "/usr/bin/gh", nil },
			Run: func(context.Context, string, ...string) ([]byte, error) {
				return []byte("gho_GhCliTokenNotReal000000000000000"), nil
			},
		},
		Now:    time.Now,
		Client: githubapi.Options{HTTP: f.server.Client(), Sleep: func(context.Context, time.Duration) error { return nil }},
	})
	if err != nil {
		t.Fatal(err)
	}
	// The mock speaks TLS on a loopback address, so it is a legitimate HTTPS
	// API base and no rule has to be relaxed for the test to reach it.
	base, err := githubapi.NormalizeAPIBase(f.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	f.service.defaultBase = base
	return f
}

// configure leaves the API base empty so the fixture's default — the local
// mock — is used, exactly as an operator-supplied base would be.
func (f *fixture) configure(t *testing.T, source pb.GithubCredentialSource, token string, revision uint64) (*pb.GithubCredentialStatus, error) {
	t.Helper()
	return f.service.Configure(context.Background(), source, token, "", revision)
}

func TestConfiguringATokenVerifiesItBeforeStoringAnything(t *testing.T) {
	f := newFixture(t)
	status, err := f.configure(t, pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF, sampleToken, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Available || status.AccountLogin != "octo-user" || status.Revision != 1 {
		t.Fatalf("status was %+v", status)
	}
	if status.Store != pb.GithubSecretStore_GITHUB_SECRET_STORE_OS_KEYCHAIN {
		t.Fatal("the secret store must be reported so a degraded fallback is visible")
	}
	if len(status.TokenScopes) != 2 {
		t.Fatalf("scopes were %v", status.TokenScopes)
	}
	// The token itself lives only in the secret store; the database holds a
	// reference and a login, never the value.
	record, err := f.store.GithubConfig(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if record.SecretRef == "" || strings.Contains(record.SecretRef, sampleToken) {
		t.Fatalf("stored reference was %q", record.SecretRef)
	}
	for _, field := range []string{record.Source, record.APIBase, record.SecretRef, record.AccountLogin, record.SecretStore} {
		if strings.Contains(field, sampleToken) {
			t.Fatal("the token reached the database")
		}
	}
	if f.secrets.values[record.SecretRef] != sampleToken {
		t.Fatal("the token was not written to the secret store")
	}
}

// A credential the remote rejects must not be stored: a status claiming an
// account the Host never reached would be a lie the settings page repeats.
func TestARejectedTokenIsNotStored(t *testing.T) {
	f := newFixture(t)
	f.status.Store(int64(http.StatusUnauthorized))
	if _, err := f.configure(t, pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF, sampleToken, 0); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("a rejected token reported %v", err)
	}
	if len(f.secrets.values) != 0 {
		t.Fatal("a rejected token was left in the secret store")
	}
	if _, err := f.store.GithubConfig(context.Background()); !errors.Is(err, storage.ErrNotFound) {
		t.Fatal("a rejected credential was recorded")
	}
	status, err := f.service.Status(context.Background())
	if err != nil || status.Available || status.ReasonCode != "NOT_CONFIGURED" {
		t.Fatalf("status after a rejection was %+v (%v)", status, err)
	}
}

// Revoking must drop the stored secret and every in-memory copy at once.
func TestRevokingClearsTheStoredAndCachedCredential(t *testing.T) {
	f := newFixture(t)
	status, err := f.configure(t, pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF, sampleToken, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Client(context.Background()); err != nil {
		t.Fatal(err)
	}
	revoked, err := f.service.Revoke(context.Background(), status.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if revoked.Available || revoked.Source != pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_NONE {
		t.Fatalf("revoked status was %+v", revoked)
	}
	if len(f.secrets.values) != 0 {
		t.Fatal("the secret survived revocation")
	}
	if _, err = f.service.Client(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("a client was still built after revocation: %v", err)
	}
	// A stale revision must not be able to revoke or reconfigure.
	if _, err = f.service.Revoke(context.Background(), status.Revision); !errors.Is(err, storage.ErrConflict) {
		t.Fatalf("a stale revocation reported %v", err)
	}
}

// The gh source keeps nothing at rest. Configuring it must not create a secret.
func TestGhSourceStoresNoSecret(t *testing.T) {
	f := newFixture(t)
	status, err := f.configure(t, pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_GH_CLI, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Available || status.Store != pb.GithubSecretStore_GITHUB_SECRET_STORE_NONE {
		t.Fatalf("gh status was %+v", status)
	}
	if len(f.secrets.values) != 0 {
		t.Fatal("the gh source wrote a secret")
	}
	// Sending a token for a source that stores none would silently discard it.
	if _, err = f.configure(t, pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_GH_CLI, sampleToken, status.Revision); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a token for the gh source reported %v", err)
	}
}

// A configuration written against a stale revision must be refused, so two
// settings pages cannot silently overwrite one another.
func TestConfigurationRequiresTheRevisionTheCallerRead(t *testing.T) {
	f := newFixture(t)
	if _, err := f.configure(t, pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF, sampleToken, 1); !errors.Is(err, storage.ErrConflict) {
		t.Fatalf("a first configuration at revision 1 reported %v", err)
	}
	first, err := f.configure(t, pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF, sampleToken, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.configure(t, pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF, sampleToken, 0); !errors.Is(err, storage.ErrConflict) {
		t.Fatal("a second configuration at revision 0 was accepted")
	}
	if _, err = f.configure(t, pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF, "gho_SecondValueNotReal00000000000", first.Revision); err != nil {
		t.Fatal(err)
	}
}

// An enterprise base must be kept exactly and reported as enterprise, so a
// repository on it is never resolved against the public service. No request is
// made here: the stored configuration is written directly, because reaching
// ghe.example.com is precisely what a test must not do.
func TestEnterpriseBaseIsKeptAndReported(t *testing.T) {
	f := newFixture(t)
	enterprise := "https://ghe.example.com/api/v3"
	normalized, err := githubapi.NormalizeAPIBase(enterprise + "/")
	if err != nil || normalized != enterprise {
		t.Fatalf("enterprise base normalized to %q (%v)", normalized, err)
	}
	reference, err := Reference(githubapi.APIHost(normalized))
	if err != nil {
		t.Fatal(err)
	}
	if err = f.secrets.Put(context.Background(), reference, sampleToken); err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.PutGithubConfig(context.Background(), storage.GithubConfig{
		Source: storage.GithubSourceTokenRef, APIBase: normalized,
		SecretStore: storage.GithubStoreOSKeychain, SecretRef: reference,
		AccountLogin: "octo-user", CreatedAtMS: 1, UpdatedAtMS: 1,
	}, 0); err != nil {
		t.Fatal(err)
	}
	status, err := f.service.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.ApiBase != enterprise || !status.Enterprise || !status.Available {
		t.Fatalf("enterprise status was %+v", status)
	}
	// The client the service builds must be bound to that base, not the public
	// one, so nothing can silently fall back.
	client, err := f.service.Client(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if client.APIBase() != enterprise || !client.Enterprise() {
		t.Fatalf("client base was %q", client.APIBase())
	}
	if f.calls.Load() != 0 {
		t.Fatal("a request was sent while only reading configuration")
	}
}

// A rejected request must invalidate the cached token, so the next call asks
// the source again instead of replaying something the remote refused.
func TestATokenRejectionDropsTheCachedCopy(t *testing.T) {
	f := newFixture(t)
	if _, err := f.configure(t, pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF, sampleToken, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Status(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.service.NoteFailure(githubapi.CodeUnauthenticated)
	f.service.mu.Lock()
	cached := f.service.token
	f.service.mu.Unlock()
	if cached != "" {
		t.Fatal("a rejected token stayed in memory")
	}
	status, err := f.service.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// The credential can still be produced, but the status says the remote
	// stopped honouring it rather than only that it exists.
	if !status.Available || status.ReasonCode != "TOKEN_REJECTED" {
		t.Fatalf("status after a rejection was %+v", status)
	}
}
