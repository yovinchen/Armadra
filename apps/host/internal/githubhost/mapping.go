package githubhost

import (
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/githubapi"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Status mapping: one repository, one primary source, and the groups a panel
// shows Issues under (design §7.2).
//
// Both coupling directions are configurable — a group may set the Issue state
// when entered, and an observed state may select a group — which together can
// describe a loop. A loop would make a move oscillate against the remote
// forever, so ValidateMapping refuses it before anything is stored.

// ValidateMapping checks one configuration completely. Every refusal is a
// stable reason code, because these are configuration mistakes a user has to
// find and fix, not transport failures.
func ValidateMapping(mapping *pb.GithubStatusMapping) (string, error) {
	if mapping == nil {
		return "MAPPING_REQUIRED", ErrInvalid
	}
	if len(mapping.Groups) > MaxGroups {
		return "TOO_MANY_GROUPS", ErrInvalid
	}
	switch mapping.Source {
	case pb.GithubStatusSource_GITHUB_STATUS_SOURCE_NONE:
		if len(mapping.Groups) > 0 || len(mapping.StateGroups) > 0 {
			return "SOURCE_NONE_HAS_GROUPS", ErrInvalid
		}
		if mapping.ProjectId != "" || mapping.ProjectFieldId != "" {
			return "SOURCE_NONE_HAS_PROJECT", ErrInvalid
		}
		return "", nil
	case pb.GithubStatusSource_GITHUB_STATUS_SOURCE_LABEL:
		if mapping.ProjectId != "" || mapping.ProjectFieldId != "" {
			// A repository has exactly one primary source; carrying project
			// identifiers on a label mapping would make that ambiguous.
			return "LABEL_SOURCE_HAS_PROJECT", ErrInvalid
		}
	case pb.GithubStatusSource_GITHUB_STATUS_SOURCE_PROJECT_FIELD:
		if mapping.ProjectId == "" || mapping.ProjectFieldId == "" {
			return "PROJECT_IDS_REQUIRED", ErrInvalid
		}
	default:
		return "SOURCE_UNSPECIFIED", ErrInvalid
	}
	if len(mapping.Groups) == 0 {
		return "GROUPS_REQUIRED", ErrInvalid
	}
	ids := map[string]bool{}
	labels := map[string]bool{}
	options := map[string]bool{}
	for _, group := range mapping.Groups {
		if !groupPattern.MatchString(group.Id) || ids[group.Id] {
			return "GROUP_ID_INVALID", ErrInvalid
		}
		ids[group.Id] = true
		if group.Title == "" || len(group.Title) > 128 {
			return "GROUP_TITLE_INVALID", ErrInvalid
		}
		switch group.CouplesIssueState {
		case pb.GithubIssueState_GITHUB_ISSUE_STATE_UNSPECIFIED,
			pb.GithubIssueState_GITHUB_ISSUE_STATE_OPEN,
			pb.GithubIssueState_GITHUB_ISSUE_STATE_CLOSED:
		default:
			return "GROUP_STATE_INVALID", ErrInvalid
		}
		if mapping.Source == pb.GithubStatusSource_GITHUB_STATUS_SOURCE_LABEL {
			if group.Label == "" || len(group.Label) > 128 || group.ProjectOptionId != "" {
				return "GROUP_LABEL_INVALID", ErrInvalid
			}
			// Two groups claiming one label would make an Issue's group
			// ambiguous every time, not just on conflict.
			if labels[group.Label] {
				return "GROUP_LABEL_DUPLICATE", ErrInvalid
			}
			labels[group.Label] = true
		} else {
			if group.ProjectOptionId == "" || len(group.ProjectOptionId) > 256 {
				return "GROUP_OPTION_INVALID", ErrInvalid
			}
			if options[group.ProjectOptionId] {
				return "GROUP_OPTION_DUPLICATE", ErrInvalid
			}
			options[group.ProjectOptionId] = true
		}
	}
	states := map[pb.GithubIssueState]string{}
	for _, coupling := range mapping.StateGroups {
		if coupling.State != pb.GithubIssueState_GITHUB_ISSUE_STATE_OPEN && coupling.State != pb.GithubIssueState_GITHUB_ISSUE_STATE_CLOSED {
			return "COUPLING_STATE_INVALID", ErrInvalid
		}
		if !ids[coupling.GroupId] {
			return "COUPLING_GROUP_UNKNOWN", ErrInvalid
		}
		if _, seen := states[coupling.State]; seen {
			return "COUPLING_STATE_DUPLICATE", ErrInvalid
		}
		states[coupling.State] = coupling.GroupId
	}
	if reason := detectCycle(mapping.Groups, states); reason != "" {
		return reason, ErrInvalid
	}
	return "", nil
}

// detectCycle walks group -> coupled Issue state -> that state's group. A group
// that maps back to itself is a fixed point and is fine; any longer cycle means
// entering one group would move the Issue to another and back, so it is
// refused.
func detectCycle(groups []*pb.GithubStatusGroup, states map[pb.GithubIssueState]string) string {
	next := map[string]string{}
	for _, group := range groups {
		if group.CouplesIssueState == pb.GithubIssueState_GITHUB_ISSUE_STATE_UNSPECIFIED {
			continue
		}
		target, ok := states[group.CouplesIssueState]
		if !ok || target == group.Id {
			continue
		}
		next[group.Id] = target
	}
	const (
		unvisited = 0
		onPath    = 1
		settled   = 2
	)
	mark := map[string]int{}
	for _, group := range groups {
		if mark[group.Id] != unvisited {
			continue
		}
		node := group.Id
		path := []string{}
		for {
			if mark[node] == onPath {
				return "MAPPING_CYCLE"
			}
			if mark[node] == settled {
				break
			}
			mark[node] = onPath
			path = append(path, node)
			target, ok := next[node]
			if !ok {
				break
			}
			node = target
		}
		for _, visited := range path {
			mark[visited] = settled
		}
	}
	return ""
}

// storedMapping reads one repository's configuration. A repository with none
// yet returns an empty NONE mapping at revision zero rather than an error: not
// configured is a normal state the panel shows.
func (s *Service) storedMapping(ctx context.Context, workspace string, ref *pb.GithubRepositoryRef) (*pb.GithubStatusMapping, error) {
	record, err := s.store.GithubStatusMapping(ctx, workspace, key(ref))
	if errors.Is(err, storage.ErrNotFound) {
		return &pb.GithubStatusMapping{Repository: ref, Source: pb.GithubStatusSource_GITHUB_STATUS_SOURCE_NONE}, nil
	}
	if err != nil {
		return nil, err
	}
	mapping := new(pb.GithubStatusMapping)
	if err = proto.Unmarshal(record.Mapping, mapping); err != nil {
		return nil, storage.ErrCorrupt
	}
	mapping.Repository = ref
	mapping.Revision = record.Revision
	mapping.UpdatedAtUnixMs = record.UpdatedAtMS
	return mapping, nil
}

// GetStatusMapping returns the configuration a panel groups Issues by.
func (s *Service) GetStatusMapping(ctx context.Context, caller Caller, ref *pb.GithubRepositoryRef) (*pb.GithubStatusMapping, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	repository, err := s.repository(ctx, ref)
	if err != nil {
		return nil, err
	}
	return s.storedMapping(ctx, caller.WorkspaceID, repository)
}

// PutStatusMapping validates and stores one repository's configuration under
// revision CAS.
func (s *Service) PutStatusMapping(ctx context.Context, caller Caller, mapping *pb.GithubStatusMapping, expectedRevision uint64) (*pb.GithubStatusMapping, error) {
	if err := s.authorize(caller, ScopeWrite); err != nil {
		return nil, err
	}
	if mapping == nil {
		return nil, ErrInvalid
	}
	repository, err := s.repository(ctx, mapping.Repository)
	if err != nil {
		return nil, err
	}
	if _, err = ValidateMapping(mapping); err != nil {
		return nil, err
	}
	now := s.now().UnixMilli()
	stored := proto.Clone(mapping).(*pb.GithubStatusMapping)
	// Revision and timestamp are the store's to assign; whatever the client
	// wrote in them is discarded rather than persisted as fact.
	stored.Repository = nil
	stored.Revision = 0
	stored.UpdatedAtUnixMs = 0
	wire, err := (proto.MarshalOptions{Deterministic: true}).Marshal(stored)
	if err != nil {
		return nil, err
	}
	record, err := s.store.PutGithubStatusMapping(ctx, storage.GithubStatusMappingRecord{
		WorkspaceID: caller.WorkspaceID,
		Repository:  key(repository),
		Mapping:     wire,
		CreatedAtMS: now,
		UpdatedAtMS: now,
	}, expectedRevision)
	if err != nil {
		return nil, err
	}
	result := proto.Clone(mapping).(*pb.GithubStatusMapping)
	result.Repository = repository
	result.Revision = record.Revision
	result.UpdatedAtUnixMs = record.UpdatedAtMS
	return result, nil
}

// group finds one group by identifier.
func group(mapping *pb.GithubStatusMapping, id string) *pb.GithubStatusGroup {
	for _, candidate := range mapping.Groups {
		if candidate.Id == id {
			return candidate
		}
	}
	return nil
}

// applyLabelGroups annotates issues with the group their labels put them in.
// More than one match is reported as a conflict rather than resolved by
// picking a winner, because the configuration, not the Issue, is wrong.
func applyLabelGroups(mapping *pb.GithubStatusMapping, issues []*pb.GithubIssue) {
	if mapping.Source != pb.GithubStatusSource_GITHUB_STATUS_SOURCE_LABEL {
		return
	}
	byLabel := map[string]string{}
	for _, entry := range mapping.Groups {
		byLabel[entry.Label] = entry.Id
	}
	for _, issue := range issues {
		matched := ""
		for _, label := range issue.Labels {
			id, ok := byLabel[label.Name]
			if !ok {
				continue
			}
			if matched != "" && matched != id {
				issue.StatusConflict = true
				matched = ""
				break
			}
			matched = id
		}
		issue.StatusGroupId = matched
	}
}

// applyProjectGroups annotates issues from one Projects v2 Status field. The
// project is read once per page; an Issue that is not on the project stays
// unmapped rather than being guessed into a group.
func (s *Service) applyProjectGroups(ctx context.Context, client *githubapi.Client, mapping *pb.GithubStatusMapping, issues []*pb.GithubIssue) error {
	if mapping.Source != pb.GithubStatusSource_GITHUB_STATUS_SOURCE_PROJECT_FIELD || len(issues) == 0 {
		return nil
	}
	options, err := client.ProjectStatuses(ctx, mapping.ProjectId, mapping.ProjectFieldId)
	if err != nil {
		return s.translate(err)
	}
	byOption := map[string]string{}
	for _, entry := range mapping.Groups {
		byOption[entry.ProjectOptionId] = entry.Id
	}
	for _, issue := range issues {
		issue.StatusGroupId = byOption[options[issue.Number]]
	}
	return nil
}
