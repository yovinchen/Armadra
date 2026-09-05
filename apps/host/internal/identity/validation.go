package identity

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

var idPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func newSecret() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

// Hash domains prevent a token of one purpose from becoming another credential.
func digest(kind, value string) [32]byte {
	return sha256.Sum256([]byte("armadra/identity/v1/" + kind + "\x00" + value))
}
func matches(kind, value string, want [32]byte) bool {
	got := digest(kind, value)
	return subtle.ConstantTimeCompare(got[:], want[:]) == 1
}
func parseToken(value string) (string, bool) {
	if len(value) != 32+1+43 || value[32] != '.' || !idPattern.MatchString(value[:32]) {
		return "", false
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(value[33:])
	return value[:32], err == nil && len(b) == 32
}
func validSecret(value string) bool {
	if len(value) != 43 {
		return false
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return err == nil && len(b) == 32
}
func validName(value string) bool {
	if len(value) == 0 || len(value) > 256 || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	for _, r := range value {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}
func validIdentifier(value string) bool {
	if len(value) > 256 || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	for _, r := range value {
		if r < 33 || r == 127 || r == '*' {
			return false
		}
	}
	return true
}
func normalizeScopes(input []Scope) ([]Scope, error) {
	if len(input) == 0 || len(input) > MaxScopes {
		return nil, ErrInvalid
	}
	result := append([]Scope(nil), input...)
	for _, scope := range result {
		if !slices.Contains(permissions, scope.Permission) || !validIdentifier(scope.WorkspaceID) || !validIdentifier(scope.ExecutionHostID) {
			return nil, ErrInvalid
		}
		if strings.HasPrefix(scope.Permission, "identity:") && (scope.WorkspaceID != "" || scope.ExecutionHostID != "") {
			return nil, ErrInvalid
		}
	}
	slices.SortFunc(result, func(a, b Scope) int {
		if n := strings.Compare(a.Permission, b.Permission); n != 0 {
			return n
		}
		if n := strings.Compare(a.WorkspaceID, b.WorkspaceID); n != 0 {
			return n
		}
		return strings.Compare(a.ExecutionHostID, b.ExecutionHostID)
	})
	result = slices.Compact(result)
	return result, nil
}
func encodeScopes(input []Scope) ([]byte, error) {
	values, err := normalizeScopes(input)
	if err != nil {
		return nil, err
	}
	wire, err := json.Marshal(values)
	if len(wire) > 16384 {
		return nil, ErrInvalid
	}
	return wire, err
}
func decodeScopes(wire []byte) ([]Scope, error) {
	if len(wire) > 16384 {
		return nil, ErrUnauthenticated
	}
	var values []Scope
	decoder := json.NewDecoder(bytes.NewReader(wire))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&values); err != nil {
		return nil, ErrUnauthenticated
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, ErrUnauthenticated
	}
	result, err := normalizeScopes(values)
	if err != nil {
		return nil, ErrUnauthenticated
	}
	return result, nil
}
func permits(grants, required []Scope) bool {
	for _, request := range required {
		found := false
		for _, grant := range grants {
			if grant.Permission == request.Permission && (grant.WorkspaceID == "" || grant.WorkspaceID == request.WorkspaceID) && (grant.ExecutionHostID == "" || grant.ExecutionHostID == request.ExecutionHostID) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
