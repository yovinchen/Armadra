package identity

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"armadra.local/host/internal/storage"
)

const testHost = "0123456789abcdef0123456789abcdef"
const testInstance = "fedcba9876543210fedcba9876543210"
const testOrigin = "https://app.example.test"

var testContext = context.Background()

type fixture struct {
	store   *storage.Store
	service *Service
	dir     string
	now     atomic.Int64
}

func setup(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{dir: t.TempDir()}
	f.now.Store(time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC).UnixMilli())
	// t.TempDir permissions vary by platform; Storage applies its private policy.
	var err error
	f.store, err = storage.Open(f.dir, testHost)
	if err != nil {
		t.Fatal(err)
	}
	f.service, err = New(f.store, Config{InstanceID: testInstance, Clock: func() time.Time { return time.UnixMilli(f.now.Load()) }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := f.store.Close(); err != nil {
			t.Error(err)
		}
	})
	return f
}
func (f *fixture) ticket(t *testing.T, name string, scopes []Scope) BootstrapTicket {
	t.Helper()
	ticket, err := f.service.IssueBootstrap(testContext, BootstrapRequest{HostID: testHost, InstanceID: testInstance, Origin: testOrigin, DeviceName: name, Scopes: scopes})
	if err != nil {
		t.Fatal(err)
	}
	return ticket
}
func consume(ticket BootstrapTicket) ConsumeRequest {
	return ConsumeRequest{Ticket: ticket.Ticket, HostID: testHost, InstanceID: testInstance, Origin: testOrigin}
}
func (f *fixture) login(t *testing.T, name string, scopes []Scope) SessionCredentials {
	t.Helper()
	value, err := f.service.ConsumeBootstrap(testContext, consume(f.ticket(t, name, scopes)))
	if err != nil {
		t.Fatal(err)
	}
	return value
}
func access(value SessionCredentials) AccessRequest {
	return AccessRequest{AccessToken: value.AccessToken, HostID: testHost, Origin: testOrigin}
}
func refresh(value SessionCredentials) RefreshRequest {
	return RefreshRequest{RefreshToken: value.RefreshToken, CSRFToken: value.CSRFToken, HostID: testHost, Origin: testOrigin}
}
func requireDenied(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, ErrUnauthenticated) && !errors.Is(err, ErrPermission) {
		t.Fatalf("expected authentication/permission denial, got %v", err)
	}
}
func openRaw(t *testing.T, path string) *sql.DB {
	t.Helper()
	raw, err := storage.SQLiteReadOnlyURI(path)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("mode", "rw")
	q.Del("_pragma")
	q.Add("_pragma", "busy_timeout(5000)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestBootstrapRestartAndPrivatePersistence(t *testing.T) {
	f := setup(t)
	ticket := f.ticket(t, "桌面 owner's device", AllScopes())
	credentials, err := f.service.ConsumeBootstrap(testContext, consume(ticket))
	if err != nil {
		t.Fatal(err)
	}
	if credentials.Principal.Role != RoleOwner || credentials.Principal.HostID != testHost || credentials.Principal.DeviceEpoch != 1 {
		t.Fatal("incorrect verified principal")
	}
	other := f.login(t, "phone", []Scope{{Permission: "canvas:read", WorkspaceID: "workspace-a"}})
	if other.Principal.PrincipalID != credentials.Principal.PrincipalID || other.Principal.DeviceID == credentials.Principal.DeviceID {
		t.Fatal("devices did not share the sole owner")
	}
	_, err = f.service.ConsumeBootstrap(testContext, consume(ticket))
	requireDenied(t, err)
	if credentials.AccessExpiresAtMS != f.now.Load()+AccessTTL.Milliseconds() || credentials.ExpiresAtMS != f.now.Load()+SessionTTL.Milliseconds() {
		t.Fatal("wrong default expiry")
	}
	pending := f.ticket(t, "pending", AllScopes())
	if err = f.store.Close(); err != nil {
		t.Fatal(err)
	}
	f.store, err = storage.Open(f.dir, testHost)
	if err != nil {
		t.Fatal(err)
	}
	newInstance := strings.Repeat("a", 32)
	f.service, err = New(f.store, Config{InstanceID: newInstance, Clock: func() time.Time { return time.UnixMilli(f.now.Load()) }})
	if err != nil {
		t.Fatal(err)
	}
	verified, err := f.service.Authenticate(testContext, access(credentials))
	if err != nil || verified.PrincipalID != credentials.Principal.PrincipalID {
		t.Fatalf("session did not survive restart: %v", err)
	}
	req := consume(pending)
	req.InstanceID = newInstance
	_, err = f.service.ConsumeBootstrap(testContext, req)
	requireDenied(t, err)
	_, err = f.service.ConsumeBootstrap(testContext, consume(pending))
	requireDenied(t, err)
	for _, kind := range []string{"identity_owner", "identity_devices", "identity_sessions", "identity_bootstrap_tickets"} {
		page, err := f.store.List(testContext, storage.ListOptions{Kind: kind, Limit: 10})
		if err != nil || len(page.Entities) != 0 {
			t.Fatalf("private %s leaked into entity list: %v", kind, err)
		}
	}
	events, err := f.store.GetEvents(testContext, storage.EventQuery{})
	if err != nil || len(events.Events) != 0 || events.HighWatermark != 0 {
		t.Fatal("identity writes entered public outbox")
	}
	db := openRaw(t, f.store.Path())
	var ownerCount, deviceCount, sessionCount, ticketCount int
	for table, dest := range map[string]*int{"identity_owner": &ownerCount, "identity_devices": &deviceCount, "identity_sessions": &sessionCount, "identity_bootstrap_tickets": &ticketCount} {
		if err = db.QueryRow("SELECT count(*) FROM " + table).Scan(dest); err != nil {
			t.Fatal(err)
		}
	}
	if ownerCount != 1 || deviceCount != 2 || sessionCount != 2 || ticketCount != 3 {
		t.Fatal("unexpected private record counts")
	}
	var accessHash, refreshHash, csrfHash, ticketHash []byte
	if err = db.QueryRow("SELECT access_hash,refresh_hash,csrf_hash FROM identity_sessions WHERE session_id=?", credentials.Principal.SessionID).Scan(&accessHash, &refreshHash, &csrfHash); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow("SELECT ticket_hash FROM identity_bootstrap_tickets WHERE ticket_id=?", ticket.Ticket[:32]).Scan(&ticketHash); err != nil {
		t.Fatal(err)
	}
	for _, hash := range [][]byte{accessHash, refreshHash, csrfHash, ticketHash} {
		if len(hash) != 32 {
			t.Fatal("credential digest is not 32 bytes")
		}
	}
	for _, path := range []string{f.store.Path(), f.store.Path() + "-wal", f.store.Path() + "-shm"} {
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		for _, secret := range []string{credentials.AccessToken, credentials.AccessToken[33:], credentials.RefreshToken[33:], credentials.CSRFToken, ticket.Ticket[33:]} {
			if bytes.Contains(data, []byte(secret)) {
				t.Fatal("plaintext credential persisted in database/sidecar")
			}
		}
	}
	if strings.Contains(fmt.Sprintf("%+v %#v", credentials, credentials), credentials.AccessToken) || strings.Contains(fmt.Sprintf("%+v %#v", ticket, ticket), ticket.Ticket) {
		t.Fatal("default credential formatting is not redacted")
	}
}

func TestTicketAudienceExpiryAndNoConsumptionOnDeniedAttempt(t *testing.T) {
	f := setup(t)
	ticket := f.ticket(t, "approved", AllScopes())
	tests := map[string]func(*ConsumeRequest){
		"host":         func(r *ConsumeRequest) { r.HostID = strings.Repeat("b", 32) },
		"instance":     func(r *ConsumeRequest) { r.InstanceID = strings.Repeat("c", 32) },
		"origin":       func(r *ConsumeRequest) { r.Origin = "https://evil.example.test" },
		"scheme":       func(r *ConsumeRequest) { r.Origin = "http://localhost:1234" },
		"port":         func(r *ConsumeRequest) { r.Origin = testOrigin + ":444" },
		"empty origin": func(r *ConsumeRequest) { r.Origin = "" },
		"wrong secret": func(r *ConsumeRequest) { r.Ticket = r.Ticket[:33] + strings.Repeat("A", 43) },
	}
	for name, change := range tests {
		t.Run(name, func(t *testing.T) {
			r := consume(ticket)
			change(&r)
			_, err := f.service.ConsumeBootstrap(testContext, r)
			requireDenied(t, err)
		})
	}
	_, err := f.service.ConsumeBootstrap(testContext, consume(ticket))
	if err != nil {
		t.Fatalf("denied attempt consumed approved ticket: %v", err)
	}
	expiring := f.ticket(t, "expires", AllScopes())
	f.now.Store(expiring.ExpiresAtMS)
	_, err = f.service.ConsumeBootstrap(testContext, consume(expiring))
	requireDenied(t, err)
}

func TestConcurrentConsumptionAndSingleOwnerAcrossConnections(t *testing.T) {
	f := setup(t)
	secondStore, err := storage.Open(f.dir, testHost)
	if err != nil {
		t.Fatal(err)
	}
	defer secondStore.Close()
	second, err := New(secondStore, Config{InstanceID: testInstance, Clock: func() time.Time { return time.UnixMilli(f.now.Load()) }})
	if err != nil {
		t.Fatal(err)
	}
	ticket := f.ticket(t, "one ticket", AllScopes())
	start := make(chan struct{})
	results := make(chan SessionCredentials, 16)
	errs := make(chan error, 16)
	var group sync.WaitGroup
	for i := range 16 {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			<-start
			s := f.service
			if i%2 == 1 {
				s = second
			}
			result, err := s.ConsumeBootstrap(testContext, consume(ticket))
			if err == nil {
				results <- result
			} else {
				errs <- err
			}
		}(i)
	}
	close(start)
	group.Wait()
	close(results)
	close(errs)
	if len(results) != 1 || len(errs) != 15 {
		t.Fatalf("concurrent ticket success/denials %d/%d", len(results), len(errs))
	}
	for err := range errs {
		requireDenied(t, err)
	}
	winner := <-results
	// Two distinct tickets consuming concurrently must still share one owner.
	t1 := f.ticket(t, "tablet", AllScopes())
	t2 := f.ticket(t, "laptop", AllScopes())
	results = make(chan SessionCredentials, 2)
	for i, ticket := range []BootstrapTicket{t1, t2} {
		group.Add(1)
		go func(i int, ticket BootstrapTicket) {
			defer group.Done()
			s := f.service
			if i == 1 {
				s = second
			}
			result, err := s.ConsumeBootstrap(testContext, consume(ticket))
			if err != nil {
				t.Error(err)
				return
			}
			results <- result
		}(i, ticket)
	}
	group.Wait()
	close(results)
	for result := range results {
		if result.Principal.PrincipalID != winner.Principal.PrincipalID {
			t.Fatal("parallel bootstrap created multiple owners")
		}
	}
	page, err := f.service.ListDevices(testContext, access(winner), "", 200)
	if err != nil || len(page.Devices) != 3 {
		t.Fatalf("unexpected devices after races: %d %v", len(page.Devices), err)
	}
}

func TestRefreshCSRFAndAbsoluteExpiry(t *testing.T) {
	f := setup(t)
	old := f.login(t, "browser", AllScopes())
	request := access(old)
	request.RequireCSRF = true
	_, err := f.service.Authenticate(testContext, request)
	requireDenied(t, err)
	request.CSRFToken = old.CSRFToken
	_, err = f.service.Authenticate(testContext, request)
	if err != nil {
		t.Fatal(err)
	}
	bad := refresh(old)
	bad.CSRFToken = strings.Repeat("A", 43)
	_, err = f.service.Refresh(testContext, bad)
	requireDenied(t, err)
	f.now.Store(old.AccessExpiresAtMS)
	_, err = f.service.Authenticate(testContext, access(old))
	requireDenied(t, err)
	csrf, err := f.service.RenewCSRF(testContext, CSRFRequest{RefreshToken: old.RefreshToken, HostID: testHost, Origin: testOrigin})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.service.Refresh(testContext, refresh(old))
	requireDenied(t, err)
	old.CSRFToken = csrf
	current, err := f.service.Refresh(testContext, refresh(old))
	if err != nil {
		t.Fatal(err)
	}
	if current.AccessToken == old.AccessToken || current.RefreshToken == old.RefreshToken || current.CSRFToken == old.CSRFToken || current.ExpiresAtMS != old.ExpiresAtMS {
		t.Fatal("refresh did not rotate secrets or extended absolute expiry")
	}
	_, err = f.service.Refresh(testContext, refresh(old))
	requireDenied(t, err)
	_, err = f.service.Authenticate(testContext, access(old))
	requireDenied(t, err)
	mixed := access(current)
	mixed.RequireCSRF = true
	mixed.CSRFToken = old.CSRFToken
	_, err = f.service.Authenticate(testContext, mixed)
	requireDenied(t, err)
	mixed.CSRFToken = current.CSRFToken
	if _, err = f.service.Authenticate(testContext, mixed); err != nil {
		t.Fatal(err)
	}
	f.now.Store(current.ExpiresAtMS - 1)
	last, err := f.service.Refresh(testContext, refresh(current))
	if err != nil {
		t.Fatal(err)
	}
	if last.AccessExpiresAtMS != current.ExpiresAtMS {
		t.Fatal("access lifetime exceeded absolute refresh deadline")
	}
	f.now.Store(current.ExpiresAtMS)
	_, err = f.service.Authenticate(testContext, access(last))
	requireDenied(t, err)
	_, err = f.service.Refresh(testContext, refresh(last))
	requireDenied(t, err)
	_, err = f.service.RenewCSRF(testContext, CSRFRequest{RefreshToken: last.RefreshToken, HostID: testHost, Origin: testOrigin})
	requireDenied(t, err)
}

func TestConcurrentRefreshHasOneWinner(t *testing.T) {
	f := setup(t)
	old := f.login(t, "browser", AllScopes())
	secondStore, err := storage.Open(f.dir, testHost)
	if err != nil {
		t.Fatal(err)
	}
	defer secondStore.Close()
	second, err := New(secondStore, Config{InstanceID: testInstance, Clock: func() time.Time { return time.UnixMilli(f.now.Load()) }})
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	success := make(chan SessionCredentials, 12)
	denied := make(chan error, 12)
	var group sync.WaitGroup
	for i := range 12 {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			<-start
			s := f.service
			if i%2 == 1 {
				s = second
			}
			value, err := s.Refresh(testContext, refresh(old))
			if err != nil {
				denied <- err
			} else {
				success <- value
			}
		}(i)
	}
	close(start)
	group.Wait()
	close(success)
	close(denied)
	if len(success) != 1 || len(denied) != 11 {
		t.Fatalf("refresh winners/denials: %d/%d", len(success), len(denied))
	}
	for err := range denied {
		requireDenied(t, err)
	}
	winner := <-success
	if _, err = f.service.Authenticate(testContext, access(winner)); err != nil {
		t.Fatalf("losing refresh attempts invalidated winner: %v", err)
	}
}

func TestGrantsAndRevocationDoNotTrustRoleOrCallerIDs(t *testing.T) {
	f := setup(t)
	owner := f.login(t, "owner", AllScopes())
	narrow := f.login(t, "limited", []Scope{{Permission: "canvas:read", WorkspaceID: "w-a", ExecutionHostID: "worker-a"}})
	request := access(narrow)
	request.RequiredScopes = []Scope{{Permission: "canvas:read", WorkspaceID: "w-a", ExecutionHostID: "worker-a"}}
	if _, err := f.service.Authenticate(testContext, request); err != nil {
		t.Fatal(err)
	}
	for _, scope := range []Scope{{Permission: "canvas:write", WorkspaceID: "w-a", ExecutionHostID: "worker-a"}, {Permission: "canvas:read", WorkspaceID: "w-b", ExecutionHostID: "worker-a"}, {Permission: "canvas:read", WorkspaceID: "w-a", ExecutionHostID: "worker-b"}, {Permission: "canvas:read"}} {
		request.RequiredScopes = []Scope{scope}
		_, err := f.service.Authenticate(testContext, request)
		requireDenied(t, err)
	}
	if err := f.service.RevokeDevice(testContext, access(narrow), owner.Principal.DeviceID, owner.Principal.DeviceEpoch); !errors.Is(err, ErrPermission) {
		t.Fatalf("owner role label bypassed scope grants: %v", err)
	}
	if _, err := f.service.ListDevices(testContext, access(narrow), "", 20); !errors.Is(err, ErrPermission) {
		t.Fatalf("device list bypassed grants: %v", err)
	}
	if err := f.service.RevokeSession(testContext, access(narrow), owner.Principal.SessionID); !errors.Is(err, ErrPermission) {
		t.Fatalf("limited session revoked other session: %v", err)
	}
	if err := f.service.RevokeDevice(testContext, access(owner), narrow.Principal.DeviceID, narrow.Principal.DeviceEpoch); err != nil {
		t.Fatal(err)
	}
	if err := f.service.RevokeDevice(testContext, access(owner), narrow.Principal.DeviceID, narrow.Principal.DeviceEpoch); err != nil {
		t.Fatalf("repeat revocation not stable: %v", err)
	}
	_, err := f.service.Authenticate(testContext, access(narrow))
	requireDenied(t, err)
	_, err = f.service.Refresh(testContext, refresh(narrow))
	requireDenied(t, err)
	_, err = f.service.RenewCSRF(testContext, CSRFRequest{RefreshToken: narrow.RefreshToken, HostID: testHost, Origin: testOrigin})
	requireDenied(t, err)
	devices, err := f.service.ListDevices(testContext, access(owner), "", 200)
	if err != nil {
		t.Fatal(err)
	}
	for _, device := range devices.Devices {
		if device.ID == narrow.Principal.DeviceID && (device.Epoch != 2 || device.RevokedAtMS == 0) {
			t.Fatal("revocation epoch not persisted")
		}
	}
	another := f.login(t, "can log itself out", []Scope{{Permission: "canvas:read"}})
	if err = f.service.RevokeSession(testContext, access(another), another.Principal.SessionID); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.Authenticate(testContext, access(another))
	requireDenied(t, err)
	if _, err = f.service.Authenticate(testContext, access(owner)); err != nil {
		t.Fatal("revoking another device/session affected owner")
	}
}

func TestWrongAudienceAndCredentialPurpose(t *testing.T) {
	f := setup(t)
	value := f.login(t, "browser", AllScopes())
	for name, request := range map[string]AccessRequest{
		"host":              {AccessToken: value.AccessToken, HostID: strings.Repeat("a", 32), Origin: testOrigin},
		"origin":            {AccessToken: value.AccessToken, HostID: testHost, Origin: "https://other.example.test"},
		"no origin":         {AccessToken: value.AccessToken, HostID: testHost},
		"refresh as access": {AccessToken: value.RefreshToken, HostID: testHost, Origin: testOrigin},
	} {
		t.Run(name, func(t *testing.T) { _, err := f.service.Authenticate(testContext, request); requireDenied(t, err) })
	}
	for _, request := range []RefreshRequest{{RefreshToken: value.AccessToken, CSRFToken: value.CSRFToken, HostID: testHost, Origin: testOrigin}, {RefreshToken: value.RefreshToken, CSRFToken: value.CSRFToken, HostID: strings.Repeat("b", 32), Origin: testOrigin}, {RefreshToken: value.RefreshToken, CSRFToken: value.CSRFToken, HostID: testHost, Origin: "https://other.example.test"}} {
		_, err := f.service.Refresh(testContext, request)
		requireDenied(t, err)
	}
	for _, request := range []CSRFRequest{{RefreshToken: value.RefreshToken, HostID: testHost, Origin: "https://other.example.test"}, {RefreshToken: value.RefreshToken, HostID: strings.Repeat("b", 32), Origin: testOrigin}, {RefreshToken: value.AccessToken, HostID: testHost, Origin: testOrigin}} {
		_, err := f.service.RenewCSRF(testContext, request)
		requireDenied(t, err)
	}
}

func TestValidationRejectsUnscopedOrNoncanonicalBootstrap(t *testing.T) {
	f := setup(t)
	for _, origin := range []string{"", "null", "*", "https://example.test/", "https://user:pass@example.test", "https://example.test?q=secret", "https://example.test#secret", "https://example.test\n", "http://example.test", "https://EXAMPLE.test", "https://example.test:443", "https://*.example.test", "file://localhost", "https://example.test\\@other.test", "http://tauri.localhost:1234"} {
		_, err := f.service.IssueBootstrap(testContext, BootstrapRequest{HostID: testHost, InstanceID: testInstance, Origin: origin, DeviceName: "browser", Scopes: AllScopes()})
		if !errors.Is(err, ErrInvalid) {
			t.Fatalf("accepted invalid origin %q: %v", origin, err)
		}
	}
	for _, origin := range []string{"http://localhost:1420", "http://127.0.0.1:1420", "http://[::1]:1420", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", testOrigin} {
		_, err := f.service.IssueBootstrap(testContext, BootstrapRequest{HostID: testHost, InstanceID: testInstance, Origin: origin, DeviceName: "browser", Scopes: AllScopes()})
		if err != nil {
			t.Fatalf("valid origin %s rejected: %v", origin, err)
		}
	}
	for _, scopes := range [][]Scope{nil, {{Permission: "*"}}, {{Permission: "canvas:admin"}}, {{Permission: "identity:manage", WorkspaceID: "workspace"}}, {{Permission: "canvas:read", WorkspaceID: "*"}}, {{Permission: "canvas:read", WorkspaceID: "a\n"}}} {
		_, err := f.service.IssueBootstrap(testContext, BootstrapRequest{HostID: testHost, InstanceID: testInstance, Origin: testOrigin, DeviceName: "browser", Scopes: scopes})
		if !errors.Is(err, ErrInvalid) {
			t.Fatal("unknown/empty/invalid scopes accepted")
		}
	}
	for _, name := range []string{"", " name ", "line\nbreak", strings.Repeat("x", 257), string([]byte{0xff})} {
		_, err := f.service.IssueBootstrap(testContext, BootstrapRequest{HostID: testHost, InstanceID: testInstance, Origin: testOrigin, DeviceName: name, Scopes: AllScopes()})
		if !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid device name accepted")
		}
	}
}

func TestBootstrapFailureRollsBackDeviceOwnerAndConsumption(t *testing.T) {
	f := setup(t)
	ticket := f.ticket(t, "retry after storage failure", AllScopes())
	db := openRaw(t, f.store.Path())
	if _, err := db.Exec("CREATE TRIGGER fail_new_session BEFORE INSERT ON identity_sessions BEGIN SELECT RAISE(ABORT,'test injected failure'); END"); err != nil {
		t.Fatal(err)
	}
	result, err := f.service.ConsumeBootstrap(testContext, consume(ticket))
	if err == nil || result.AccessToken != "" {
		t.Fatal("failed transaction returned credentials")
	}
	for _, table := range []string{"identity_owner", "identity_devices", "identity_sessions"} {
		var count int
		if err = db.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("failed transaction left %s records", table)
		}
	}
	var consumed int64
	if err = db.QueryRow("SELECT consumed_at_ms FROM identity_bootstrap_tickets").Scan(&consumed); err != nil || consumed != 0 {
		t.Fatal("failed transaction spent ticket")
	}
	if _, err = db.Exec("DROP TRIGGER fail_new_session"); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.ConsumeBootstrap(testContext, consume(ticket)); err != nil {
		t.Fatalf("retry after rolled-back consumption failed: %v", err)
	}
}

func TestCancelledAndFailedRefreshDoesNotInvalidateCurrentSession(t *testing.T) {
	f := setup(t)
	value := f.login(t, "browser", AllScopes())
	ctx, cancel := context.WithCancel(testContext)
	cancel()
	next, err := f.service.Refresh(ctx, refresh(value))
	if !errors.Is(err, context.Canceled) || next.AccessToken != "" {
		t.Fatalf("cancelled refresh returned credentials: %v", err)
	}
	db := openRaw(t, f.store.Path())
	if _, err = db.Exec("CREATE TRIGGER fail_rotate BEFORE UPDATE ON identity_sessions BEGIN SELECT RAISE(ABORT,'test injected failure'); END"); err != nil {
		t.Fatal(err)
	}
	next, err = f.service.Refresh(testContext, refresh(value))
	if err == nil || next.AccessToken != "" {
		t.Fatal("failed refresh exposed uncommitted credentials")
	}
	if _, err = db.Exec("DROP TRIGGER fail_rotate"); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Authenticate(testContext, access(value)); err != nil {
		t.Fatal("failed refresh invalidated original access")
	}
	if _, err = f.service.Refresh(testContext, refresh(value)); err != nil {
		t.Fatal("failed refresh consumed original refresh")
	}
}

func TestDevicePaginationContainsNoSessionCredentials(t *testing.T) {
	f := setup(t)
	owner := f.login(t, "owner", AllScopes())
	for _, name := range []string{"tablet", "phone"} {
		f.login(t, name, AllScopes())
	}
	page, err := f.service.ListDevices(testContext, access(owner), "", 2)
	if err != nil || len(page.Devices) != 2 || !page.HasMore {
		t.Fatalf("first device page: %v", err)
	}
	next, err := f.service.ListDevices(testContext, access(owner), page.NextID, 2)
	if err != nil || len(next.Devices) != 1 || next.HasMore {
		t.Fatalf("last device page: %v", err)
	}
	if next.Devices[0].ID == page.Devices[0].ID || next.Devices[0].ID == page.Devices[1].ID {
		t.Fatal("device pagination repeated rows")
	}
	if _, err = os.Stat(filepath.Join(f.dir, "canvas.db")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("identity touched legacy database")
	}
}

func TestRevocationCASAndRestart(t *testing.T) {
	f := setup(t)
	owner := f.login(t, "owner", AllScopes())
	device := f.login(t, "phone", AllScopes())
	if err := f.service.RevokeDevice(testContext, access(owner), device.Principal.DeviceID, device.Principal.DeviceEpoch+1); !errors.Is(err, storage.ErrConflict) {
		t.Fatalf("stale UI confirmation revoked device: %v", err)
	}
	if _, err := f.service.Authenticate(testContext, access(device)); err != nil {
		t.Fatal("rejected revocation changed state")
	}
	if err := f.service.RevokeDevice(testContext, access(owner), device.Principal.DeviceID, device.Principal.DeviceEpoch); err != nil {
		t.Fatal(err)
	}
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.store, err = storage.Open(f.dir, testHost)
	if err != nil {
		t.Fatal(err)
	}
	f.service, err = New(f.store, Config{InstanceID: strings.Repeat("d", 32), Clock: func() time.Time { return time.UnixMilli(f.now.Load()) }})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.service.Authenticate(testContext, access(device))
	requireDenied(t, err)
	_, err = f.service.Refresh(testContext, refresh(device))
	requireDenied(t, err)
	if _, err = f.service.Authenticate(testContext, access(owner)); err != nil {
		t.Fatal("restart revoked unrelated owner session")
	}
}
