package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/githubapi"
	"armadra.local/host/internal/githubcred"
	"armadra.local/host/internal/githubhost"
	auth "armadra.local/host/internal/identity"
	"google.golang.org/protobuf/proto"
)

// The GitHub surface is exercised against a local mock. No test here reaches
// api.github.com, and no real credential is used.

const githubToken = "gho_ServerRouteMockTokenNotReal00"

func (f *authFixture) github(t *testing.T, client *http.Client, action string, message proto.Message, csrf string) authReply {
	t.Helper()
	request, err := http.NewRequest("POST", f.origin+GithubPrefix+action, bytes.NewReader(authWire(t, message)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", f.origin)
	request.Header.Set("Content-Type", MediaType)
	if csrf != "" {
		request.Header.Set("X-Armadra-CSRF", csrf)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data := make([]byte, 0)
	buffer := make([]byte, 4096)
	for {
		n, readErr := response.Body.Read(buffer)
		data = append(data, buffer[:n]...)
		if readErr != nil {
			break
		}
	}
	return authReply{status: response.StatusCode, header: response.Header, body: data, cookies: response.Cookies()}
}

func githubScopes() []auth.Scope {
	return []auth.Scope{
		{Permission: "github:read", WorkspaceID: "workspace", ExecutionHostID: authHost},
		{Permission: "github:write", WorkspaceID: "workspace", ExecutionHostID: authHost},
		{Permission: "settings:write", WorkspaceID: "workspace", ExecutionHostID: authHost},
	}
}

func githubMeta(workspace string) *pb.CommandMeta {
	return &pb.CommandMeta{RequestId: "request-1", Scope: &pb.Scope{HostId: authHost, WorkspaceId: workspace, ExecutionHostId: authHost}}
}

// mockRemote is a minimal GitHub over TLS on loopback: enough for the route
// tests to prove authentication, scoping and the surface's shape.
func mockRemote(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		encode := func(value any) { _ = json.NewEncoder(w).Encode(value) }
		switch {
		case r.URL.Path == "/user":
			encode(map[string]any{"login": "octo-user"})
		case r.URL.Path == "/repos/owner/repo":
			encode(map[string]any{"id": 1, "name": "repo", "default_branch": "main", "allow_squash_merge": true})
		case r.URL.Path == "/repos/owner/repo/issues":
			encode([]any{map[string]any{"number": 7, "title": "上传", "state": "open", "updated_at": "2026-09-05T10:00:00Z"}})
		default:
			w.WriteHeader(http.StatusNotFound)
			encode(map[string]any{"message": "not found"})
		}
	}))
	t.Cleanup(server.Close)
	return server
}

type routeStore struct{ values map[string]string }

func (routeStore) Kind() githubcred.Store { return githubcred.StoreFileFallback }
func (m routeStore) Put(_ context.Context, reference, token string) error {
	m.values[reference] = token
	return nil
}
func (m routeStore) Get(_ context.Context, reference string) (string, error) {
	if value, ok := m.values[reference]; ok {
		return value, nil
	}
	return "", githubcred.ErrUnavailable
}
func (m routeStore) Delete(_ context.Context, reference string) error {
	delete(m.values, reference)
	return nil
}

// githubFixture pairs the authenticated Host with a GitHub service whose
// credential has already been configured against the local mock.
func githubFixture(t *testing.T, configured bool) *authFixture {
	t.Helper()
	remote := mockRemote(t)
	return newAuthFixture(t, func(f *authFixture, options *Options) {
		base, err := githubapi.NormalizeAPIBase(remote.URL)
		if err != nil {
			t.Fatal(err)
		}
		credentials, err := githubcred.New(githubcred.Options{
			Store:          f.store,
			Secrets:        routeStore{values: map[string]string{}},
			DefaultAPIBase: base,
			Now:            time.Now,
			Client:         githubapi.Options{HTTP: remote.Client(), Sleep: func(context.Context, time.Duration) error { return nil }},
		})
		if err != nil {
			t.Fatal(err)
		}
		if configured {
			if _, err = credentials.Configure(context.Background(), pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF, githubToken, base, 0); err != nil {
				t.Fatal(err)
			}
		}
		service, err := githubhost.New(githubhost.Options{Store: f.store, Credentials: credentials, HostID: authHost})
		if err != nil {
			t.Fatal(err)
		}
		options.GitHub = service
	})
}

func TestGithubSurfaceIsAdvertisedOnlyWhenItExists(t *testing.T) {
	without := newAuthFixture(t)
	hello := helloCapabilities(t, without)
	if hasCapability(hello, "github.issues.v1") {
		t.Fatal("a Host with no GitHub service advertised one")
	}
	with := githubFixture(t, true)
	if !hasCapability(helloCapabilities(t, with), "github.issues.v1") {
		t.Fatal("a Host with a GitHub service did not advertise it")
	}
}

func helloCapabilities(t *testing.T, f *authFixture) []string {
	t.Helper()
	client := f.client(t)
	body := authWire(t, &pb.HelloRequest{ClientId: "test", Protocol: &pb.ProtocolVersion{Major: ProtocolMajor, Minor: ProtocolMinor}})
	request, err := http.NewRequest("POST", f.origin+HelloPath, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", f.origin)
	request.Header.Set("Content-Type", MediaType)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data := make([]byte, 0)
	buffer := make([]byte, 4096)
	for {
		n, readErr := response.Body.Read(buffer)
		data = append(data, buffer[:n]...)
		if readErr != nil {
			break
		}
	}
	value := new(pb.HelloResponse)
	if err = proto.Unmarshal(data, value); err != nil {
		t.Fatal(err)
	}
	return value.Capabilities
}

func hasCapability(values []string, name string) bool {
	for _, value := range values {
		if value == name {
			return true
		}
	}
	return false
}

// A Host without the service must authenticate first and then say the surface
// is unavailable. It must never answer an empty Issue list, which would read as
// "this repository has no Issues".
func TestGithubWithoutAServiceAuthenticatesThenReportsUnsupported(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	f.pair(t, client, "手机", githubScopes())
	expectAuthStatus(t, f.github(t, client, "ListIssues", &pb.ListGithubIssuesRequest{Meta: githubMeta("workspace")}, ""), http.StatusNotImplemented, "UNSUPPORTED")
	anonymous := f.client(t)
	expectAuthStatus(t, f.github(t, anonymous, "ListIssues", &pb.ListGithubIssuesRequest{Meta: githubMeta("workspace")}, ""), http.StatusNotImplemented, "UNSUPPORTED")
}

func TestGithubRequestsAreScopedToTheirWorkspaceAndHost(t *testing.T) {
	f := githubFixture(t, true)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", githubScopes())
	repository := &pb.GithubRepositoryRef{Owner: "owner", Name: "repo"}
	// A workspace this device was never granted must not be reachable.
	expectAuthStatus(t, f.github(t, client, "ListIssues", &pb.ListGithubIssuesRequest{Meta: githubMeta("another"), Repository: repository}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// Another Host is refused rather than quietly treated as local.
	foreign := &pb.CommandMeta{RequestId: "r", Scope: &pb.Scope{HostId: "33333333333333333333333333333333", WorkspaceId: "workspace"}}
	expectAuthStatus(t, f.github(t, client, "ListIssues", &pb.ListGithubIssuesRequest{Meta: foreign, Repository: repository}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// An absent scope is invalid, not a host-wide read.
	expectAuthStatus(t, f.github(t, client, "ListIssues", &pb.ListGithubIssuesRequest{Repository: repository}, ""), http.StatusBadRequest, "INVALID_ARGUMENT")
	// Every mutating method requires the rotating CSRF token.
	for _, action := range []struct {
		name    string
		message proto.Message
	}{
		{"CommentIssue", &pb.CommentGithubIssueRequest{Meta: githubMeta("workspace"), Repository: repository, Number: 7, Body: "x"}},
		{"MergePull", &pb.MergeGithubPullRequest{Meta: githubMeta("workspace"), Repository: repository, Number: 9, ExpectedHeadSha: strings.Repeat("a", 40), Method: pb.GithubMergeMethod_GITHUB_MERGE_METHOD_SQUASH}},
		{"ConfigureCredential", &pb.ConfigureGithubCredentialRequest{Meta: githubMeta("workspace"), Source: pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_NONE}},
	} {
		expectAuthStatus(t, f.github(t, client, action.name, action.message, ""), http.StatusForbidden, "PERMISSION_DENIED")
	}
	// With the token, an authorized read succeeds against the mock.
	reply := f.github(t, client, "ListIssues", &pb.ListGithubIssuesRequest{Meta: githubMeta("workspace"), Repository: repository}, session.CsrfToken)
	if reply.status != http.StatusOK {
		t.Fatalf("an authorized listing returned %d", reply.status)
	}
	result := new(pb.ListGithubIssuesResponse)
	if err := proto.Unmarshal(reply.body, result); err != nil {
		t.Fatal(err)
	}
	if len(result.Issues) != 1 || result.Issues[0].Number != 7 {
		t.Fatalf("listing returned %+v", result.Issues)
	}
	if result.PollIntervalMs == 0 {
		t.Fatal("a Host with no webhook must name its own poll interval")
	}
}

// A read-only device must not be able to reconfigure the credential, and a
// device with github:write but no settings authority must not either.
func TestCredentialConfigurationNeedsSettingsAuthority(t *testing.T) {
	f := githubFixture(t, true)
	client := f.client(t)
	session, _ := f.pair(t, client, "受限", []auth.Scope{
		{Permission: "github:read", WorkspaceID: "workspace", ExecutionHostID: authHost},
		{Permission: "github:write", WorkspaceID: "workspace", ExecutionHostID: authHost},
	})
	expectAuthStatus(t, f.github(t, client, "ConfigureCredential",
		&pb.ConfigureGithubCredentialRequest{Meta: githubMeta("workspace"), Source: pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_NONE},
		session.CsrfToken), http.StatusForbidden, "PERMISSION_DENIED")
	// Reading the status is still allowed, because the settings page has to be
	// able to say what is configured.
	reply := f.github(t, client, "GetCredential", &pb.GetGithubCredentialRequest{Meta: githubMeta("workspace")}, "")
	if reply.status != http.StatusOK {
		t.Fatalf("reading the credential status returned %d", reply.status)
	}
	status := new(pb.GithubCredentialStatus)
	if err := proto.Unmarshal(reply.body, status); err != nil {
		t.Fatal(err)
	}
	// The status names the source and the store, and never carries a token.
	if status.Source != pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF {
		t.Fatalf("status was %+v", status)
	}
	if status.Store != pb.GithubSecretStore_GITHUB_SECRET_STORE_FILE_FALLBACK {
		t.Fatal("the degraded file fallback must be reported as such")
	}
	if strings.Contains(status.String(), githubToken) {
		t.Fatal("the credential status carried the token")
	}
}
