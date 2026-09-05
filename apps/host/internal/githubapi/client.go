// Package githubapi is the Host's only path to a GitHub REST or GraphQL
// endpoint. It owns conditional requests, pagination, rate-limit handling and
// backoff so no caller has to reimplement them, and so a write is never
// silently retried: a request whose result was not read reports an unknown
// outcome rather than being sent again.
//
// The API base is supplied per client and never inferred. A client built for a
// GitHub Enterprise base cannot be redirected at the public service, because
// every request path is resolved against that base and redirects are refused.
package githubapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Code is the Host-level meaning of a remote refusal. It is deliberately not
// the HTTP status: the caller decides whether to re-authenticate, wait, reload
// a revision or tell the user, and those are different repairs.
type Code string

const (
	CodeInvalid         Code = "INVALID_ARGUMENT"
	CodeUnauthenticated Code = "UNAUTHENTICATED"
	CodePermission      Code = "PERMISSION_DENIED"
	CodeNotFound        Code = "NOT_FOUND"
	CodeConflict        Code = "CONFLICT"
	CodeRateLimited     Code = "RESOURCE_EXHAUSTED"
	CodeUnavailable     Code = "UNAVAILABLE"
	// The request left this process and its result was never read. Never
	// downgraded to a failure, because a retry could duplicate a comment,
	// a review or a merge.
	CodeUnknownOutcome Code = "UNKNOWN_OUTCOME"
	CodeUnsupported    Code = "UNSUPPORTED"
)

// Error carries a stable machine reason. Remote prose is never propagated: it
// is attacker-influenced text on an external service.
type Error struct {
	Code   Code
	Status int
	Reason string
}

func (e *Error) Error() string {
	return fmt.Sprintf("github %s (status %d, %s)", e.Code, e.Status, e.Reason)
}

func fail(code Code, status int, reason string) error {
	return &Error{Code: code, Status: status, Reason: reason}
}

// CodeOf reports the Host-level meaning of an error, or "" when it did not come
// from this package.
func CodeOf(err error) Code {
	var problem *Error
	if errors.As(err, &problem) {
		return problem.Code
	}
	return ""
}

// RateLimit is what the remote actually reported, so a panel can say why a
// refresh is being held back instead of looking broken.
type RateLimit struct {
	Limit, Remaining int64
	ResetsAtMS       int64
	RetryAfterMS     int64
	Throttled        bool
}

// TokenSource produces a bearer token for one request. It is called per
// request so a revoked credential stops working immediately, and so the Host
// never holds a token longer than a call.
type TokenSource func(context.Context) (string, error)

const (
	// GitHub's own maximum for the endpoints used here.
	MaxPerPage = 100
	// A single response the Host will hold. Large enough for 100 issues with
	// long bodies, small enough that a hostile endpoint cannot exhaust memory.
	MaxResponseBytes = 8 << 20
	maxCacheEntries  = 256
	maxCacheBytes    = 32 << 20
	// A read is retried a bounded number of times; a write never is.
	defaultAttempts = 3
	PublicAPIBase   = "https://api.github.com"
	acceptREST      = "application/vnd.github+json"
	apiVersion      = "2022-11-28"
)

type Options struct {
	APIBase   string
	Token     TokenSource
	HTTP      *http.Client
	Now       func() time.Time
	Sleep     func(context.Context, time.Duration) error
	UserAgent string
	Attempts  int
}

type cacheEntry struct {
	etag, link string
	body       []byte
	usedAt     int64
}

// Client is safe for concurrent use. Its conditional-request cache is bounded
// in both entries and bytes; a full cache evicts the least recently used entry
// rather than growing.
type Client struct {
	base      *url.URL
	token     TokenSource
	http      *http.Client
	now       func() time.Time
	sleep     func(context.Context, time.Duration) error
	agent     string
	attempts  int
	mu        sync.Mutex
	cache     map[string]*cacheEntry
	cacheSize int
	clock     int64
	// Set while the remote has told us to wait. Requests before this instant
	// are refused locally instead of adding to a secondary rate limit.
	deferUntilMS int64
	lastRate     RateLimit
}

func New(options Options) (*Client, error) {
	base, err := NormalizeAPIBase(options.APIBase)
	if err != nil {
		return nil, err
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return nil, fail(CodeInvalid, 0, "API_BASE_INVALID")
	}
	if options.Token == nil {
		return nil, fail(CodeInvalid, 0, "TOKEN_SOURCE_REQUIRED")
	}
	client := &Client{
		base:     parsed,
		token:    options.Token,
		http:     options.HTTP,
		now:      options.Now,
		sleep:    options.Sleep,
		agent:    options.UserAgent,
		attempts: options.Attempts,
		cache:    map[string]*cacheEntry{},
	}
	if client.http == nil {
		client.http = &http.Client{Timeout: 30 * time.Second}
	}
	// Following a redirect would let the remote move a request with its bearer
	// token to another authority, so every redirect is an error instead.
	client.http.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	if client.now == nil {
		client.now = time.Now
	}
	if client.sleep == nil {
		client.sleep = func(ctx context.Context, d time.Duration) error {
			timer := time.NewTimer(d)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return nil
			}
		}
	}
	if client.agent == "" {
		client.agent = "armadra-host"
	}
	if client.attempts <= 0 {
		client.attempts = defaultAttempts
	}
	return client, nil
}

func (c *Client) APIBase() string { return c.base.String() }

// Enterprise reports whether this client talks to something other than the
// public service, so an enterprise repository is never resolved elsewhere.
func (c *Client) Enterprise() bool { return c.base.String() != PublicAPIBase }

// LastRateLimit is what the most recent response reported. It is advisory
// display data, never an authorization decision.
func (c *Client) LastRateLimit() RateLimit {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastRate
}

// Response is one completed request. Body is the decoded bytes, either fresh or
// replayed from the conditional-request cache after a 304.
type Response struct {
	Status   int
	Body     []byte
	NextPage int
	Rate     RateLimit
	// Scopes the remote says this token carries, from X-OAuth-Scopes. Empty
	// when the endpoint does not report them; that is not the same as none.
	OAuthScopes []string
	FromCache   bool
}

// Get performs a cacheable read. A matching ETag replays the stored body, which
// is how a poll loop stays inside the quota.
func (c *Client) Get(ctx context.Context, path string, query url.Values) (Response, error) {
	return c.do(ctx, http.MethodGet, path, query, nil, true)
}

// Write performs a mutation. It is never retried: the caller learns that the
// outcome is unknown and re-reads, rather than risking a duplicate.
func (c *Client) Write(ctx context.Context, method, path string, body any) (Response, error) {
	switch method {
	case http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete:
	default:
		return Response{}, fail(CodeInvalid, 0, "METHOD_NOT_ALLOWED")
	}
	return c.do(ctx, method, path, nil, body, false)
}

// GraphQL posts one query. Projects v2 has no REST surface, so the status field
// of a project item can only be written this way.
func (c *Client) GraphQL(ctx context.Context, query string, variables map[string]any) (json.RawMessage, error) {
	payload := map[string]any{"query": query}
	if len(variables) > 0 {
		payload["variables"] = variables
	}
	response, err := c.do(ctx, http.MethodPost, "/graphql", nil, payload, false)
	if err != nil {
		return nil, err
	}
	var envelope struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Type string `json:"type"`
		} `json:"errors"`
	}
	if err = json.Unmarshal(response.Body, &envelope); err != nil {
		return nil, fail(CodeInvalid, response.Status, "GRAPHQL_MALFORMED")
	}
	// GraphQL answers 200 with an errors array; treating that as success would
	// report a field write that never happened.
	if len(envelope.Errors) > 0 {
		reason := "GRAPHQL_ERROR"
		switch envelope.Errors[0].Type {
		case "NOT_FOUND":
			return nil, fail(CodeNotFound, response.Status, "GRAPHQL_NOT_FOUND")
		case "FORBIDDEN", "INSUFFICIENT_SCOPES":
			return nil, fail(CodePermission, response.Status, "GRAPHQL_FORBIDDEN")
		}
		return nil, fail(CodeInvalid, response.Status, reason)
	}
	return envelope.Data, nil
}

func (c *Client) resolve(path string, query url.Values) (string, error) {
	// A caller-built path must stay a path. Anything that could re-target the
	// request at another authority is refused rather than escaped.
	if !strings.HasPrefix(path, "/") || strings.Contains(path, "//") || strings.ContainsAny(path, "?#\\") {
		return "", fail(CodeInvalid, 0, "PATH_INVALID")
	}
	for _, r := range path {
		if r <= 0x20 || r >= 0x7f {
			return "", fail(CodeInvalid, 0, "PATH_INVALID")
		}
	}
	target := *c.base
	target.Path = strings.TrimSuffix(c.base.Path, "/") + path
	if len(query) > 0 {
		target.RawQuery = query.Encode()
	}
	return target.String(), nil
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, cacheable bool) (Response, error) {
	target, err := c.resolve(path, query)
	if err != nil {
		return Response{}, err
	}
	var payload []byte
	if body != nil {
		if payload, err = json.Marshal(body); err != nil {
			return Response{}, fail(CodeInvalid, 0, "REQUEST_ENCODE_FAILED")
		}
	}
	key := method + " " + target
	attempts := c.attempts
	if !cacheable {
		attempts = 1
	}
	var last error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			if err = c.sleep(ctx, backoff(attempt)); err != nil {
				return Response{}, fail(CodeUnavailable, 0, "CANCELLED")
			}
		}
		if wait := c.deferral(); wait > 0 {
			// Sending now would deepen a secondary rate limit. A read waits;
			// a write refuses so the user decides, rather than stalling.
			if !cacheable {
				return Response{}, fail(CodeRateLimited, 0, "RATE_LIMIT_DEFERRED")
			}
			if err = c.sleep(ctx, wait); err != nil {
				return Response{}, fail(CodeUnavailable, 0, "CANCELLED")
			}
		}
		response, retry, err := c.attempt(ctx, method, target, key, payload, cacheable)
		if err == nil {
			return response, nil
		}
		last = err
		if !retry {
			return Response{}, err
		}
	}
	return Response{}, last
}

func backoff(attempt int) time.Duration {
	return time.Duration(1<<uint(attempt-1)) * 500 * time.Millisecond
}

func (c *Client) deferral() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.deferUntilMS == 0 {
		return 0
	}
	remaining := c.deferUntilMS - c.now().UnixMilli()
	if remaining <= 0 {
		c.deferUntilMS = 0
		return 0
	}
	// A remote may name an implausibly distant reset; waiting minutes inside one
	// request would look like a hang, so it is capped and reported instead.
	if remaining > int64(30*time.Second/time.Millisecond) {
		remaining = int64(30 * time.Second / time.Millisecond)
	}
	return time.Duration(remaining) * time.Millisecond
}

func (c *Client) attempt(ctx context.Context, method, target, key string, payload []byte, cacheable bool) (Response, bool, error) {
	token, err := c.token(ctx)
	if err != nil {
		return Response{}, false, err
	}
	if token == "" {
		return Response{}, false, fail(CodeUnauthenticated, 0, "NO_CREDENTIAL")
	}
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return Response{}, false, fail(CodeInvalid, 0, "REQUEST_INVALID")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", acceptREST)
	request.Header.Set("X-GitHub-Api-Version", apiVersion)
	request.Header.Set("User-Agent", c.agent)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	var cached *cacheEntry
	if cacheable {
		if cached = c.lookup(key); cached != nil && cached.etag != "" {
			request.Header.Set("If-None-Match", cached.etag)
		}
	}
	result, err := c.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return Response{}, false, fail(CodeUnavailable, 0, "CANCELLED")
		}
		if !cacheable {
			// The request may have been delivered and only the response lost.
			return Response{}, false, fail(CodeUnknownOutcome, 0, "TRANSPORT_FAILED")
		}
		return Response{}, true, fail(CodeUnavailable, 0, "TRANSPORT_FAILED")
	}
	defer result.Body.Close()
	rate := c.observe(result)
	if result.StatusCode == http.StatusNotModified && cached != nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(result.Body, 1<<10))
		return Response{Status: http.StatusOK, Body: cached.body, NextPage: nextPage(cached.link), Rate: rate, OAuthScopes: oauthScopes(result), FromCache: true}, false, nil
	}
	data, err := io.ReadAll(io.LimitReader(result.Body, MaxResponseBytes+1))
	if err != nil {
		if !cacheable {
			return Response{}, false, fail(CodeUnknownOutcome, result.StatusCode, "RESPONSE_TRUNCATED")
		}
		return Response{}, true, fail(CodeUnavailable, result.StatusCode, "RESPONSE_TRUNCATED")
	}
	if len(data) > MaxResponseBytes {
		return Response{}, false, fail(CodeInvalid, result.StatusCode, "RESPONSE_TOO_LARGE")
	}
	if result.StatusCode >= 200 && result.StatusCode < 300 {
		link := result.Header.Get("Link")
		if cacheable {
			c.store(key, result.Header.Get("ETag"), link, data)
		}
		return Response{Status: result.StatusCode, Body: data, NextPage: nextPage(link), Rate: rate, OAuthScopes: oauthScopes(result), FromCache: false}, false, nil
	}
	return Response{}, c.retryable(result.StatusCode, cacheable), c.classify(result, rate, cacheable)
}

func (c *Client) retryable(status int, cacheable bool) bool {
	if !cacheable {
		return false
	}
	return status == http.StatusInternalServerError || status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

func (c *Client) classify(result *http.Response, rate RateLimit, cacheable bool) error {
	status := result.StatusCode
	switch {
	case status == http.StatusUnauthorized:
		return fail(CodeUnauthenticated, status, "TOKEN_REJECTED")
	case status == http.StatusTooManyRequests:
		return fail(CodeRateLimited, status, "RATE_LIMITED")
	case status == http.StatusForbidden:
		// GitHub answers 403 for both "you may not" and its secondary rate
		// limit. Only the quota headers tell them apart, so they are not merged.
		if rate.Throttled || rate.Remaining == 0 && rate.Limit > 0 {
			return fail(CodeRateLimited, status, "RATE_LIMITED")
		}
		return fail(CodePermission, status, "FORBIDDEN")
	case status == http.StatusNotFound:
		return fail(CodeNotFound, status, "NOT_FOUND")
	case status == http.StatusConflict:
		return fail(CodeConflict, status, "CONFLICT")
	case status == http.StatusUnprocessableEntity:
		return fail(CodeInvalid, status, "UNPROCESSABLE")
	case status == http.StatusMethodNotAllowed:
		return fail(CodeUnsupported, status, "METHOD_NOT_ALLOWED")
	case status >= 300 && status < 400:
		return fail(CodeInvalid, status, "REDIRECT_REFUSED")
	case status >= 500:
		if !cacheable {
			return fail(CodeUnknownOutcome, status, "REMOTE_UNAVAILABLE")
		}
		return fail(CodeUnavailable, status, "REMOTE_UNAVAILABLE")
	}
	return fail(CodeInvalid, status, "UNEXPECTED_STATUS")
}

func headerInt(result *http.Response, name string) int64 {
	value, err := strconv.ParseInt(strings.TrimSpace(result.Header.Get(name)), 10, 64)
	if err != nil || value < 0 {
		return 0
	}
	return value
}

func (c *Client) observe(result *http.Response) RateLimit {
	now := c.now().UnixMilli()
	rate := RateLimit{
		Limit:     headerInt(result, "X-RateLimit-Limit"),
		Remaining: headerInt(result, "X-RateLimit-Remaining"),
	}
	if reset := headerInt(result, "X-RateLimit-Reset"); reset > 0 {
		rate.ResetsAtMS = reset * 1000
	}
	if retry := headerInt(result, "Retry-After"); retry > 0 {
		rate.RetryAfterMS = now + retry*1000
	}
	if result.StatusCode == http.StatusTooManyRequests || (result.StatusCode == http.StatusForbidden && rate.RetryAfterMS > 0) {
		rate.Throttled = true
	}
	if result.Header.Get("X-RateLimit-Remaining") == "0" {
		rate.Throttled = true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastRate = rate
	switch {
	case rate.RetryAfterMS > now:
		c.deferUntilMS = rate.RetryAfterMS
	case rate.Throttled && rate.ResetsAtMS > now:
		c.deferUntilMS = rate.ResetsAtMS
	case !rate.Throttled:
		c.deferUntilMS = 0
	}
	return rate
}

func (c *Client) lookup(key string) *cacheEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := c.cache[key]
	if entry != nil {
		c.clock++
		entry.usedAt = c.clock
	}
	return entry
}

func (c *Client) store(key, etag, link string, body []byte) {
	if etag == "" || len(body) > maxCacheBytes {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing := c.cache[key]; existing != nil {
		c.cacheSize -= len(existing.body)
		delete(c.cache, key)
	}
	for (len(c.cache) >= maxCacheEntries || c.cacheSize+len(body) > maxCacheBytes) && len(c.cache) > 0 {
		oldestKey, oldest := "", int64(0)
		for candidate, entry := range c.cache {
			if oldestKey == "" || entry.usedAt < oldest {
				oldestKey, oldest = candidate, entry.usedAt
			}
		}
		c.cacheSize -= len(c.cache[oldestKey].body)
		delete(c.cache, oldestKey)
	}
	c.clock++
	c.cache[key] = &cacheEntry{etag: etag, link: link, body: append([]byte(nil), body...), usedAt: c.clock}
	c.cacheSize += len(body)
}

// oauthScopes reads the scopes a classic token carries. A fine-grained token
// reports none, so an empty list means "not reported", never "no access".
func oauthScopes(result *http.Response) []string {
	raw := result.Header.Get("X-OAuth-Scopes")
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	scopes := []string{}
	for _, part := range strings.Split(raw, ",") {
		value := strings.TrimSpace(part)
		if value == "" || len(value) > 64 || len(scopes) >= 32 {
			continue
		}
		for _, r := range value {
			if r <= 0x20 || r >= 0x7f {
				value = ""
				break
			}
		}
		if value != "" {
			scopes = append(scopes, value)
		}
	}
	return scopes
}

// nextPage reads only the page number out of a Link header. The remote URL
// itself is never followed or handed back to a client: a cursor that is a URL
// would let a response steer the next request.
func nextPage(link string) int {
	for _, section := range strings.Split(link, ",") {
		parts := strings.Split(strings.TrimSpace(section), ";")
		if len(parts) < 2 {
			continue
		}
		relation := false
		for _, attribute := range parts[1:] {
			value := strings.TrimSpace(attribute)
			if value == `rel="next"` || value == "rel=next" {
				relation = true
			}
		}
		if !relation {
			continue
		}
		raw := strings.TrimSpace(parts[0])
		if !strings.HasPrefix(raw, "<") || !strings.HasSuffix(raw, ">") {
			continue
		}
		parsed, err := url.Parse(raw[1 : len(raw)-1])
		if err != nil {
			continue
		}
		page, err := strconv.Atoi(parsed.Query().Get("page"))
		if err != nil || page < 2 || page > 10000 {
			continue
		}
		return page
	}
	return 0
}
