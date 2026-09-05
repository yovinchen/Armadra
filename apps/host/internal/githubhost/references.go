package githubhost

import (
	"context"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// External references link one Issue or pull request to one local session,
// branch or worktree (design §7.1). A reference is a badge and a way back — it
// never turns a session into a GitHub object, and unlinking never touches
// either side.

func referenceKind(value int64) pb.GithubReferenceKind {
	if value == storage.GithubReferencePull {
		return pb.GithubReferenceKind_GITHUB_REFERENCE_KIND_PULL_REQUEST
	}
	return pb.GithubReferenceKind_GITHUB_REFERENCE_KIND_ISSUE
}

func referenceKindValue(kind pb.GithubReferenceKind) (int64, error) {
	switch kind {
	case pb.GithubReferenceKind_GITHUB_REFERENCE_KIND_ISSUE:
		return storage.GithubReferenceIssue, nil
	case pb.GithubReferenceKind_GITHUB_REFERENCE_KIND_PULL_REQUEST:
		return storage.GithubReferencePull, nil
	}
	return 0, ErrInvalid
}

func targetKind(value int64) pb.GithubReferenceTargetKind {
	switch value {
	case storage.GithubTargetBranch:
		return pb.GithubReferenceTargetKind_GITHUB_REFERENCE_TARGET_KIND_BRANCH
	case storage.GithubTargetWorktree:
		return pb.GithubReferenceTargetKind_GITHUB_REFERENCE_TARGET_KIND_WORKTREE
	}
	return pb.GithubReferenceTargetKind_GITHUB_REFERENCE_TARGET_KIND_SESSION
}

func targetKindValue(kind pb.GithubReferenceTargetKind) (int64, error) {
	switch kind {
	case pb.GithubReferenceTargetKind_GITHUB_REFERENCE_TARGET_KIND_SESSION:
		return storage.GithubTargetSession, nil
	case pb.GithubReferenceTargetKind_GITHUB_REFERENCE_TARGET_KIND_BRANCH:
		return storage.GithubTargetBranch, nil
	case pb.GithubReferenceTargetKind_GITHUB_REFERENCE_TARGET_KIND_WORKTREE:
		return storage.GithubTargetWorktree, nil
	}
	return 0, ErrInvalid
}

func referenceMessage(record storage.GithubReferenceRecord) *pb.GithubExternalReference {
	return &pb.GithubExternalReference{
		ReferenceId: record.ReferenceID,
		WorkspaceId: record.WorkspaceID,
		Repository: &pb.GithubRepositoryRef{
			Owner:   record.Repository.Owner,
			Name:    record.Repository.Name,
			ApiBase: record.Repository.APIBase,
			Host:    record.Repository.WebHost,
		},
		Kind:            referenceKind(record.Kind),
		Number:          record.Number,
		TargetKind:      targetKind(record.TargetKind),
		TargetId:        record.TargetID,
		Title:           record.Title,
		Revision:        record.Revision,
		CreatedAtUnixMs: record.CreatedAtMS,
		UpdatedAtUnixMs: record.UpdatedAtMS,
	}
}

// referencesFor collects the links pointing at one remote object, so a detail
// view can show which local sessions or worktrees are working on it.
func (s *Service) referencesFor(ctx context.Context, workspace string, ref *pb.GithubRepositoryRef, kind pb.GithubReferenceKind, number int64) ([]*pb.GithubExternalReference, error) {
	records, err := s.store.GithubReferences(ctx, workspace, "", "", MaxPageLimit)
	if err != nil {
		return nil, err
	}
	result := []*pb.GithubExternalReference{}
	for _, record := range records {
		if record.Number != number || referenceKind(record.Kind) != kind {
			continue
		}
		if record.Repository.Owner != ref.Owner || record.Repository.Name != ref.Name || record.Repository.APIBase != ref.ApiBase {
			continue
		}
		result = append(result, referenceMessage(record))
	}
	return result, nil
}

// LinkReference records one link. Its identifier is derived from what the link
// means, so linking the same Issue to the same target twice is the same record
// rather than two badges on one node.
func (s *Service) LinkReference(ctx context.Context, caller Caller, request *pb.LinkGithubReferenceRequest) (*pb.GithubExternalReference, error) {
	if err := s.authorize(caller, ScopeWrite); err != nil {
		return nil, err
	}
	reference := request.GetReference()
	if reference == nil {
		return nil, ErrInvalid
	}
	ref, err := s.repository(ctx, reference.GetRepository())
	if err != nil {
		return nil, err
	}
	kind, err := referenceKindValue(reference.GetKind())
	if err != nil {
		return nil, err
	}
	target, err := targetKindValue(reference.GetTargetKind())
	if err != nil {
		return nil, err
	}
	id := strings.TrimSpace(reference.GetTargetId())
	if id == "" || len(id) > 512 || reference.GetNumber() <= 0 || len(reference.GetTitle()) > 1024 {
		return nil, ErrInvalid
	}
	now := s.now().UnixMilli()
	record := storage.GithubReferenceRecord{
		ReferenceID: referenceID(caller.WorkspaceID, ref, reference.GetKind(), reference.GetNumber(), reference.GetTargetKind(), id),
		WorkspaceID: caller.WorkspaceID,
		Repository:  key(ref),
		Kind:        kind,
		Number:      reference.GetNumber(),
		TargetKind:  target,
		TargetID:    id,
		Title:       reference.GetTitle(),
		CreatedAtMS: now,
		UpdatedAtMS: now,
	}
	stored, err := s.store.PutGithubReference(ctx, record, request.GetExpectedRevision())
	if err != nil {
		return nil, err
	}
	return referenceMessage(stored), nil
}

// UnlinkReference removes one link only. The remote object and the local
// session it pointed at are both left exactly as they were.
func (s *Service) UnlinkReference(ctx context.Context, caller Caller, request *pb.UnlinkGithubReferenceRequest) (*pb.UnlinkGithubReferenceResponse, error) {
	if err := s.authorize(caller, ScopeWrite); err != nil {
		return nil, err
	}
	id := request.GetReferenceId()
	if id == "" || len(id) > 256 || request.GetExpectedRevision() == 0 {
		return nil, ErrInvalid
	}
	if err := s.store.DeleteGithubReference(ctx, caller.WorkspaceID, id, request.GetExpectedRevision()); err != nil {
		return nil, err
	}
	return &pb.UnlinkGithubReferenceResponse{ReferenceId: id, Unlinked: true}, nil
}

// ListReferences lists this workspace's links, optionally for one target. An
// empty target lists the whole workspace; it is never an implicit match.
func (s *Service) ListReferences(ctx context.Context, caller Caller, request *pb.ListGithubReferencesRequest) (*pb.ListGithubReferencesResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	limit := pageLimit(request.GetLimit())
	records, err := s.store.GithubReferences(ctx, caller.WorkspaceID, request.GetTargetId(), request.GetAfterId(), limit+1)
	if err != nil {
		return nil, err
	}
	result := &pb.ListGithubReferencesResponse{}
	for index, record := range records {
		if index == limit {
			result.HasMore = true
			break
		}
		result.References = append(result.References, referenceMessage(record))
		result.NextId = record.ReferenceID
	}
	return result, nil
}

// Credential wrappers. The status they return never contains a token; only a
// configure request carries one, inbound.

func (s *Service) GetCredential(ctx context.Context, caller Caller) (*pb.GithubCredentialStatus, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	return s.credentials.Status(ctx)
}

// ConfigureCredential requires github:write and settings authority together:
// choosing where this Host's GitHub token comes from is a settings change, not
// an ordinary Issue edit.
func (s *Service) ConfigureCredential(ctx context.Context, caller Caller, request *pb.ConfigureGithubCredentialRequest) (*pb.GithubCredentialStatus, error) {
	if err := s.authorize(caller, ScopeWrite); err != nil {
		return nil, err
	}
	if err := s.authorize(caller, "settings:write"); err != nil {
		return nil, err
	}
	return s.credentials.Configure(ctx, request.GetSource(), request.GetToken(), request.GetApiBase(), request.GetExpectedRevision())
}

func (s *Service) RevokeCredential(ctx context.Context, caller Caller, request *pb.RevokeGithubCredentialRequest) (*pb.GithubCredentialStatus, error) {
	if err := s.authorize(caller, ScopeWrite); err != nil {
		return nil, err
	}
	if err := s.authorize(caller, "settings:write"); err != nil {
		return nil, err
	}
	return s.credentials.Revoke(ctx, request.GetExpectedRevision())
}
