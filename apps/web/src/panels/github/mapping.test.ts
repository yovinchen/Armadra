import { describe, expect, it } from "vitest";

import {
  draftFromMapping,
  draftProblems,
  emptyGroup,
  mappingFromDraft,
  type StatusMappingDraft,
} from "./mapping";
import {
  GithubIssueState,
  GithubStatusSource,
  githubRepositoryRef,
  githubStatusGroup,
  githubStatusMapping,
} from "../../api/github";

const repository = githubRepositoryRef({
  owner: "armadra",
  name: "armadra",
  apiBase: "https://api.github.com",
  host: "github.com",
});

function draft(patch: Partial<StatusMappingDraft> = {}): StatusMappingDraft {
  return {
    source: GithubStatusSource.LABEL,
    projectId: "",
    projectFieldId: "",
    groups: [
      { ...emptyGroup(1), title: "Todo", label: "todo" },
      { ...emptyGroup(2), title: "Done", label: "done" },
    ],
    openGroupId: "",
    closedGroupId: "",
    ...patch,
  };
}

describe("status mapping drafts", () => {
  it("names the duplicate label instead of sending an ambiguous mapping", () => {
    const groups = draft().groups.map((group) => ({ ...group, label: "bug" }));
    expect(draftProblems(draft({ groups }))).toContain(
      "github.mapping.duplicateLabel",
    );
  });

  it("names a duplicate id and a duplicate status option", () => {
    const same = draft().groups.map((group) => ({ ...group, id: "todo" }));
    expect(draftProblems(draft({ groups: same }))).toContain(
      "github.mapping.duplicateId",
    );
    const options = draft().groups.map((group) => ({
      ...group,
      optionId: "opt",
    }));
    expect(
      draftProblems(
        draft({ source: GithubStatusSource.PROJECT_FIELD, groups: options }),
      ),
    ).toContain("github.mapping.duplicateOption");
  });

  it("accepts a mapping the Host client would send unchanged", () => {
    expect(draftProblems(draft())).toEqual([]);
    expect(draftProblems(draft({ source: GithubStatusSource.NONE }))).toEqual(
      [],
    );
  });

  it("leaves the cycle check to the Host", () => {
    // Both directions configured: the Host decides whether it loops.
    const groups = draft().groups.map((group, index) => ({
      ...group,
      couplesState:
        index === 0 ? GithubIssueState.CLOSED : GithubIssueState.OPEN,
    }));
    expect(
      draftProblems(
        draft({ groups, openGroupId: "group-1", closedGroupId: "group-2" }),
      ),
    ).toEqual([]);
  });

  it("sends only the fields the chosen source owns", () => {
    const label = mappingFromDraft(
      draft({ projectId: "PVT_1", projectFieldId: "PVTF_1" }),
      repository,
    );
    // A label mapping carrying project identifiers would name two primary
    // sources, so they never leave the editor.
    expect(label.projectId).toBe("");
    expect(label.projectFieldId).toBe("");
    expect(label.groups.map((group) => group.projectOptionId)).toEqual([
      "",
      "",
    ]);

    const project = mappingFromDraft(
      draft({
        source: GithubStatusSource.PROJECT_FIELD,
        projectId: "PVT_1",
        projectFieldId: "PVTF_1",
        groups: draft().groups.map((group, index) => ({
          ...group,
          optionId: `opt-${index}`,
        })),
      }),
      repository,
    );
    expect(project.projectId).toBe("PVT_1");
    expect(project.groups.map((group) => group.label)).toEqual(["", ""]);
  });

  it("drops a coupling whose group is gone rather than sending it", () => {
    const built = mappingFromDraft(
      draft({ openGroupId: "group-1", closedGroupId: "removed" }),
      repository,
    );
    expect(built.stateGroups.map((entry) => entry.groupId)).toEqual([
      "group-1",
    ]);
  });

  it("reads a stored mapping back into the same draft", () => {
    const stored = githubStatusMapping({
      repository,
      source: GithubStatusSource.LABEL,
      groups: [githubStatusGroup({ id: "todo", title: "Todo", label: "todo" })],
      stateGroups: [{ state: GithubIssueState.CLOSED, groupId: "todo" }],
      revision: 3n,
    });
    const read = draftFromMapping(stored);
    expect(read.source).toBe(GithubStatusSource.LABEL);
    expect(read.closedGroupId).toBe("todo");
    expect(read.openGroupId).toBe("");
    expect(draftFromMapping(undefined).source).toBe(GithubStatusSource.NONE);
  });
});
