package server

import (
	"net/http"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
)

// Reserved surfaces: the contracts exist (presence.proto, account.proto) but
// nothing implements them. They are answered here rather than left to the
// generic 404 so a client learns the difference between "this Host is too old
// to know the method" and "this method is defined and deliberately off".
const (
	PresencePrefix = "/rpc/armadra.v1.PresenceService/"
	AccountPrefix  = "/rpc/armadra.v1.AccountService/"

	// CapabilityPresence and CapabilityAccountBinding are the names reported in
	// HelloResponse.capability_status; the UI keys its own state off them.
	CapabilityPresence       = "presence"
	CapabilityAccountBinding = "accountBinding"

	// A stable, localizable reason key. Never a path, address or secret.
	reservedReason = "host.capability.reserved"
)

var presenceMethods = []string{"SubscribePresence", "AcquireWriterLease", "ReleaseWriterLease", "ApplyMutation"}

var accountMethods = []string{"BindNodeAccount", "GetNodeAccount", "ListAccounts"}

// reservedMethod reports the capability a path belongs to, if any. Unknown
// methods under a known service still fall through to NOT_FOUND: answering
// UNSUPPORTED for a name this build never defined would invent a contract.
func reservedMethod(path string) (string, bool) {
	for _, entry := range []struct {
		prefix     string
		methods    []string
		capability string
	}{
		{PresencePrefix, presenceMethods, CapabilityPresence},
		{AccountPrefix, accountMethods, CapabilityAccountBinding},
	} {
		if !strings.HasPrefix(path, entry.prefix) {
			continue
		}
		method := strings.TrimPrefix(path, entry.prefix)
		for _, known := range entry.methods {
			if method == known {
				return entry.capability, true
			}
		}
	}
	return "", false
}

// reservedCapabilityStatus is what Hello reports. Both surfaces are named
// explicitly: silence would read as "maybe supported by this build".
func reservedCapabilityStatus() []*pb.CapabilityStatus {
	return []*pb.CapabilityStatus{
		{Name: CapabilityPresence, State: pb.CapabilityState_CAPABILITY_STATE_UNSUPPORTED, Reason: reservedReason},
		{Name: CapabilityAccountBinding, State: pb.CapabilityState_CAPABILITY_STATE_UNSUPPORTED, Reason: reservedReason},
	}
}

// reservedRequest answers a defined-but-unimplemented method. The body is never
// read: there is nothing to validate, and no request may look accepted.
func reservedRequest(w http.ResponseWriter, r *http.Request, capability string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeError(w, http.StatusMethodNotAllowed, "INVALID_ARGUMENT", "POST required")
		return
	}
	writeError(w, http.StatusNotImplemented, "UNSUPPORTED", capability+" is reserved on this Host: "+reservedReason)
}
