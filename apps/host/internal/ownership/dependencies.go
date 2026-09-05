package ownership

import (
	"context"
	"slices"

	"armadra.local/host/internal/storage"
)

// Switch order and its dependencies (Go Host 业务所有权迁移 §1.2).
//
// The domains move in one order — canvas, settings, filesystem, session, agent,
// git — because each one leans on the records the earlier ones own: agent state
// is anchored to sessions, sessions resolve roots through the filesystem, the
// filesystem is routed by the execution hosts in settings. Moving one out of
// order would leave the Host owning records that reference rows the Runtime is
// still writing.
//
// Rolling back runs the same order backwards, for the same reason: a domain
// cannot be handed back while a domain that depends on it is still on the Host.
//
// The check is not advisory. A switch that would break the order is refused
// with a reason key, and the records that were verified are returned so the
// caller can show which ones actually held.

// dependencies returns the domains that must already have settled on `target`
// before `domain` may move there. Switching to the Host depends on everything
// before it; rolling back to the Runtime depends on everything after it.
func dependencies(domain string, target string) []string {
	index := slices.Index(storage.OwnershipDomains, domain)
	if index < 0 {
		return nil
	}
	if target == storage.OwnerHost {
		return slices.Clone(storage.OwnershipDomains[:index])
	}
	return slices.Clone(storage.OwnershipDomains[index+1:])
}

// checkDependencies reads each dependency and refuses at the first one that is
// not settled on the target side. The records it verified are returned either
// way: on a refusal they are what shows the operator where the order stands.
func (s *Service) checkDependencies(ctx context.Context, domain, target string) ([]storage.Ownership, error) {
	verified := []storage.Ownership{}
	for _, name := range dependencies(domain, target) {
		record, err := s.Record(ctx, name)
		if err != nil {
			return verified, err
		}
		verified = append(verified, record)
		if record.Owner != target || record.Phase != storage.OwnershipSettled {
			return verified, ErrDependency
		}
	}
	return verified, nil
}
