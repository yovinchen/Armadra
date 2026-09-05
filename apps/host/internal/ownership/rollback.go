package ownership

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"path/filepath"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// Rollback hands a domain back to the Runtime from a running Host.
//
// It is the same state machine as a switch, run in the other direction, with
// one addition: the Host owes the Runtime an export before it stops being the
// writer, and an HTTPS caller must not choose where that lands. A browser
// naming a path on this machine is a filesystem write with a URL in front of
// it, so the directory is allocated here, under the Host's own export root.
//
// The CLI keeps naming its own directory: the operator is at the machine and
// wants the package somewhere they can find it.
func (s *Service) Rollback(ctx context.Context, request Request) (*pb.OwnershipSwitchResponse, error) {
	request.Target = pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME
	if request.ExportDirectory != "" {
		// An HTTPS caller cannot name one; only the CLI reaches SwitchOffline.
		return nil, ErrInvalid
	}
	if s.options.ExportRoot == "" {
		return nil, fmt.Errorf("%w: this Host has no export directory", ErrExportRequired)
	}
	if !storage.ValidOwnershipDomain(request.Domain) {
		return nil, ErrInvalid
	}
	directory, err := s.exportDirectory(request.Domain)
	if err != nil {
		return nil, err
	}
	request.ExportDirectory = directory
	return s.Switch(ctx, request)
}

// exportDirectory names a fresh directory for one reverse export. The random
// suffix is what keeps a second attempt from being asked to overwrite the only
// copy of the first one, which Export refuses outright.
func (s *Service) exportDirectory(domain string) (string, error) {
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "", err
	}
	return filepath.Join(s.options.ExportRoot, fmt.Sprintf("%s-%d-%s", domain, s.now(), hex.EncodeToString(suffix[:]))), nil
}
