package identity

import (
	"context"
	"errors"
	"math"
	"time"

	"armadra.local/host/internal/storage"
)

type Service struct {
	store      *storage.Store
	instanceID string
	clock      func() time.Time
}

func New(store *storage.Store, config Config) (*Service, error) {
	if store == nil || !idPattern.MatchString(config.InstanceID) {
		return nil, ErrInvalid
	}
	if config.Clock == nil {
		config.Clock = time.Now
	}
	return &Service{store: store, instanceID: config.InstanceID, clock: config.Clock}, nil
}
func (s *Service) now() (int64, error) {
	now := s.clock().UnixMilli()
	if now <= 0 || now > math.MaxInt64-SessionTTL.Milliseconds() {
		return 0, ErrInvalid
	}
	return now, nil
}
func (s *Service) audience(host, origin string) bool {
	return host == s.store.HostID() && validOrigin(origin)
}

// IssueBootstrap is a privileged LOCAL operation. The caller must authenticate
// the OS user, choose the approved device label/grants, and never expose this
// method as an anonymous browser or network RPC. Tokens are not logged.
func (s *Service) IssueBootstrap(ctx context.Context, request BootstrapRequest) (BootstrapTicket, error) {
	if !s.audience(request.HostID, request.Origin) || request.InstanceID != s.instanceID || !validName(request.DeviceName) {
		return BootstrapTicket{}, ErrInvalid
	}
	scopes, err := encodeScopes(request.Scopes)
	if err != nil {
		return BootstrapTicket{}, err
	}
	id, err := newID()
	if err != nil {
		return BootstrapTicket{}, err
	}
	secret, err := newSecret()
	if err != nil {
		return BootstrapTicket{}, err
	}
	value := id + "." + secret
	var result BootstrapTicket
	err = s.store.IdentityTransaction(ctx, func(tx *storage.IdentityTx) error {
		now, err := s.now()
		if err != nil {
			return err
		}
		result = BootstrapTicket{Ticket: value, ExpiresAtMS: now + BootstrapTTL.Milliseconds()}
		return tx.CreateTicket(storage.IdentityTicket{ID: id, Hash: digest("bootstrap", value), HostID: request.HostID, InstanceID: request.InstanceID, Origin: request.Origin, DeviceName: request.DeviceName, Scopes: scopes, CreatedAtMS: now, ExpiresAtMS: result.ExpiresAtMS})
	})
	if err != nil {
		return BootstrapTicket{}, err
	}
	return result, nil
}

func makeCredentials(id string) (SessionCredentials, error) {
	access, err := newSecret()
	if err != nil {
		return SessionCredentials{}, err
	}
	refresh, err := newSecret()
	if err != nil {
		return SessionCredentials{}, err
	}
	csrf, err := newSecret()
	if err != nil {
		return SessionCredentials{}, err
	}
	return SessionCredentials{AccessToken: id + "." + access, RefreshToken: id + "." + refresh, CSRFToken: csrf}, nil
}
func (s *Service) ConsumeBootstrap(ctx context.Context, request ConsumeRequest) (SessionCredentials, error) {
	id, valid := parseToken(request.Ticket)
	if !valid || !s.audience(request.HostID, request.Origin) || request.InstanceID != s.instanceID {
		return SessionCredentials{}, ErrUnauthenticated
	}
	sessionID, err := newID()
	if err != nil {
		return SessionCredentials{}, err
	}
	deviceID, err := newID()
	if err != nil {
		return SessionCredentials{}, err
	}
	ownerID, err := newID()
	if err != nil {
		return SessionCredentials{}, err
	}
	result, err := makeCredentials(sessionID)
	if err != nil {
		return SessionCredentials{}, err
	}
	err = s.store.IdentityTransaction(ctx, func(tx *storage.IdentityTx) error {
		now, err := s.now()
		if err != nil {
			return err
		}
		ticket, err := tx.Ticket(id)
		if errors.Is(err, storage.ErrNotFound) {
			return ErrUnauthenticated
		}
		if err != nil {
			return err
		}
		if ticket.HostID != request.HostID || ticket.InstanceID != s.instanceID || ticket.Origin != request.Origin || ticket.ConsumedAtMS != 0 || now < ticket.CreatedAtMS || now >= ticket.ExpiresAtMS || !matches("bootstrap", request.Ticket, ticket.Hash) {
			return ErrUnauthenticated
		}
		scopes, err := decodeScopes(ticket.Scopes)
		if err != nil {
			return err
		}
		owner, err := tx.Owner()
		if errors.Is(err, storage.ErrNotFound) {
			owner = storage.IdentityOwner{PrincipalID: ownerID, CreatedAtMS: now}
			err = tx.CreateOwner(owner)
		}
		if err != nil {
			return err
		}
		device := storage.IdentityDevice{ID: deviceID, PrincipalID: owner.PrincipalID, Name: ticket.DeviceName, Role: string(RoleOwner), Epoch: 1, CreatedAtMS: now}
		if err = tx.CreateDevice(device); err != nil {
			return err
		}
		result.AccessExpiresAtMS = now + AccessTTL.Milliseconds()
		result.ExpiresAtMS = now + SessionTTL.Milliseconds()
		session := storage.IdentitySession{ID: sessionID, DeviceID: deviceID, DeviceEpoch: 1, Origin: ticket.Origin, Scopes: ticket.Scopes, AccessHash: digest("access", result.AccessToken), RefreshHash: digest("refresh", result.RefreshToken), CSRFHash: digest("csrf", result.CSRFToken), Rotation: 1, CreatedAtMS: now, AccessExpiresAtMS: result.AccessExpiresAtMS, ExpiresAtMS: result.ExpiresAtMS}
		if err = tx.CreateSession(session); err != nil {
			return err
		}
		if err = tx.ConsumeTicket(id, now); err != nil {
			return err
		}
		result.Principal = s.principal(session, device, scopes)
		return nil
	})
	if err != nil {
		return SessionCredentials{}, err
	}
	return result, nil
}

func (s *Service) principal(session storage.IdentitySession, device storage.IdentityDevice, scopes []Scope) Principal {
	return Principal{HostID: s.store.HostID(), PrincipalID: device.PrincipalID, DeviceID: device.ID, DeviceName: device.Name, DeviceCreatedAtMS: device.CreatedAtMS, AccessExpiresAtMS: session.AccessExpiresAtMS, SessionID: session.ID, Origin: session.Origin, Role: Role(device.Role), DeviceEpoch: device.Epoch, Scopes: scopes}
}

// liveSession validates persisted ownership and the revocation epoch every time;
// no in-memory authentication cache can outlive a device revocation or restart.
func (s *Service) liveSession(tx *storage.IdentityTx, id, origin string, now int64) (storage.IdentitySession, storage.IdentityDevice, []Scope, error) {
	session, err := tx.Session(id)
	if errors.Is(err, storage.ErrNotFound) {
		err = ErrUnauthenticated
	}
	if err != nil {
		return session, storage.IdentityDevice{}, nil, err
	}
	denied := func() (storage.IdentitySession, storage.IdentityDevice, []Scope, error) {
		return storage.IdentitySession{}, storage.IdentityDevice{}, nil, ErrUnauthenticated
	}
	if session.Origin != origin || session.RevokedAtMS != 0 || now < session.CreatedAtMS || now >= session.ExpiresAtMS || session.Rotation < 1 {
		return denied()
	}
	device, err := tx.Device(session.DeviceID)
	if errors.Is(err, storage.ErrNotFound) {
		return denied()
	}
	if err != nil {
		return session, device, nil, err
	}
	owner, err := tx.Owner()
	if errors.Is(err, storage.ErrNotFound) {
		return denied()
	}
	if err != nil {
		return session, device, nil, err
	}
	if device.RevokedAtMS != 0 || device.Epoch != session.DeviceEpoch || device.Role != string(RoleOwner) || device.PrincipalID != owner.PrincipalID {
		return denied()
	}
	scopes, err := decodeScopes(session.Scopes)
	return session, device, scopes, err
}
func (s *Service) authenticate(tx *storage.IdentityTx, request AccessRequest, now int64) (Principal, error) {
	id, valid := parseToken(request.AccessToken)
	if !valid || !s.audience(request.HostID, request.Origin) {
		return Principal{}, ErrUnauthenticated
	}
	var required []Scope
	if len(request.RequiredScopes) > 0 {
		var err error
		required, err = normalizeScopes(request.RequiredScopes)
		if err != nil {
			return Principal{}, ErrInvalid
		}
	}
	session, device, scopes, err := s.liveSession(tx, id, request.Origin, now)
	if err != nil {
		return Principal{}, err
	}
	if now >= session.AccessExpiresAtMS || !matches("access", request.AccessToken, session.AccessHash) {
		return Principal{}, ErrUnauthenticated
	}
	if request.RequireCSRF && (!validSecret(request.CSRFToken) || !matches("csrf", request.CSRFToken, session.CSRFHash)) {
		return Principal{}, ErrPermission
	}
	if !permits(scopes, required) {
		return Principal{}, ErrPermission
	}
	return s.principal(session, device, scopes), nil
}
func (s *Service) Authenticate(ctx context.Context, request AccessRequest) (Principal, error) {
	var result Principal
	err := s.store.IdentityTransaction(ctx, func(tx *storage.IdentityTx) error {
		now, err := s.now()
		if err != nil {
			return err
		}
		result, err = s.authenticate(tx, request, now)
		return err
	})
	if err != nil {
		return Principal{}, err
	}
	return result, nil
}

// Refresh rotates all three secrets atomically. Replaying a spent token is
// rejected, never retried or treated as a cached successful credential result.
// The original 30-day absolute expiry is preserved across rotations.
func (s *Service) Refresh(ctx context.Context, request RefreshRequest) (SessionCredentials, error) {
	id, valid := parseToken(request.RefreshToken)
	if !valid || !s.audience(request.HostID, request.Origin) || !validSecret(request.CSRFToken) {
		return SessionCredentials{}, ErrUnauthenticated
	}
	result, err := makeCredentials(id)
	if err != nil {
		return SessionCredentials{}, err
	}
	err = s.store.IdentityTransaction(ctx, func(tx *storage.IdentityTx) error {
		now, err := s.now()
		if err != nil {
			return err
		}
		session, device, scopes, err := s.liveSession(tx, id, request.Origin, now)
		if err != nil {
			return err
		}
		if !matches("refresh", request.RefreshToken, session.RefreshHash) || !matches("csrf", request.CSRFToken, session.CSRFHash) {
			return ErrUnauthenticated
		}
		result.AccessExpiresAtMS = min(now+AccessTTL.Milliseconds(), session.ExpiresAtMS)
		result.ExpiresAtMS = session.ExpiresAtMS
		if err = tx.RotateSession(id, session.Rotation, digest("access", result.AccessToken), digest("refresh", result.RefreshToken), digest("csrf", result.CSRFToken), result.AccessExpiresAtMS); err != nil {
			return err
		}
		session.AccessExpiresAtMS = result.AccessExpiresAtMS
		result.Principal = s.principal(session, device, scopes)
		return nil
	})
	if err != nil {
		return SessionCredentials{}, err
	}
	return result, nil
}

// RenewCSRF recovers a browser session after losing its in-memory CSRF secret.
// The refresh credential must still be live; access expiry does not extend the
// absolute session deadline. HTTP MUST additionally require an exact Origin and
// a non-simple application/x-protobuf POST, and return no credential via CORS to
// an unapproved origin. This method does not authenticate an anonymous caller.
func (s *Service) RenewCSRF(ctx context.Context, request CSRFRequest) (string, error) {
	id, valid := parseToken(request.RefreshToken)
	if !valid || !s.audience(request.HostID, request.Origin) {
		return "", ErrUnauthenticated
	}
	secret, err := newSecret()
	if err != nil {
		return "", err
	}
	err = s.store.IdentityTransaction(ctx, func(tx *storage.IdentityTx) error {
		now, err := s.now()
		if err != nil {
			return err
		}
		session, _, _, err := s.liveSession(tx, id, request.Origin, now)
		if err != nil {
			return err
		}
		if !matches("refresh", request.RefreshToken, session.RefreshHash) {
			return ErrUnauthenticated
		}
		return tx.RenewSessionCSRF(id, session.Rotation, digest("csrf", secret))
	})
	if err != nil {
		return "", err
	}
	return secret, nil
}

// LogoutRefresh revokes the credential's own session in the same transaction
// that checks its refresh token, bound CSRF, origin and device epoch. An expired
// access cookie does not prevent logout while the absolute session is live.
// Unknown/expired credentials do not return a successful revocation receipt.
func (s *Service) LogoutRefresh(ctx context.Context, request RefreshRequest) error {
	id, valid := parseToken(request.RefreshToken)
	if !valid || !s.audience(request.HostID, request.Origin) || !validSecret(request.CSRFToken) {
		return ErrUnauthenticated
	}
	return s.store.IdentityTransaction(ctx, func(tx *storage.IdentityTx) error {
		now, err := s.now()
		if err != nil {
			return err
		}
		session, _, _, err := s.liveSession(tx, id, request.Origin, now)
		if err != nil {
			return err
		}
		if !matches("refresh", request.RefreshToken, session.RefreshHash) || !matches("csrf", request.CSRFToken, session.CSRFHash) {
			return ErrUnauthenticated
		}
		return tx.RevokeSession(id, now)
	})
}

func (s *Service) RevokeDevice(ctx context.Context, actor AccessRequest, deviceID string, expectedEpoch uint64) error {
	if !idPattern.MatchString(deviceID) || expectedEpoch == 0 {
		return ErrInvalid
	}
	if expectedEpoch > math.MaxInt64 {
		return storage.ErrCounterExhausted
	}
	actor.RequiredScopes = append(append([]Scope(nil), actor.RequiredScopes...), Scope{Permission: "identity:manage"})
	return s.store.IdentityTransaction(ctx, func(tx *storage.IdentityTx) error {
		now, err := s.now()
		if err != nil {
			return err
		}
		principal, err := s.authenticate(tx, actor, now)
		if err != nil {
			return err
		}
		device, err := tx.Device(deviceID)
		if err != nil {
			return err
		}
		if device.PrincipalID != principal.PrincipalID {
			return ErrPermission
		}
		if device.RevokedAtMS != 0 {
			// A repeat of the successful revoke may still carry the prior
			// epoch. A caller viewing the revoked state may carry its current
			// epoch. Both are no-ops; any other epoch is a stale confirmation.
			if expectedEpoch == device.Epoch || expectedEpoch == device.Epoch-1 {
				return nil
			}
			return storage.ErrConflict
		}
		if expectedEpoch != device.Epoch {
			return storage.ErrConflict
		}
		return tx.RevokeDevice(deviceID, device.Epoch, now)
	})
}
func (s *Service) RevokeSession(ctx context.Context, actor AccessRequest, sessionID string) error {
	if !idPattern.MatchString(sessionID) {
		return ErrInvalid
	}
	return s.store.IdentityTransaction(ctx, func(tx *storage.IdentityTx) error {
		now, err := s.now()
		if err != nil {
			return err
		}
		principal, err := s.authenticate(tx, actor, now)
		if err != nil {
			return err
		}
		// Any authenticated device can log out its own session. Other sessions
		// require the explicit identity:manage grant; role names alone grant nothing.
		if sessionID != principal.SessionID && !permits(principal.Scopes, []Scope{{Permission: "identity:manage"}}) {
			return ErrPermission
		}
		session, err := tx.Session(sessionID)
		if err != nil {
			return err
		}
		device, err := tx.Device(session.DeviceID)
		if err != nil {
			return err
		}
		if device.PrincipalID != principal.PrincipalID {
			return ErrPermission
		}
		if session.RevokedAtMS != 0 {
			return nil
		}
		return tx.RevokeSession(sessionID, now)
	})
}
func (s *Service) ListDevices(ctx context.Context, actor AccessRequest, afterID string, limit int) (DevicePage, error) {
	if afterID != "" && !idPattern.MatchString(afterID) || limit < 1 || limit > 200 {
		return DevicePage{}, ErrInvalid
	}
	actor.RequiredScopes = append(append([]Scope(nil), actor.RequiredScopes...), Scope{Permission: "identity:read"})
	var result DevicePage
	err := s.store.IdentityTransaction(ctx, func(tx *storage.IdentityTx) error {
		now, err := s.now()
		if err != nil {
			return err
		}
		principal, err := s.authenticate(tx, actor, now)
		if err != nil {
			return err
		}
		values, err := tx.Devices(afterID, limit+1)
		if err != nil {
			return err
		}
		result.HasMore = len(values) > limit
		if result.HasMore {
			values = values[:limit]
		}
		result.Devices = []Device{}
		for _, v := range values {
			if v.PrincipalID != principal.PrincipalID {
				return ErrPermission
			}
			result.Devices = append(result.Devices, Device{ID: v.ID, PrincipalID: v.PrincipalID, Name: v.Name, Role: Role(v.Role), Epoch: v.Epoch, CreatedAtMS: v.CreatedAtMS, RevokedAtMS: v.RevokedAtMS})
			result.NextID = v.ID
		}
		return nil
	})
	if err != nil {
		return DevicePage{}, err
	}
	return result, nil
}
