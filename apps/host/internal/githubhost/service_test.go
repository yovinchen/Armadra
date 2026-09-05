package githubhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/githubapi"
	"armadra.local/host/internal/githubcred"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

// Every test in this package talks to a local httptest mock. Nothing here ever
// reaches api.github.com, and no real credential is used.

const (
	testHostID   = "0123456789abcdef0123456789abcdef"
	testOwnerID  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testDeviceID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testWorkspce = "workspace"
	mockToken    = "gho_MockTokenNotARealCredential000"
	headSHA      = "9fceb02d0ae598e95dc970b74767f19372d61af8"
)

var testContext = context.Background()

// mockGithub records what the Host actually sent, so a test can assert on the
// write-back rather than only on the reply.
type mockGithub struct {
	server *httptest.Server

	mu       sync.Mutex
	issue    map[string]any
	pull     map[string]any
	patches  []map[string]any
	merges   []map[string]any
	reviews  []map[string]any
	comments []map[string]any
	mergeOK  bool
	rollup   string
}

func newMock(t *testing.T) *mockGithub {
	t.Helper()
	m := &mockGithub{
		mergeOK: true,
		rollup:  "success",
		issue: map[string]any{
			"id": 1, "number": 7, "node_id": "I_issue7", "title": "修复上传", "body": "外部内容",
			"state": "open", "updated_at": "2026-09-05T10:00:00Z", "created_at": "2026-09-05T09:00:00Z",
			"labels": []any{map[string]any{"name": "status/todo"}, map[string]any{"name": "bug"}},
		},
		pull: map[string]any{
			"id": 2, "number": 9, "title": "合并请求", "state": "open", "draft": false,
			"mergeable": true, "mergeable_state": "clean",
			"base":       map[string]any{"ref": "main"},
			"head":       map[string]any{"ref": "feature/x", "sha": headSHA, "repo": map[string]any{"full_name": "owner/repo"}},
			"updated_at": "2026-09-05T10:00:00Z",
		},
	}
	m.server = httptest.NewTLSServer(http.HandlerFunc(m.handle))
	t.Cleanup(m.server.Close)
	return m
}

func (m *mockGithub) body(r *http.Request) map[string]any {
	raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	value := map[string]any{}
	_ = json.Unmarshal(raw, &value)
	return value
}

func (m *mockGithub) handle(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-RateLimit-Limit", "5000")
	w.Header().Set("X-RateLimit-Remaining", "4999")
	encode := func(value any) { _ = json.NewEncoder(w).Encode(value) }
	path := r.URL.Path
	switch {
	case path == "/repos/owner/repo" && r.Method == http.MethodGet:
		encode(map[string]any{
			"id": 5, "full_name": "owner/repo", "name": "repo", "default_branch": "main",
			"allow_merge_commit": false, "allow_squash_merge": true, "allow_rebase_merge": false,
			"permissions": map[string]any{"push": true},
		})
	case path == "/repos/owner/repo/issues" && r.Method == http.MethodGet:
		encode([]any{m.issue, map[string]any{"number": 8, "title": "a pull", "pull_request": map[string]any{"url": "x"}}})
	case path == "/repos/owner/repo/issues/7" && r.Method == http.MethodGet:
		encode(m.issue)
	case path == "/repos/owner/repo/issues/7" && r.Method == http.MethodPatch:
		patch := m.body(r)
		m.patches = append(m.patches, patch)
		for key, value := range patch {
			if key == "labels" {
				names := []any{}
				for _, name := range value.([]any) {
					names = append(names, map[string]any{"name": name})
				}
				m.issue["labels"] = names
				continue
			}
			m.issue[key] = value
		}
		encode(m.issue)
	case path == "/repos/owner/repo/issues/7/comments" && r.Method == http.MethodGet:
		encode([]any{})
	case path == "/repos/owner/repo/issues/7/comments" && r.Method == http.MethodPost:
		m.comments = append(m.comments, m.body(r))
		encode(map[string]any{"id": 11, "body": m.comments[len(m.comments)-1]["body"]})
	case path == "/repos/owner/repo/pulls" && r.Method == http.MethodGet:
		encode([]any{m.pull})
	case path == "/repos/owner/repo/pulls/9" && r.Method == http.MethodGet:
		encode(m.pull)
	case path == "/repos/owner/repo/pulls/9/files":
		encode([]any{map[string]any{"filename": "a.txt", "status": "modified", "additions": 2, "deletions": 1, "patch": "@@"}})
	case path == "/repos/owner/repo/pulls/9/reviews" && r.Method == http.MethodGet:
		encode([]any{})
	case path == "/repos/owner/repo/pulls/9/reviews" && r.Method == http.MethodPost:
		m.reviews = append(m.reviews, m.body(r))
		encode(map[string]any{"id": 21, "state": "APPROVED", "commit_id": headSHA})
	case path == "/repos/owner/repo/pulls/9/comments":
		encode([]any{})
	case path == "/repos/owner/repo/issues/9/comments":
		encode([]any{})
	case path == "/repos/owner/repo/pulls/9/merge" && r.Method == http.MethodPut:
		m.merges = append(m.merges, m.body(r))
		if !m.mergeOK {
			w.WriteHeader(http.StatusConflict)
			encode(map[string]any{"merged": false})
			return
		}
		m.pull["state"] = "closed"
		m.pull["merged"] = true
		m.pull["merged_at"] = "2026-09-05T11:00:00Z"
		encode(map[string]any{"merged": true, "sha": "1111111111111111111111111111111111111111"})
	case strings.HasPrefix(path, "/repos/owner/repo/commits/") && strings.HasSuffix(path, "/check-runs"):
		encode(map[string]any{"check_runs": []any{map[string]any{"name": "build", "status": "completed", "conclusion": m.rollup}}})
	case strings.HasPrefix(path, "/repos/owner/repo/commits/") && strings.HasSuffix(path, "/status"):
		encode(map[string]any{"statuses": []any{}})
	case strings.HasPrefix(path, "/repos/owner/repo/git/ref/heads/"):
		encode(map[string]any{"object": map[string]any{"sha": headSHA}})
	case path == "/user":
		w.Header().Set("X-OAuth-Scopes", "repo")
		encode(map[string]any{"login": "octo-user"})
	default:
		w.WriteHeader(http.StatusNotFound)
		encode(map[string]any{"message": "not found"})
	}
}

type memoryStore struct{ values map[string]string }

func (memoryStore) Kind() githubcred.Store { return githubcred.StoreOSKeychain }
func (m memoryStore) Put(_ context.Context, reference, token string) error {
	m.values[reference] = token
	return nil
}
func (m memoryStore) Get(_ context.Context, reference string) (string, error) {
	if value, ok := m.values[reference]; ok {
		return value, nil
	}
	return "", githubcred.ErrUnavailable
}
func (m memoryStore) Delete(_ context.Context, reference string) error {
	delete(m.values, reference)
	return nil
}

func newService(t *testing.T, mock *mockGithub) (*Service, *storage.Store) {
	t.Helper()
	store, err := storage.Open(t.TempDir(), testHostID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	base, err := githubapi.NormalizeAPIBase(mock.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	secrets := memoryStore{values: map[string]string{}}
	credentials, err := githubcred.New(githubcred.Options{
		Store:          store,
		Secrets:        secrets,
		DefaultAPIBase: base,
		Now:            time.Now,
		Client:         githubapi.Options{HTTP: mock.server.Client(), Sleep: func(context.Context, time.Duration) error { return nil }},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = credentials.Configure(testContext, pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF, mockToken, base, 0); err != nil {
		t.Fatal(err)
	}
	service, err := New(Options{Store: store, Credentials: credentials, HostID: testHostID, Now: time.Now})
	if err != nil {
		t.Fatal(err)
	}
	return service, store
}

func caller(scopes ...string) Caller {
	granted := make([]auth.Scope, 0, len(scopes))
	for _, permission := range scopes {
		granted = append(granted, auth.Scope{Permission: permission, WorkspaceID: testWorkspce, ExecutionHostID: testHostID})
	}
	return Caller{PrincipalID: testOwnerID, DeviceID: testDeviceID, DeviceEpoch: 1, WorkspaceID: testWorkspce, Scopes: granted}
}

func repository(t *testing.T, service *Service) *pb.GithubRepositoryRef {
	t.Helper()
	client, err := service.client(testContext)
	if err != nil {
		t.Fatal(err)
	}
	return &pb.GithubRepositoryRef{Owner: "owner", Name: "repo", ApiBase: client.APIBase(), Host: githubapi.WebHostFor(client.APIBase())}
}

func TestReadScopeCannotWriteAndWriteScopeCannotBeAssumed(t *testing.T) {
	service, _ := newService(t, newMock(t))
	ref := repository(t, service)
	reader := caller(ScopeRead)
	if _, err := service.CommentIssue(testContext, reader, &pb.CommentGithubIssueRequest{Repository: ref, Number: 7, Body: "x"}); !errors.Is(err, ErrPermission) {
		t.Fatalf("a read-only device commented: %v", err)
	}
	if _, err := service.MergePull(testContext, reader, &pb.MergeGithubPullRequest{Repository: ref, Number: 9, ExpectedHeadSha: headSHA, Method: pb.GithubMergeMethod_GITHUB_MERGE_METHOD_SQUASH}); !errors.Is(err, ErrPermission) {
		t.Fatalf("a read-only device merged: %v", err)
	}
	// A grant for another workspace never authorizes this one.
	elsewhere := Caller{PrincipalID: testOwnerID, DeviceID: testDeviceID, DeviceEpoch: 1, WorkspaceID: testWorkspce,
		Scopes: []auth.Scope{{Permission: ScopeRead, WorkspaceID: "other", ExecutionHostID: testHostID}}}
	if _, err := service.ListIssues(testContext, elsewhere, &pb.ListGithubIssuesRequest{Repository: ref}); !errors.Is(err, ErrPermission) {
		t.Fatalf("a foreign workspace grant was accepted: %v", err)
	}
}

// A remote on another service must be reported, not looked up. Sending an
// enterprise repository's name to the public service is the failure this
// prevents.
func TestForeignRemotesAreReportedWithoutARequest(t *testing.T) {
	mock := newMock(t)
	service, _ := newService(t, mock)
	result, err := service.ResolveRepository(testContext, caller(ScopeRead), "https://github.com/owner/repo.git")
	if err != nil {
		t.Fatal(err)
	}
	if !result.HostMismatch || result.Repository != nil {
		t.Fatalf("a foreign remote resolved to %+v", result)
	}
	if result.ReasonCode != "REMOTE_HOST_NOT_CONFIGURED" {
		t.Fatalf("reason was %q", result.ReasonCode)
	}
	// The mock's own host resolves normally, and reports exactly the merge
	// strategies the repository allows.
	local := "https://" + strings.TrimPrefix(mock.server.URL, "https://") + "/owner/repo.git"
	ok, err := service.ResolveRepository(testContext, caller(ScopeRead), local)
	if err != nil {
		t.Fatal(err)
	}
	if ok.HostMismatch || ok.Repository == nil {
		t.Fatalf("the configured host did not resolve: %+v", ok)
	}
	if len(ok.Repository.AllowedMergeMethods) != 1 || ok.Repository.AllowedMergeMethods[0] != pb.GithubMergeMethod_GITHUB_MERGE_METHOD_SQUASH {
		t.Fatalf("merge methods were %v", ok.Repository.AllowedMergeMethods)
	}
}

func storeMapping(t *testing.T, service *Service, ref *pb.GithubRepositoryRef) *pb.GithubStatusMapping {
	t.Helper()
	mapping, err := service.PutStatusMapping(testContext, caller(ScopeRead, ScopeWrite), &pb.GithubStatusMapping{
		Repository: ref,
		Source:     pb.GithubStatusSource_GITHUB_STATUS_SOURCE_LABEL,
		Groups: []*pb.GithubStatusGroup{
			{Id: "todo", Title: "待办", Label: "status/todo"},
			{Id: "done", Title: "完成", Label: "status/done"},
		},
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	return mapping
}

// A label move must leave every label this mapping does not manage exactly as
// it was, and must not close the Issue unless a coupling was configured.
func TestMovingByLabelKeepsUnmanagedLabelsAndDoesNotClose(t *testing.T) {
	mock := newMock(t)
	service, _ := newService(t, mock)
	ref := repository(t, service)
	mapping := storeMapping(t, service, ref)
	listed, err := service.ListIssues(testContext, caller(ScopeRead), &pb.ListGithubIssuesRequest{Repository: ref})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Issues) != 1 || listed.Issues[0].StatusGroupId != "todo" {
		t.Fatalf("listing produced %+v", listed.Issues)
	}
	if listed.PollIntervalMs != PollIntervalMS {
		t.Fatal("a Host with no webhook must name its own poll interval")
	}
	result, err := service.MoveIssue(testContext, caller(ScopeRead, ScopeWrite), &pb.MoveGithubIssueRequest{
		Repository: ref, Number: 7, ToGroupId: "done", FromGroupId: "todo",
		ExpectedUpdatedAtUnixMs: listed.Issues[0].UpdatedAtUnixMs,
		ExpectedMappingRevision: mapping.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Outcomes) != 1 || result.Outcomes[0].State != pb.GithubWriteState_GITHUB_WRITE_STATE_APPLIED {
		t.Fatalf("outcomes were %+v", result.Outcomes)
	}
	mock.mu.Lock()
	patches := append([]map[string]any(nil), mock.patches...)
	mock.mu.Unlock()
	if len(patches) != 1 {
		t.Fatalf("the move sent %d writes", len(patches))
	}
	labels, ok := patches[0]["labels"].([]any)
	if !ok {
		t.Fatalf("the write was %+v", patches[0])
	}
	names := map[string]bool{}
	for _, value := range labels {
		names[value.(string)] = true
	}
	if !names["bug"] {
		t.Fatal("an unmanaged label was dropped by a status move")
	}
	if !names["status/done"] || names["status/todo"] {
		t.Fatalf("the managed labels were %v", names)
	}
	// Closing the Issue and moving it to Done are separate actions unless a
	// coupling was explicitly configured, and none was here.
	if _, closed := patches[0]["state"]; closed {
		t.Fatal("a move closed the Issue without a configured coupling")
	}
	if result.Issue.StatusGroupId != "done" {
		t.Fatalf("the issue reported group %q", result.Issue.StatusGroupId)
	}
}

// A move against a stale view must stop, not overwrite whatever is there now.
func TestAStaleMoveIsRefusedWithoutWriting(t *testing.T) {
	mock := newMock(t)
	service, _ := newService(t, mock)
	ref := repository(t, service)
	mapping := storeMapping(t, service, ref)
	result, err := service.MoveIssue(testContext, caller(ScopeRead, ScopeWrite), &pb.MoveGithubIssueRequest{
		Repository: ref, Number: 7, ToGroupId: "done",
		ExpectedUpdatedAtUnixMs: 1, ExpectedMappingRevision: mapping.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Outcomes) != 1 || result.Outcomes[0].State != pb.GithubWriteState_GITHUB_WRITE_STATE_CONFLICTED {
		t.Fatalf("a stale move reported %+v", result.Outcomes)
	}
	mock.mu.Lock()
	writes := len(mock.patches)
	mock.mu.Unlock()
	if writes != 0 {
		t.Fatal("a stale move wrote to the remote")
	}
	// A mapping edited underneath the panel stops the move rather than being
	// silently reinterpreted.
	if _, err = service.MoveIssue(testContext, caller(ScopeRead, ScopeWrite), &pb.MoveGithubIssueRequest{
		Repository: ref, Number: 7, ToGroupId: "done",
		ExpectedUpdatedAtUnixMs: 1, ExpectedMappingRevision: mapping.Revision + 1,
	}); !errors.Is(err, storage.ErrConflict) {
		t.Fatalf("a stale mapping revision reported %v", err)
	}
}

// The merge is bound to the head and the rollup the reader saw.
func TestMergeIsRefusedWhenTheHeadOrTheChecksMoved(t *testing.T) {
	mock := newMock(t)
	service, _ := newService(t, mock)
	ref := repository(t, service)
	writer := caller(ScopeRead, ScopeWrite)
	stale, err := service.MergePull(testContext, writer, &pb.MergeGithubPullRequest{
		Repository: ref, Number: 9, ExpectedHeadSha: "0000000000000000000000000000000000000000",
		Method: pb.GithubMergeMethod_GITHUB_MERGE_METHOD_SQUASH,
	})
	if err != nil {
		t.Fatal(err)
	}
	if stale.Merged || stale.ReasonCode != "HEAD_MOVED" {
		t.Fatalf("a moved head produced %+v", stale)
	}
	// A method the repository does not allow is refused before anything is sent.
	blocked, err := service.MergePull(testContext, writer, &pb.MergeGithubPullRequest{
		Repository: ref, Number: 9, ExpectedHeadSha: headSHA,
		Method: pb.GithubMergeMethod_GITHUB_MERGE_METHOD_MERGE,
	})
	if err != nil {
		t.Fatal(err)
	}
	if blocked.Merged || blocked.ReasonCode != "METHOD_NOT_ALLOWED" {
		t.Fatalf("a disallowed method produced %+v", blocked)
	}
	// Checks that changed since the panel displayed them stop the merge.
	mock.mu.Lock()
	mock.rollup = "failure"
	mock.mu.Unlock()
	changed, err := service.MergePull(testContext, writer, &pb.MergeGithubPullRequest{
		Repository: ref, Number: 9, ExpectedHeadSha: headSHA,
		Method:              pb.GithubMergeMethod_GITHUB_MERGE_METHOD_SQUASH,
		ExpectedCheckRollup: pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_SUCCESS,
	})
	if err != nil {
		t.Fatal(err)
	}
	if changed.Merged || changed.ReasonCode != "CHECKS_CHANGED" {
		t.Fatalf("changed checks produced %+v", changed)
	}
	mock.mu.Lock()
	attempts := len(mock.merges)
	mock.mu.Unlock()
	if attempts != 0 {
		t.Fatalf("a refused merge still sent %d requests", attempts)
	}
}

func TestMergeSendsTheExactHeadTheCallerNamed(t *testing.T) {
	mock := newMock(t)
	service, _ := newService(t, mock)
	ref := repository(t, service)
	result, err := service.MergePull(testContext, caller(ScopeRead, ScopeWrite), &pb.MergeGithubPullRequest{
		Repository: ref, Number: 9, ExpectedHeadSha: headSHA,
		Method:              pb.GithubMergeMethod_GITHUB_MERGE_METHOD_SQUASH,
		ExpectedCheckRollup: pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_SUCCESS,
		CommitTitle:         "feat: 合并",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Merged || result.MergeSha == "" {
		t.Fatalf("merge produced %+v", result)
	}
	mock.mu.Lock()
	merges := append([]map[string]any(nil), mock.merges...)
	mock.mu.Unlock()
	if len(merges) != 1 || merges[0]["sha"] != headSHA || merges[0]["merge_method"] != "squash" {
		t.Fatalf("the merge request was %+v", merges)
	}
}

// A detail response's checks must describe the head it reports, never another
// commit sitting next to a merge button.
func TestPullDetailChecksDescribeTheReportedHead(t *testing.T) {
	mock := newMock(t)
	service, _ := newService(t, mock)
	ref := repository(t, service)
	result, err := service.GetPull(testContext, caller(ScopeRead), &pb.GetGithubPullRequest{Repository: ref, Number: 9})
	if err != nil {
		t.Fatal(err)
	}
	if result.Checks == nil || result.Checks.HeadSha != result.Pull.HeadSha {
		t.Fatalf("checks described %+v", result.Checks)
	}
	if len(result.Files) != 1 || result.Files[0].Path != "a.txt" {
		t.Fatalf("file summary was %+v", result.Files)
	}
	if result.Pull.State != pb.GithubPullState_GITHUB_PULL_STATE_OPEN {
		t.Fatalf("pull state was %v", result.Pull.State)
	}
}

// A review that requests changes with no body is refused by the remote; saying
// so here keeps the panel from reporting a review it never submitted.
func TestReviewRequiresABodyWhenRequestingChanges(t *testing.T) {
	mock := newMock(t)
	service, _ := newService(t, mock)
	ref := repository(t, service)
	writer := caller(ScopeRead, ScopeWrite)
	if _, err := service.SubmitReview(testContext, writer, &pb.SubmitGithubReviewRequest{
		Repository: ref, Number: 9, CommitSha: headSHA,
		State: pb.GithubReviewState_GITHUB_REVIEW_STATE_CHANGES_REQUESTED,
	}); !errors.Is(err, ErrInvalid) {
		t.Fatal("an empty request-changes review was accepted")
	}
	review, err := service.SubmitReview(testContext, writer, &pb.SubmitGithubReviewRequest{
		Repository: ref, Number: 9, CommitSha: headSHA,
		State: pb.GithubReviewState_GITHUB_REVIEW_STATE_APPROVED, Body: "看起来不错",
		Comments: []*pb.GithubReviewCommentDraft{{Path: "a.txt", Line: 3, Side: "RIGHT", Body: "这里"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if review.Id == 0 {
		t.Fatal("the review carried no identifier")
	}
	mock.mu.Lock()
	sent := append([]map[string]any(nil), mock.reviews...)
	mock.mu.Unlock()
	// The commit the reviewer read must travel with the review, so an inline
	// comment is anchored where it was written.
	if len(sent) != 1 || sent[0]["commit_id"] != headSHA || sent[0]["event"] != "APPROVE" {
		t.Fatalf("the review request was %+v", sent)
	}
}

// A reference is derived from what the link means, so linking twice is one
// badge rather than two.
func TestReferencesAreIdempotentAndScopedToTheirWorkspace(t *testing.T) {
	service, _ := newService(t, newMock(t))
	ref := repository(t, service)
	writer := caller(ScopeRead, ScopeWrite)
	reference := &pb.GithubExternalReference{
		Repository: ref, Kind: pb.GithubReferenceKind_GITHUB_REFERENCE_KIND_ISSUE, Number: 7,
		TargetKind: pb.GithubReferenceTargetKind_GITHUB_REFERENCE_TARGET_KIND_SESSION, TargetId: "node-1", Title: "修复上传",
	}
	first, err := service.LinkReference(testContext, writer, &pb.LinkGithubReferenceRequest{Reference: reference})
	if err != nil {
		t.Fatal(err)
	}
	if first.WorkspaceId != testWorkspce || first.Revision != 1 {
		t.Fatalf("reference was %+v", first)
	}
	if _, err = service.LinkReference(testContext, writer, &pb.LinkGithubReferenceRequest{Reference: reference}); !errors.Is(err, storage.ErrConflict) {
		t.Fatalf("a duplicate link reported %v", err)
	}
	listed, err := service.ListReferences(testContext, caller(ScopeRead), &pb.ListGithubReferencesRequest{TargetId: "node-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.References) != 1 {
		t.Fatalf("listing returned %d references", len(listed.References))
	}
	other, err := service.ListReferences(testContext, caller(ScopeRead), &pb.ListGithubReferencesRequest{TargetId: "node-2"})
	if err != nil || len(other.References) != 0 {
		t.Fatalf("another target saw %d references (%v)", len(other.References), err)
	}
	if _, err = service.UnlinkReference(testContext, writer, &pb.UnlinkGithubReferenceRequest{ReferenceId: first.ReferenceId, ExpectedRevision: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err = service.UnlinkReference(testContext, writer, &pb.UnlinkGithubReferenceRequest{ReferenceId: first.ReferenceId, ExpectedRevision: 1}); !errors.Is(err, storage.ErrConflict) {
		t.Fatalf("unlinking twice reported %v", err)
	}
}

// A Host with no credential must say so, not answer an empty Issue list that
// reads as "this repository has no Issues".
func TestNoCredentialIsUnsupportedRatherThanEmpty(t *testing.T) {
	store, err := storage.Open(t.TempDir(), testHostID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	credentials, err := githubcred.New(githubcred.Options{Store: store, Secrets: memoryStore{values: map[string]string{}}})
	if err != nil {
		t.Fatal(err)
	}
	service, err := New(Options{Store: store, Credentials: credentials, HostID: testHostID})
	if err != nil {
		t.Fatal(err)
	}
	ref := &pb.GithubRepositoryRef{Owner: "owner", Name: "repo"}
	if _, err = service.ListIssues(testContext, caller(ScopeRead), &pb.ListGithubIssuesRequest{Repository: ref}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("an unconfigured Host reported %v", err)
	}
	if _, err = service.ListPulls(testContext, caller(ScopeRead), &pb.ListGithubPullsRequest{Repository: ref}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("an unconfigured Host reported %v", err)
	}
	// The credential status still answers, because "not configured" is exactly
	// what the settings page needs to show.
	status, err := service.GetCredential(testContext, caller(ScopeRead))
	if err != nil || status.Available || status.ReasonCode != "NOT_CONFIGURED" {
		t.Fatalf("status was %+v (%v)", status, err)
	}
}
