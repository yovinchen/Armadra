package githubapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
)

// Every test here talks to a local httptest server. Nothing in this package's
// suite ever reaches api.github.com.

var testContext = context.Background()

func testClient(t *testing.T, handler http.Handler) (*Client, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := New(Options{
		APIBase: server.URL,
		Token:   func(context.Context) (string, error) { return "test-token-not-real", nil },
		HTTP:    server.Client(),
		Now:     time.Now,
		Sleep:   func(context.Context, time.Duration) error { return nil },
	})
	if err != nil {
		// The mock is http, which NormalizeAPIBase rightly refuses, so the test
		// builds the client directly against the parsed mock URL instead.
		parsed, parseErr := url.Parse(server.URL)
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		client = &Client{
			base:     parsed,
			token:    func(context.Context) (string, error) { return "test-token-not-real", nil },
			http:     server.Client(),
			now:      time.Now,
			sleep:    func(context.Context, time.Duration) error { return nil },
			agent:    "armadra-host-test",
			attempts: 3,
			cache:    map[string]*cacheEntry{},
		}
		client.http.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	return client, server
}

// A poll loop has to stay inside the quota, so a matching ETag must replay the
// stored body rather than counting as a fresh read.
func TestConditionalRequestsReplayTheStoredBody(t *testing.T) {
	var requests atomic.Int64
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("ETag", `W/"abc"`)
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "4999")
		if r.Header.Get("If-None-Match") == `W/"abc"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"number":1,"title":"first"}]`))
	}))
	first, err := client.Get(testContext, "/repos/o/r/issues", nil)
	if err != nil || first.FromCache || len(first.Body) == 0 {
		t.Fatalf("first read: %v %+v", err, first)
	}
	second, err := client.Get(testContext, "/repos/o/r/issues", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !second.FromCache || string(second.Body) != string(first.Body) {
		t.Fatal("a 304 must replay the stored body and say it came from cache")
	}
	if second.Rate.Limit != 5000 {
		t.Fatal("rate limit headers must survive a 304")
	}
	if requests.Load() != 2 {
		t.Fatalf("expected two requests, got %d", requests.Load())
	}
}

// A write that reached the remote must never be sent twice: a duplicate comment
// or a second merge is worse than reporting an unknown outcome.
func TestWritesAreNeverRetriedAndReportAnUnknownOutcome(t *testing.T) {
	var attempts atomic.Int64
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	_, err := client.Write(testContext, http.MethodPost, "/repos/o/r/issues", map[string]any{"title": "x"})
	if CodeOf(err) != CodeUnknownOutcome {
		t.Fatalf("a 500 on a write must be an unknown outcome, got %v", err)
	}
	if attempts.Load() != 1 {
		t.Fatalf("the write was attempted %d times", attempts.Load())
	}
	// A read, which has no side effect, is allowed to retry.
	attempts.Store(0)
	if _, err = client.Get(testContext, "/repos/o/r/issues", nil); CodeOf(err) != CodeUnavailable {
		t.Fatalf("a failing read reported %v", err)
	}
	if attempts.Load() != 3 {
		t.Fatalf("the read was attempted %d times", attempts.Load())
	}
}

// GitHub answers 403 both for "you may not" and for its secondary rate limit.
// Merging them would tell a user to fix a permission when they should wait.
func TestSecondaryRateLimitIsDistinguishedFromPermission(t *testing.T) {
	limited, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusForbidden)
	}))
	if _, err := limited.Get(testContext, "/repos/o/r/issues", nil); CodeOf(err) != CodeRateLimited {
		t.Fatalf("a throttled 403 reported %v", err)
	}
	forbidden, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "4000")
		w.WriteHeader(http.StatusForbidden)
	}))
	if _, err := forbidden.Get(testContext, "/repos/o/r/issues", nil); CodeOf(err) != CodePermission {
		t.Fatalf("an unthrottled 403 reported %v", err)
	}
}

// A redirect would let the remote move a request, and its bearer token, to
// another authority.
func TestRedirectsAreRefusedRatherThanFollowed(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://evil.example.com/repos/o/r", http.StatusFound)
	}))
	if _, err := client.Get(testContext, "/repos/o/r", nil); CodeOf(err) != CodeInvalid {
		t.Fatalf("a redirect reported %v", err)
	}
}

// A path is a path. Nothing a caller passes may re-target the request.
func TestRequestPathsCannotLeaveTheConfiguredBase(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	for _, path := range []string{"repos/o/r", "//evil.example.com/x", "/repos/o/r?x=1", "/repos/o/r#f", "/repos/o/\x00r"} {
		if _, err := client.Get(testContext, path, nil); CodeOf(err) != CodeInvalid {
			t.Fatalf("path %q was accepted", path)
		}
	}
}

// A caller cannot address a repository through a client built for another base.
func TestRepositoryReferencesMustMatchTheClientBase(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	elsewhere := &pb.GithubRepositoryRef{Owner: "o", Name: "r", ApiBase: "https://ghe.example.com/api/v3"}
	if _, _, err := client.Repository(testContext, elsewhere, 1); CodeOf(err) != CodeInvalid {
		t.Fatalf("a foreign API base was accepted: %v", err)
	}
	bad := &pb.GithubRepositoryRef{Owner: "../..", Name: "r"}
	if _, _, err := client.Repository(testContext, bad, 1); CodeOf(err) != CodeInvalid {
		t.Fatalf("an invalid owner was accepted: %v", err)
	}
}

// The Issues endpoint returns pull requests too. Showing them in an Issues list
// would put a Close button on something where closing means another thing.
func TestPullRequestsAreFilteredOutOfIssueListings(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
          {"number":1,"title":"issue","state":"open","updated_at":"2026-09-05T10:00:00Z"},
          {"number":2,"title":"pull","state":"open","pull_request":{"url":"x"}}
        ]`))
	}))
	ref := &pb.GithubRepositoryRef{Owner: "o", Name: "r"}
	issues, _, err := client.Issues(testContext, ref, nil, 1, 50, 42)
	if err != nil {
		t.Fatal(err)
	}
	if len(issues) != 1 || issues[0].Number != 1 {
		t.Fatalf("listing returned %d entries", len(issues))
	}
	if issues[0].ObservedAtUnixMs != 42 {
		t.Fatal("an issue must carry when it was actually observed")
	}
	if issues[0].UpdatedAtUnixMs == 0 {
		t.Fatal("updated_at must survive; it is the read-before-write token")
	}
}

// Checks come from two independent surfaces. Reporting only one would show an
// empty, falsely reassuring result for a repository that uses the other.
func TestChecksCombineCheckRunsAndCommitStatuses(t *testing.T) {
	sha := "9fceb02d0ae598e95dc970b74767f19372d61af8"
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/repos/o/r/commits/"+sha+"/check-runs":
			_, _ = w.Write([]byte(`{"check_runs":[
              {"name":"build","status":"completed","conclusion":"success","app":{"name":"GitHub Actions","slug":"github-actions"},"details_url":"https://example.com/actions/runs/77/job/1"},
              {"name":"slow","status":"in_progress","app":{"name":"Other","slug":"other"}}
            ]}`))
		case r.URL.Path == "/repos/o/r/commits/"+sha+"/status":
			_, _ = w.Write([]byte(`{"statuses":[{"context":"legacy","state":"failure"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	ref := &pb.GithubRepositoryRef{Owner: "o", Name: "r"}
	summary, err := client.Checks(testContext, ref, sha, 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(summary.Runs) != 3 || summary.HeadSha != sha {
		t.Fatalf("summary has %d runs for %s", len(summary.Runs), summary.HeadSha)
	}
	// A failure outranks everything, including a run still in progress.
	if summary.Rollup != pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_FAILURE {
		t.Fatalf("rollup was %v", summary.Rollup)
	}
	// Only a workflow run can actually be restarted; nothing else may claim it.
	if !summary.Runs[0].Rerunnable || summary.Runs[0].WorkflowRunId != 77 {
		t.Fatal("an Actions run must expose its workflow run")
	}
	if summary.Runs[1].Rerunnable || summary.Runs[2].Rerunnable {
		t.Fatal("a check with no rerun endpoint must not be offered one")
	}
	if summary.Runs[1].Conclusion != pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_PENDING {
		t.Fatal("an unfinished run is pending, never a pass")
	}
}

// A short SHA would let a merge name something other than exactly the head the
// reader saw.
func TestMergeRequiresAFullObjectName(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"merged":true,"sha":"1111111111111111111111111111111111111111"}`))
	}))
	ref := &pb.GithubRepositoryRef{Owner: "o", Name: "r"}
	if _, err := client.Merge(testContext, ref, 1, "9fceb02", "squash", "", ""); CodeOf(err) != CodeInvalid {
		t.Fatal("a short SHA was accepted for a merge")
	}
	sha, err := client.Merge(testContext, ref, 1, "9fceb02d0ae598e95dc970b74767f19372d61af8", "squash", "", "")
	if err != nil || sha != "1111111111111111111111111111111111111111" {
		t.Fatalf("merge returned %q (%v)", sha, err)
	}
}

// A merge the remote reports as not merged is a refusal, not a success.
func TestMergeRefusalIsNeverReportedAsSuccess(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"merged":false,"message":"not mergeable"}`))
	}))
	ref := &pb.GithubRepositoryRef{Owner: "o", Name: "r"}
	_, err := client.Merge(testContext, ref, 1, "9fceb02d0ae598e95dc970b74767f19372d61af8", "squash", "", "")
	if CodeOf(err) != CodeConflict {
		t.Fatalf("an unmerged response reported %v", err)
	}
}

// A rejected token has one repair, and it is not "wait" or "reload".
func TestTokenRejectionIsItsOwnCode(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	var problem *Error
	_, err := client.Get(testContext, "/user", nil)
	if !errors.As(err, &problem) || problem.Code != CodeUnauthenticated || problem.Reason != "TOKEN_REJECTED" {
		t.Fatalf("a 401 reported %v", err)
	}
}

// The Host must never send an anonymous request that silently reads only what
// is public.
func TestAnEmptyTokenIsRefusedBeforeTheRequestLeaves(t *testing.T) {
	var requests atomic.Int64
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
	client.token = func(context.Context) (string, error) { return "", nil }
	if _, err := client.Get(testContext, "/user", nil); CodeOf(err) != CodeUnauthenticated {
		t.Fatal("an empty token was not refused")
	}
	if requests.Load() != 0 {
		t.Fatal("a request left the process without a credential")
	}
}

// The Host holds the token for the length of a call, and asks again next time,
// so revoking a credential stops working immediately.
func TestEveryRequestAsksTheTokenSourceAgain(t *testing.T) {
	var asked atomic.Int64
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	client.token = func(context.Context) (string, error) {
		return "token-" + strconv.FormatInt(asked.Add(1), 10), nil
	}
	for range 3 {
		if _, err := client.Get(testContext, "/user", nil); err != nil {
			t.Fatal(err)
		}
	}
	if asked.Load() != 3 {
		t.Fatalf("the token source was consulted %d times", asked.Load())
	}
}
