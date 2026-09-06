package server

import (
	"bytes"
	"crypto/sha256"
	"net/http"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/settingshost"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

func (f *authFixture) settings(t *testing.T, client *http.Client, action string, message proto.Message, csrf string) authReply {
	t.Helper()
	request, err := http.NewRequest("POST", f.origin+SettingsPrefix+action, bytes.NewReader(authWire(t, message)))
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

// Host-wide grants, not workspace-narrowed ones: the document covers the
// machine, so this is the shape the ownership surface already uses.
func settingsScopes() []auth.Scope {
	return []auth.Scope{
		{Permission: settingshost.ScopeRead, ExecutionHostID: authHost},
		{Permission: settingshost.ScopeWrite, ExecutionHostID: authHost},
	}
}

func withSettings(f *authFixture, options *Options) {
	service, err := settingshost.New(settingshost.Options{Store: f.store, HostID: authHost})
	if err != nil {
		panic(err)
	}
	options.Settings = service
}

func settingsDocument(body string) *pb.SettingsDocument {
	sum := sha256.Sum256([]byte(body))
	return &pb.SettingsDocument{
		Scope:         pb.SettingsScope_SETTINGS_SCOPE_GLOBAL,
		Document:      []byte(body),
		Sha256:        sum[:],
		SchemaVersion: 1,
	}
}

// A Host with no settings service authenticates first and then says the surface
// is unavailable. It never answers an empty document, which a device cannot
// tell apart from a machine whose preferences are all at default.
func TestSettingsWithoutAServiceAuthenticatesThenReportsUnsupported(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", settingsScopes())
	expectAuthStatus(t, f.settings(t, client, "Get", &pb.GetSettingsRequest{Meta: hostScope(), Scope: pb.SettingsScope_SETTINGS_SCOPE_GLOBAL}, ""), http.StatusNotImplemented, "UNSUPPORTED")
	expectAuthStatus(t, f.settings(t, client, "Put", &pb.PutSettingsRequest{Meta: hostScope(), OperationId: "save", Document: settingsDocument(`{"theme":"dark"}`)}, session.CsrfToken), http.StatusNotImplemented, "UNSUPPORTED")
	anonymous := f.client(t)
	expectAuthStatus(t, f.settings(t, anonymous, "Get", &pb.GetSettingsRequest{Meta: hostScope()}, ""), http.StatusUnauthorized, "UNAUTHENTICATED")
}

// The grants are checked host-wide, the CSRF header is required on the
// mutation, and a foreign Host is refused rather than reinterpreted as local.
func TestSettingsRequestsAreHostWideAndCsrfProtected(t *testing.T) {
	f := newAuthFixture(t, withSettings)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", settingsScopes())

	foreign := &pb.CommandMeta{RequestId: "request-2", Scope: &pb.Scope{HostId: "33333333333333333333333333333333"}}
	expectAuthStatus(t, f.settings(t, client, "Get", &pb.GetSettingsRequest{Meta: foreign}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	elsewhere := &pb.CommandMeta{RequestId: "request-3", Scope: &pb.Scope{ExecutionHostId: "33333333333333333333333333333333"}}
	expectAuthStatus(t, f.settings(t, client, "Get", &pb.GetSettingsRequest{Meta: elsewhere}, ""), http.StatusForbidden, "PERMISSION_DENIED")

	put := &pb.PutSettingsRequest{Meta: hostScope(), OperationId: "save", Document: settingsDocument(`{"theme":"dark"}`)}
	expectAuthStatus(t, f.settings(t, client, "Put", put, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// With the token it reaches the service and is refused there for the right
	// reason: this Host does not own settings writes yet.
	expectAuthStatus(t, f.settings(t, client, "Put", put, session.CsrfToken), http.StatusConflict, "CONFLICT")

	// A session granted only one workspace's settings has not been granted the
	// machine's document.
	narrow := f.client(t)
	f.pair(t, narrow, "笔记本", []auth.Scope{{Permission: settingshost.ScopeRead, WorkspaceID: "workspace", ExecutionHostID: authHost}})
	expectAuthStatus(t, f.settings(t, narrow, "Get", &pb.GetSettingsRequest{Meta: hostScope()}, ""), http.StatusForbidden, "PERMISSION_DENIED")
}

// A Host that has never stored a document answers NOT_FOUND. An empty document
// would be read as "every preference was cleared".
func TestGetOnAHostThatNeverWroteAnswersNotFound(t *testing.T) {
	f := newAuthFixture(t, withSettings)
	client := f.client(t)
	f.pair(t, client, "手机", settingsScopes())
	expectAuthStatus(t, f.settings(t, client, "Get", &pb.GetSettingsRequest{Meta: hostScope(), Scope: pb.SettingsScope_SETTINGS_SCOPE_GLOBAL}, ""), http.StatusNotFound, "NOT_FOUND")
	// An unspecified scope is a malformed request, not the global document.
	expectAuthStatus(t, f.settings(t, client, "Get", &pb.GetSettingsRequest{Meta: hostScope()}, ""), http.StatusBadRequest, "INVALID_ARGUMENT")
}

// Reads answer once this Host owns the domain, and the revision conflict a
// second writer gets is a CONFLICT rather than a silent overwrite.
func TestSettingsWritesAndConflictsOnceTheHostOwnsTheDomain(t *testing.T) {
	f := newAuthFixture(t, withSettings)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", settingsScopes())
	now := int64(1788560523004)
	if _, err := f.store.PutOwnership(t.Context(), storage.Ownership{
		Domain: storage.OwnershipDomainSettings, Owner: storage.OwnerHost, Phase: storage.OwnershipSettled,
		Epoch: 2, ReasonCode: "ownership.switch.verified", CreatedAtMS: now, UpdatedAtMS: now,
	}, 0); err != nil {
		t.Fatal(err)
	}
	body := `{"theme":"dark","ssh":{"hosts":[{"id":"build-box","name":"Build","host":"build.example","worker":{"path":"/opt/worker"}}]}}`
	reply := f.settings(t, client, "Put", &pb.PutSettingsRequest{Meta: hostScope(), OperationId: "save-1", Document: settingsDocument(body)}, session.CsrfToken)
	if reply.status != http.StatusOK {
		t.Fatalf("the first write answered %d", reply.status)
	}
	stored := new(pb.PutSettingsResponse)
	if err := proto.Unmarshal(reply.body, stored); err != nil {
		t.Fatal(err)
	}
	if stored.Document.Revision != 1 {
		t.Fatalf("the first write landed at revision %d", stored.Document.Revision)
	}
	// A second writer that read the same revision is a conflict.
	expectAuthStatus(t, f.settings(t, client, "Put", &pb.PutSettingsRequest{Meta: hostScope(), OperationId: "save-2", Document: settingsDocument(`{"theme":"light"}`)}, session.CsrfToken), http.StatusConflict, "CONFLICT")
	// A malformed document never reaches storage.
	broken := settingsDocument(`{"theme":"dark"}`)
	broken.Sha256 = make([]byte, 32)
	expectAuthStatus(t, f.settings(t, client, "Put", &pb.PutSettingsRequest{Meta: hostScope(), OperationId: "save-3", ExpectedRevision: 1, Document: broken}, session.CsrfToken), http.StatusBadRequest, "INVALID_ARGUMENT")

	read := f.settings(t, client, "Get", &pb.GetSettingsRequest{Meta: hostScope(), Scope: pb.SettingsScope_SETTINGS_SCOPE_GLOBAL}, "")
	if read.status != http.StatusOK {
		t.Fatalf("the read answered %d", read.status)
	}
	document := new(pb.GetSettingsResponse)
	if err := proto.Unmarshal(read.body, document); err != nil {
		t.Fatal(err)
	}
	if string(document.Document.Document) != body || len(document.ExecutionHosts) != 2 {
		t.Fatalf("the read answered %q with %d hosts", document.Document.Document, len(document.ExecutionHosts))
	}
}

// The capability is advertised only when the surface is actually assembled.
func TestHelloAdvertisesTheSettingsSurfaceOnlyWhenAssembled(t *testing.T) {
	bare := newAuthFixture(t)
	if hasCapability(helloCapabilities(t, bare), "settings.documents.v1") {
		t.Fatal("a Host with no settings service advertised one")
	}
	assembled := newAuthFixture(t, withSettings)
	if !hasCapability(helloCapabilities(t, assembled), "settings.documents.v1") {
		t.Fatal("an assembled settings service was not advertised")
	}
}

// hostScope names this Host and no workspace, which is what a host-wide surface
// takes: the settings document is not a project's.
func hostScope() *pb.CommandMeta {
	return &pb.CommandMeta{RequestId: "request-1"}
}
