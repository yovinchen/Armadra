// Package identity authenticates the single local owner's devices. Bootstrap
// issuance is privileged: only a caller already authorized by the OS-protected
// local control transport may call IssueBootstrap. It is NOT a public RPC.
// HTTP/Cookie/TLS policy and stream cancellation remain transport responsibilities.
package identity

import (
	"errors"
	"time"
)

var (
	ErrInvalid         = errors.New("invalid identity request")
	ErrUnauthenticated = errors.New("identity credential is invalid or expired")
	ErrPermission      = errors.New("identity permission denied")
)

const (
	BootstrapTTL      = 2 * time.Minute
	AccessTTL         = 15 * time.Minute
	SessionTTL        = 30 * 24 * time.Hour
	MaxScopes         = 64
	RoleOwner    Role = "owner"
	RoleOperator Role = "operator" // Reserved; never issued by this version.
	RoleViewer   Role = "viewer"   // Reserved; never issued by this version.
)

type Role string

// Empty workspace/execution host denotes an explicitly approved host-wide
// grant, not an implicit match to the request's current workspace. A constrained
// grant never authorizes a request asking for host-wide access.
type Scope struct{ Permission, WorkspaceID, ExecutionHostID string }
type Config struct {
	InstanceID string
	Clock      func() time.Time
}
type BootstrapRequest struct {
	HostID, InstanceID, Origin, DeviceName string
	Scopes                                 []Scope
}
type BootstrapTicket struct {
	Ticket      string
	ExpiresAtMS int64
}

func (BootstrapTicket) String() string   { return "BootstrapTicket{redacted}" }
func (BootstrapTicket) GoString() string { return "BootstrapTicket{redacted}" }

type ConsumeRequest struct{ Ticket, HostID, InstanceID, Origin string }

func (ConsumeRequest) String() string   { return "ConsumeRequest{redacted}" }
func (ConsumeRequest) GoString() string { return "ConsumeRequest{redacted}" }

type AccessRequest struct {
	AccessToken, HostID, Origin string
	RequiredScopes              []Scope
	RequireCSRF                 bool
	CSRFToken                   string
}
type RefreshRequest struct{ RefreshToken, CSRFToken, HostID, Origin string }
type CSRFRequest struct{ RefreshToken, HostID, Origin string }

func (AccessRequest) String() string    { return "AccessRequest{redacted}" }
func (AccessRequest) GoString() string  { return "AccessRequest{redacted}" }
func (RefreshRequest) String() string   { return "RefreshRequest{redacted}" }
func (RefreshRequest) GoString() string { return "RefreshRequest{redacted}" }
func (CSRFRequest) String() string      { return "CSRFRequest{redacted}" }
func (CSRFRequest) GoString() string    { return "CSRFRequest{redacted}" }

type Principal struct {
	HostID, PrincipalID, DeviceID, SessionID, Origin string
	DeviceName                                       string
	DeviceCreatedAtMS, AccessExpiresAtMS             int64
	Role                                             Role
	DeviceEpoch                                      uint64
	Scopes                                           []Scope
}
type SessionCredentials struct {
	Principal                            Principal
	AccessToken, RefreshToken, CSRFToken string
	AccessExpiresAtMS, ExpiresAtMS       int64
}

func (SessionCredentials) String() string   { return "SessionCredentials{redacted}" }
func (SessionCredentials) GoString() string { return "SessionCredentials{redacted}" }

type Device struct {
	ID, PrincipalID, Name    string
	Role                     Role
	Epoch                    uint64
	CreatedAtMS, RevokedAtMS int64
}
type DevicePage struct {
	Devices []Device
	NextID  string
	HasMore bool
}

// AllScopes explicitly constructs the owner-wide grants for a trusted local
// bootstrap. Empty scopes never silently expand into full authority.
func AllScopes() []Scope {
	result := make([]Scope, 0, len(permissions))
	for _, name := range permissions {
		result = append(result, Scope{Permission: name})
	}
	return result
}

var permissions = []string{
	"canvas:read", "canvas:write", "terminal:read", "terminal:write",
	"files:read", "files:write", "git:read", "git:write", "github:read", "github:write",
	"browser:read", "browser:control", "automation:read", "automation:manage",
	"credential:use", "resources:read", "settings:read", "settings:write",
	"identity:read", "identity:manage",
}
