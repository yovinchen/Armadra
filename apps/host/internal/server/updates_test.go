package server

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
	"armadra.local/host/internal/updates"
	"google.golang.org/protobuf/proto"
)

// updatesFixture is newAuthFixture with a release source attached, so the same
// authenticated transport can be exercised both with and without one.
func updatesFixture(t *testing.T, service *updates.Service) *authFixture {
	t.Helper()
	f := &authFixture{}
	f.clock.Store(time.Now().UnixMilli())
	var err error
	f.store, err = storage.Open(t.TempDir(), authHost)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.store.Close() })
	f.identity, err = auth.New(f.store, auth.Config{InstanceID: authInstance, Clock: func() time.Time { return time.UnixMilli(f.clock.Load()) }})
	if err != nil {
		t.Fatal(err)
	}
	f.server = httptest.NewUnstartedServer(nil)
	f.origin = "https://" + f.server.Listener.Addr().String()
	f.handler, err = NewHandlerWithOptions(Identity{HostID: authHost, InstanceID: authInstance}, Options{Identity: f.identity, PublicOrigin: f.origin, Updates: service})
	if err != nil {
		f.server.Close()
		t.Fatal(err)
	}
	f.server.Config.Handler = f.handler
	f.server.StartTLS()
	t.Cleanup(f.server.Close)
	return f
}

func (f *authFixture) updates(t *testing.T, client *http.Client, action string, message proto.Message, csrf string) authReply {
	t.Helper()
	request, err := http.NewRequest("POST", f.origin+UpdatesPrefix+action, bytes.NewReader(authWire(t, message)))
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
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return authReply{status: response.StatusCode, header: response.Header, body: data, cookies: response.Cookies()}
}

func updatesScopes() []auth.Scope {
	return []auth.Scope{{Permission: ScopeUpdatesRead}}
}

func checkRequest() *pb.CheckForUpdateRequest {
	return &pb.CheckForUpdateRequest{
		Meta:             &pb.CommandMeta{RequestId: "request-1", Scope: &pb.Scope{HostId: authHost}},
		Channel:          pb.ReleaseChannel_RELEASE_CHANNEL_STABLE,
		InstalledVersion: &pb.SemanticVersion{Major: 0, Minor: 1, Patch: 0},
		Target:           "darwin-aarch64",
	}
}

func decodeCheck(t *testing.T, reply authReply) *pb.CheckForUpdateResponse {
	t.Helper()
	expectAuthStatus(t, reply, http.StatusOK, "")
	response := new(pb.CheckForUpdateResponse)
	if err := proto.Unmarshal(reply.body, response); err != nil {
		t.Fatal(err)
	}
	return response
}

// releaseSource serves one release index for the Host under test. No test in
// this package ever contacts a real release host.
func releaseSource(t *testing.T, body string) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/releases") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server.URL + "/repos/armadra/armadra"
}

const testReleaseIndex = `[{"tag_name":"v0.2.0","draft":false,"prerelease":false,` +
	`"published_at":"2026-09-01T10:00:00Z","html_url":"https://releases.invalid/v0.2.0",` +
	"\"body\":\"```armadra-compatibility\\n{\\\"minimumInstalled\\\":\\\"0.1.0\\\",\\\"protocolMajor\\\":1,\\\"minimumProtocolMinor\\\":1}\\n```\"," +
	`"assets":[{"name":"Armadra_0.2.0_darwin-aarch64.tar.gz","browser_download_url":"https://releases.invalid/a.tar.gz","size":2048},` +
	`{"name":"Armadra_0.2.0_darwin-aarch64.tar.gz.sig","browser_download_url":"https://releases.invalid/a.tar.gz.sig","size":96}]}]`

// A Host with no release source authenticates the caller and then reports
// UNSUPPORTED in the contract's own state. It must never answer UP_TO_DATE:
// a client cannot tell "nothing newer" from "nobody looked" otherwise.
func TestUpdateCheckWithoutASourceAuthenticatesThenReportsUnsupported(t *testing.T) {
	f := updatesFixture(t, nil)
	client := f.client(t)
	f.pair(t, client, "手机", updatesScopes())
	response := decodeCheck(t, f.updates(t, client, "CheckForUpdate", checkRequest(), ""))
	if response.GetState() != pb.UpdateCheckState_UPDATE_CHECK_STATE_UNSUPPORTED {
		t.Fatalf("an unconfigured Host answered %v", response.GetState())
	}
	if response.GetReasonCode() != updates.ReasonNotConfigured || response.GetRelease() != nil {
		t.Fatalf("unconfigured answer was not honest: %q", response.GetReasonCode())
	}
	anonymous := f.client(t)
	expectAuthStatus(t, f.updates(t, anonymous, "CheckForUpdate", checkRequest(), ""), http.StatusUnauthorized, "UNAUTHENTICATED")
}

// The read is host-wide, so a device that was granted everything else still
// cannot ask; and a device holding the grant gets the real answer.
func TestUpdateCheckRequiresItsOwnHostWideGrant(t *testing.T) {
	service, err := updates.New(updates.Options{Source: releaseSource(t, testReleaseIndex), ProtocolMajor: ProtocolMajor, ProtocolMinor: ProtocolMinor})
	if err != nil {
		t.Fatal(err)
	}
	f := updatesFixture(t, service)
	unrelated := f.client(t)
	f.pair(t, unrelated, "只读设备", []auth.Scope{{Permission: "automation:read", WorkspaceID: "workspace", ExecutionHostID: authHost}})
	expectAuthStatus(t, f.updates(t, unrelated, "CheckForUpdate", checkRequest(), ""), http.StatusForbidden, "PERMISSION_DENIED")

	// A workspace-constrained grant does not authorize a host-wide read.
	constrained := f.client(t)
	f.pair(t, constrained, "工作区设备", []auth.Scope{{Permission: ScopeUpdatesRead, WorkspaceID: "workspace"}})
	expectAuthStatus(t, f.updates(t, constrained, "CheckForUpdate", checkRequest(), ""), http.StatusForbidden, "PERMISSION_DENIED")

	client := f.client(t)
	f.pair(t, client, "桌面", updatesScopes())
	response := decodeCheck(t, f.updates(t, client, "CheckForUpdate", checkRequest(), ""))
	if response.GetState() != pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE {
		t.Fatalf("a newer compatible release was not offered: %v %q", response.GetState(), response.GetReasonCode())
	}
	artifacts := response.GetRelease().GetArtifacts()
	if len(artifacts) != 1 || artifacts[0].GetSignature().GetState() != pb.UpdateSignatureState_UPDATE_SIGNATURE_STATE_PRESENT {
		t.Fatalf("the offer did not describe one signed artifact: %v", artifacts)
	}
	if response.GetChannel() != pb.ReleaseChannel_RELEASE_CHANNEL_STABLE {
		t.Fatal("the response did not name the channel it consulted")
	}
}

// A scope naming another Host is refused rather than reinterpreted as local,
// and a request this Host cannot act on is INVALID_ARGUMENT, not a state.
func TestUpdateRequestsAreScopedAndValidated(t *testing.T) {
	f := updatesFixture(t, nil)
	client := f.client(t)
	f.pair(t, client, "桌面", updatesScopes())
	foreign := checkRequest()
	foreign.Meta = &pb.CommandMeta{RequestId: "request-2", Scope: &pb.Scope{HostId: "33333333333333333333333333333333"}}
	expectAuthStatus(t, f.updates(t, client, "CheckForUpdate", foreign, ""), http.StatusForbidden, "PERMISSION_DENIED")
	elsewhere := checkRequest()
	elsewhere.Meta = &pb.CommandMeta{RequestId: "request-3", Scope: &pb.Scope{ExecutionHostId: "33333333333333333333333333333333"}}
	expectAuthStatus(t, f.updates(t, client, "CheckForUpdate", elsewhere, ""), http.StatusForbidden, "PERMISSION_DENIED")
	for _, broken := range []*pb.CheckForUpdateRequest{
		{Meta: checkRequest().Meta, Target: "darwin-aarch64"},
		{Meta: checkRequest().Meta, InstalledVersion: &pb.SemanticVersion{Minor: 1}, Target: "plan9-amd64"},
		{Meta: checkRequest().Meta, InstalledVersion: &pb.SemanticVersion{Minor: 1}, Target: "darwin"},
	} {
		expectAuthStatus(t, f.updates(t, client, "CheckForUpdate", broken, ""), http.StatusBadRequest, "INVALID_ARGUMENT")
	}
}

// Downloading and applying change this machine, so both require the rotating
// CSRF token — and both then answer UNSUPPORTED rather than a fake success.
func TestDownloadAndApplyRefuseWithoutCsrfAndReportUnsupported(t *testing.T) {
	f := updatesFixture(t, nil)
	client := f.client(t)
	session, _ := f.pair(t, client, "桌面", updatesScopes())
	meta := &pb.CommandMeta{RequestId: "request-4", Scope: &pb.Scope{HostId: authHost}}
	version := &pb.SemanticVersion{Major: 0, Minor: 2}
	download := &pb.DownloadUpdateRequest{Meta: meta, Version: version, Target: "darwin-aarch64"}
	apply := &pb.ApplyUpdateRequest{Meta: meta, Version: version, ExpectedSha256: make([]byte, 32)}
	expectAuthStatus(t, f.updates(t, client, "DownloadUpdate", download, ""), http.StatusForbidden, "PERMISSION_DENIED")
	expectAuthStatus(t, f.updates(t, client, "ApplyUpdate", apply, ""), http.StatusForbidden, "PERMISSION_DENIED")

	reply := f.updates(t, client, "DownloadUpdate", download, session.CsrfToken)
	expectAuthStatus(t, reply, http.StatusOK, "")
	transfer := new(pb.DownloadUpdateResponse)
	if err := proto.Unmarshal(reply.body, transfer); err != nil {
		t.Fatal(err)
	}
	if transfer.GetState() != pb.UpdateTransferState_UPDATE_TRANSFER_STATE_UNSUPPORTED || transfer.GetReceivedBytes() != 0 {
		t.Fatalf("download reported progress it never made: %v", transfer)
	}
	reply = f.updates(t, client, "ApplyUpdate", apply, session.CsrfToken)
	expectAuthStatus(t, reply, http.StatusOK, "")
	staged := new(pb.ApplyUpdateResponse)
	if err := proto.Unmarshal(reply.body, staged); err != nil {
		t.Fatal(err)
	}
	if staged.GetState() != pb.UpdateApplyState_UPDATE_APPLY_STATE_UNSUPPORTED || staged.GetReasonCode() == "" {
		t.Fatalf("apply reported something other than unsupported: %v", staged)
	}
}

// A method this build never defined stays NOT_FOUND: answering UNSUPPORTED for
// a name that is not in the contract would invent one.
func TestUnknownUpdateMethodIsNotRouted(t *testing.T) {
	f := updatesFixture(t, nil)
	client := f.client(t)
	f.pair(t, client, "桌面", updatesScopes())
	expectAuthStatus(t, f.updates(t, client, "InstallUpdate", checkRequest(), ""), http.StatusNotFound, "NOT_FOUND")
	if updatesMethod("/rpc/armadra.v1.IdentityService/Pair") || updatesMethod(UpdatesPrefix+"Unknown") || !updatesMethod(UpdatesPrefix+"CheckForUpdate") {
		t.Fatal("update routing accepted the wrong paths")
	}
}
