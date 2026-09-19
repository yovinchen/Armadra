import {
  GithubIssueState,
  GithubRepositoryRef,
  GithubStatusMapping,
  GithubStatusSource,
  githubStateCoupling,
  githubStatusGroup,
  githubStatusMapping,
} from "../../api/github";

/**
 * The editable form of one repository's status mapping (Git/GitHub design §7.2).
 *
 * A draft is what the person typed; `mappingFromDraft` turns it into the
 * message the Host stores. Nothing here decides whether a configuration is
 * acceptable beyond what the API client itself refuses before sending — the
 * Host owns that judgement, including the cycle check, and pre-empting it here
 * would mean guessing a verdict the panel never observed.
 */

/** The Host stores at most this many groups per repository. */
export const MAX_STATUS_GROUPS = 32;

/** The identifier shape `MoveGithubIssue` and the Host's store both require. */
export const GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface StatusGroupDraft {
  id: string;
  title: string;
  /** Exact label name; used only by a LABEL mapping. */
  label: string;
  /** Projects v2 status option id; used only by a PROJECT_FIELD mapping. */
  optionId: string;
  /** `UNSPECIFIED` means the group sets no Issue state. */
  couplesState: GithubIssueState;
}

export interface StatusMappingDraft {
  source: GithubStatusSource;
  projectId: string;
  projectFieldId: string;
  groups: StatusGroupDraft[];
  /** Group an observed open Issue lands in; empty means no coupling. */
  openGroupId: string;
  closedGroupId: string;
}

export function emptyGroup(index: number): StatusGroupDraft {
  return {
    id: `group-${index}`,
    title: "",
    label: "",
    optionId: "",
    couplesState: GithubIssueState.UNSPECIFIED,
  };
}

/** The stored mapping as a draft; an unconfigured repository starts at NONE. */
export function draftFromMapping(
  mapping: GithubStatusMapping | undefined,
): StatusMappingDraft {
  const source = mapping?.source ?? GithubStatusSource.NONE;
  const coupled = (state: GithubIssueState) =>
    mapping?.stateGroups.find((entry) => entry.state === state)?.groupId ?? "";
  return {
    source:
      source === GithubStatusSource.UNSPECIFIED
        ? GithubStatusSource.NONE
        : source,
    projectId: mapping?.projectId ?? "",
    projectFieldId: mapping?.projectFieldId ?? "",
    groups: (mapping?.groups ?? []).map((group) => ({
      id: group.id,
      title: group.title,
      label: group.label,
      optionId: group.projectOptionId,
      couplesState: group.couplesIssueState,
    })),
    openGroupId: coupled(GithubIssueState.OPEN),
    closedGroupId: coupled(GithubIssueState.CLOSED),
  };
}

/**
 * The mistakes the API client refuses locally, named one by one.
 *
 * These are exactly the checks `putStatusMapping` performs before anything is
 * sent: a duplicate id, a missing or duplicate label or option, a coupling
 * pointing at no group. Reporting them here is not a second opinion on the
 * Host's rules — it is saying which field to fix instead of showing "the
 * request arguments are not valid" for a typo. Everything else, the cycle
 * check included, is left to the Host.
 */
export function draftProblems(draft: StatusMappingDraft): string[] {
  const problems: string[] = [];
  if (draft.source === GithubStatusSource.NONE) return problems;
  const ids = new Set<string>();
  const labels = new Set<string>();
  const options = new Set<string>();
  for (const group of draft.groups) {
    if (!GROUP_ID_PATTERN.test(group.id)) problems.push("github.mapping.badId");
    else if (ids.has(group.id)) problems.push("github.mapping.duplicateId");
    ids.add(group.id);
    if (draft.source === GithubStatusSource.LABEL) {
      if (!group.label.trim()) problems.push("github.mapping.missingLabel");
      else if (labels.has(group.label))
        problems.push("github.mapping.duplicateLabel");
      labels.add(group.label);
    }
    if (draft.source === GithubStatusSource.PROJECT_FIELD) {
      if (!group.optionId.trim()) problems.push("github.mapping.missingOption");
      else if (options.has(group.optionId))
        problems.push("github.mapping.duplicateOption");
      options.add(group.optionId);
    }
  }
  for (const coupled of [draft.openGroupId, draft.closedGroupId])
    if (coupled && !ids.has(coupled))
      problems.push("github.mapping.unknownCoupling");
  if (draft.groups.length > MAX_STATUS_GROUPS)
    problems.push("github.mapping.tooManyGroups");
  return [...new Set(problems)];
}

/**
 * The message the Host stores.
 *
 * Fields that do not belong to the chosen source are dropped rather than sent
 * empty-but-present: a label mapping carrying project identifiers describes two
 * primary sources, which is a configuration the Host has no way to apply.
 */
export function mappingFromDraft(
  draft: StatusMappingDraft,
  repository: GithubRepositoryRef,
): GithubStatusMapping {
  const label = draft.source === GithubStatusSource.LABEL;
  const project = draft.source === GithubStatusSource.PROJECT_FIELD;
  const none = draft.source === GithubStatusSource.NONE;
  const groups = none
    ? []
    : draft.groups.map((group) =>
        githubStatusGroup({
          id: group.id.trim(),
          title: group.title.trim(),
          label: label ? group.label.trim() : "",
          projectOptionId: project ? group.optionId.trim() : "",
          couplesIssueState: group.couplesState,
        }),
      );
  const ids = new Set(groups.map((group) => group.id));
  const couplings = none
    ? []
    : (
        [
          [GithubIssueState.OPEN, draft.openGroupId],
          [GithubIssueState.CLOSED, draft.closedGroupId],
        ] as const
      )
        .filter(([, groupId]) => groupId && ids.has(groupId))
        .map(([state, groupId]) => githubStateCoupling({ state, groupId }));
  return githubStatusMapping({
    repository,
    source: draft.source,
    projectId: project ? draft.projectId.trim() : "",
    projectFieldId: project ? draft.projectFieldId.trim() : "",
    groups,
    stateGroups: couplings,
  });
}

/**
 * Every configuration refusal the Host documents, in its own words.
 *
 * The Host answers `INVALID_ARGUMENT` and the reason code does not survive the
 * transport, so the panel cannot claim which one applied. It lists them as the
 * Host writes them, each with a sentence saying what it means, and leaves the
 * reader to recognise their own mistake.
 */
export const MAPPING_REASONS = [
  "MAPPING_REQUIRED",
  "SOURCE_UNSPECIFIED",
  "SOURCE_NONE_HAS_GROUPS",
  "SOURCE_NONE_HAS_PROJECT",
  "LABEL_SOURCE_HAS_PROJECT",
  "PROJECT_IDS_REQUIRED",
  "GROUPS_REQUIRED",
  "TOO_MANY_GROUPS",
  "GROUP_ID_INVALID",
  "GROUP_TITLE_INVALID",
  "GROUP_STATE_INVALID",
  "GROUP_LABEL_INVALID",
  "GROUP_LABEL_DUPLICATE",
  "GROUP_OPTION_INVALID",
  "GROUP_OPTION_DUPLICATE",
  "COUPLING_STATE_INVALID",
  "COUPLING_GROUP_UNKNOWN",
  "COUPLING_STATE_DUPLICATE",
  "MAPPING_CYCLE",
] as const;

export function mappingReasonKey(code: string): string {
  return `github.mappingReason.${code}`;
}

export function statusSourceKey(source: GithubStatusSource): string {
  switch (source) {
    case GithubStatusSource.NONE:
      return "github.mapping.sourceNone";
    case GithubStatusSource.LABEL:
      return "github.mapping.sourceLabel";
    case GithubStatusSource.PROJECT_FIELD:
      return "github.mapping.sourceProject";
    default:
      return "github.mapping.sourceUnspecified";
  }
}
