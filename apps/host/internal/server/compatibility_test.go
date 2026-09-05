package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// tools/release/compatibility.json is what the release pipeline renders into
// the fenced declaration a release note carries, and it is what the Host reads
// back to decide whether a release is one this build may move to. The two are
// the same statement made in two places, so a release whose fence disagrees
// with the code it contains would be refused by every client that installed it
// — and nobody would find out until then.
//
// Design docs/design/updates-and-service-install.md §1.4.
func TestPublishedCompatibilityMatchesThisProtocol(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "tools", "release", "compatibility.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the release compatibility declaration is missing: %v", err)
	}
	var document struct {
		MinimumInstalled     string `json:"minimumInstalled"`
		MaximumInstalled     string `json:"maximumInstalled"`
		ProtocolMajor        uint32 `json:"protocolMajor"`
		MinimumProtocolMinor uint32 `json:"minimumProtocolMinor"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatalf("the release compatibility declaration is unreadable: %v", err)
	}
	if document.ProtocolMajor != ProtocolMajor {
		t.Fatalf("compatibility.json declares protocol major %d, this Host speaks %d", document.ProtocolMajor, ProtocolMajor)
	}
	// A release may demand a minor no higher than the one it ships. Demanding
	// more would refuse the very build being released.
	if document.MinimumProtocolMinor > ProtocolMinor {
		t.Fatalf("compatibility.json demands protocol minor %d, this Host speaks %d", document.MinimumProtocolMinor, ProtocolMinor)
	}
	if document.MinimumInstalled == "" {
		t.Fatal("compatibility.json declares no minimum installed version; a release with no stated migration path is refused by the Host")
	}
}
