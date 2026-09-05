package githubhost

import (
	"errors"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

func labelGroup(id, label string, couples pb.GithubIssueState) *pb.GithubStatusGroup {
	return &pb.GithubStatusGroup{Id: id, Title: id, Label: label, CouplesIssueState: couples}
}

// Both coupling directions together can describe a loop: entering one group
// would set a state that selects another group, which sets a state that selects
// the first. That would oscillate against the remote forever, so it is refused
// before anything is stored.
func TestMappingCyclesAreRefused(t *testing.T) {
	cyclic := &pb.GithubStatusMapping{
		Source: pb.GithubStatusSource_GITHUB_STATUS_SOURCE_LABEL,
		Groups: []*pb.GithubStatusGroup{
			labelGroup("done", "status/done", pb.GithubIssueState_GITHUB_ISSUE_STATE_CLOSED),
			labelGroup("todo", "status/todo", pb.GithubIssueState_GITHUB_ISSUE_STATE_OPEN),
		},
		StateGroups: []*pb.GithubStateCoupling{
			{State: pb.GithubIssueState_GITHUB_ISSUE_STATE_CLOSED, GroupId: "todo"},
			{State: pb.GithubIssueState_GITHUB_ISSUE_STATE_OPEN, GroupId: "done"},
		},
	}
	reason, err := ValidateMapping(cyclic)
	if !errors.Is(err, ErrInvalid) || reason != "MAPPING_CYCLE" {
		t.Fatalf("a cyclic mapping was accepted (%s, %v)", reason, err)
	}
	// A group that maps back to itself is a fixed point, not a loop: entering
	// "done" closes the Issue, and a closed Issue is in "done". That is
	// consistent and must stay configurable.
	fixed := &pb.GithubStatusMapping{
		Source: pb.GithubStatusSource_GITHUB_STATUS_SOURCE_LABEL,
		Groups: []*pb.GithubStatusGroup{
			labelGroup("done", "status/done", pb.GithubIssueState_GITHUB_ISSUE_STATE_CLOSED),
			labelGroup("todo", "status/todo", pb.GithubIssueState_GITHUB_ISSUE_STATE_UNSPECIFIED),
		},
		StateGroups: []*pb.GithubStateCoupling{{State: pb.GithubIssueState_GITHUB_ISSUE_STATE_CLOSED, GroupId: "done"}},
	}
	if reason, err = ValidateMapping(fixed); err != nil {
		t.Fatalf("a fixed point was refused (%s, %v)", reason, err)
	}
	// A longer cycle through three groups must be caught too.
	long := &pb.GithubStatusMapping{
		Source: pb.GithubStatusSource_GITHUB_STATUS_SOURCE_LABEL,
		Groups: []*pb.GithubStatusGroup{
			labelGroup("a", "status/a", pb.GithubIssueState_GITHUB_ISSUE_STATE_OPEN),
			labelGroup("b", "status/b", pb.GithubIssueState_GITHUB_ISSUE_STATE_CLOSED),
			labelGroup("c", "status/c", pb.GithubIssueState_GITHUB_ISSUE_STATE_UNSPECIFIED),
		},
		StateGroups: []*pb.GithubStateCoupling{
			{State: pb.GithubIssueState_GITHUB_ISSUE_STATE_OPEN, GroupId: "b"},
			{State: pb.GithubIssueState_GITHUB_ISSUE_STATE_CLOSED, GroupId: "a"},
		},
	}
	if reason, err = ValidateMapping(long); !errors.Is(err, ErrInvalid) || reason != "MAPPING_CYCLE" {
		t.Fatalf("a two-step cycle was accepted (%s, %v)", reason, err)
	}
}

// Each configuration mistake gets its own stable reason, because a user has to
// find and fix it rather than retry.
func TestMappingValidationNamesTheMistake(t *testing.T) {
	label := func(groups ...*pb.GithubStatusGroup) *pb.GithubStatusMapping {
		return &pb.GithubStatusMapping{Source: pb.GithubStatusSource_GITHUB_STATUS_SOURCE_LABEL, Groups: groups}
	}
	cases := map[string]*pb.GithubStatusMapping{
		"MAPPING_REQUIRED":      nil,
		"SOURCE_UNSPECIFIED":    {Source: pb.GithubStatusSource_GITHUB_STATUS_SOURCE_UNSPECIFIED},
		"GROUPS_REQUIRED":       label(),
		"GROUP_LABEL_DUPLICATE": label(labelGroup("a", "same", 0), labelGroup("b", "same", 0)),
		"GROUP_ID_INVALID":      label(labelGroup("a", "x", 0), labelGroup("a", "y", 0)),
		"GROUP_LABEL_INVALID":   label(&pb.GithubStatusGroup{Id: "a", Title: "a"}),
		"LABEL_SOURCE_HAS_PROJECT": {
			Source:    pb.GithubStatusSource_GITHUB_STATUS_SOURCE_LABEL,
			ProjectId: "PVT_1",
			Groups:    []*pb.GithubStatusGroup{labelGroup("a", "x", 0)},
		},
		"PROJECT_IDS_REQUIRED": {
			Source: pb.GithubStatusSource_GITHUB_STATUS_SOURCE_PROJECT_FIELD,
			Groups: []*pb.GithubStatusGroup{{Id: "a", Title: "a", ProjectOptionId: "opt"}},
		},
		"SOURCE_NONE_HAS_GROUPS": {
			Source: pb.GithubStatusSource_GITHUB_STATUS_SOURCE_NONE,
			Groups: []*pb.GithubStatusGroup{labelGroup("a", "x", 0)},
		},
		"COUPLING_GROUP_UNKNOWN": {
			Source:      pb.GithubStatusSource_GITHUB_STATUS_SOURCE_LABEL,
			Groups:      []*pb.GithubStatusGroup{labelGroup("a", "x", 0)},
			StateGroups: []*pb.GithubStateCoupling{{State: pb.GithubIssueState_GITHUB_ISSUE_STATE_OPEN, GroupId: "missing"}},
		},
		"COUPLING_STATE_DUPLICATE": {
			Source: pb.GithubStatusSource_GITHUB_STATUS_SOURCE_LABEL,
			Groups: []*pb.GithubStatusGroup{labelGroup("a", "x", 0)},
			StateGroups: []*pb.GithubStateCoupling{
				{State: pb.GithubIssueState_GITHUB_ISSUE_STATE_OPEN, GroupId: "a"},
				{State: pb.GithubIssueState_GITHUB_ISSUE_STATE_OPEN, GroupId: "a"},
			},
		},
	}
	for expected, mapping := range cases {
		reason, err := ValidateMapping(mapping)
		if !errors.Is(err, ErrInvalid) || reason != expected {
			t.Fatalf("expected %s, got %s (%v)", expected, reason, err)
		}
	}
	// A configuration with no source at all is valid: not configured is a
	// normal state, and the panel shows Issues ungrouped.
	if reason, err := ValidateMapping(&pb.GithubStatusMapping{Source: pb.GithubStatusSource_GITHUB_STATUS_SOURCE_NONE}); err != nil {
		t.Fatalf("an unconfigured mapping was refused (%s, %v)", reason, err)
	}
}

// Two configured labels on one Issue make its group ambiguous. The panel is
// told that, rather than being handed an arbitrary winner.
func TestConflictingLabelsAreReportedRatherThanResolved(t *testing.T) {
	mapping := &pb.GithubStatusMapping{
		Source: pb.GithubStatusSource_GITHUB_STATUS_SOURCE_LABEL,
		Groups: []*pb.GithubStatusGroup{labelGroup("todo", "status/todo", 0), labelGroup("done", "status/done", 0)},
	}
	both := &pb.GithubIssue{Number: 1, Labels: []*pb.GithubLabel{{Name: "status/todo"}, {Name: "status/done"}, {Name: "bug"}}}
	one := &pb.GithubIssue{Number: 2, Labels: []*pb.GithubLabel{{Name: "status/done"}, {Name: "bug"}}}
	none := &pb.GithubIssue{Number: 3, Labels: []*pb.GithubLabel{{Name: "bug"}}}
	applyLabelGroups(mapping, []*pb.GithubIssue{both, one, none})
	if !both.StatusConflict || both.StatusGroupId != "" {
		t.Fatalf("an ambiguous Issue reported group %q, conflict %v", both.StatusGroupId, both.StatusConflict)
	}
	if one.StatusGroupId != "done" || one.StatusConflict {
		t.Fatalf("a single match reported %q", one.StatusGroupId)
	}
	if none.StatusGroupId != "" || none.StatusConflict {
		t.Fatal("an unmapped Issue must be unmapped, not conflicted")
	}
}
