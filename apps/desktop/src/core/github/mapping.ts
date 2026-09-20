/**
 * 状态映射：一个仓库，一个主来源，以及面板把 Issue 归在哪些分组下（设计 §7.2）。
 * 移植自 合并前的实现。
 *
 * 两个方向的耦合都可配——一个分组进入时可以设置 Issue 状态，观察到的状态也可以
 * 选出一个分组——合起来可以描述出一个环。一个环会让一次移动对着远端永远来回震荡，
 * 所以 {@link validateMapping} 在存任何东西之前先拒绝它。
 */

import {
  GithubIssueState,
  GithubStatusSource,
  type GithubIssue,
  type GithubStatusGroup,
  type GithubStatusMapping,
} from "./types";

import { githubError } from "./errors";

export const MAX_GROUPS = 32;

const GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * 完整校验一份配置。每一次拒绝都是一个**稳定的原因码**，因为这些是人要去找出来
 * 并改掉的配置错误，不是传输失败。
 *
 * 返回原因码；`""` 表示通过。不通过时同时抛 `invalid`，调用方不必两头判断。
 */
export function validateMapping(
  mapping: GithubStatusMapping | undefined,
): string {
  const reason = checkMapping(mapping);
  if (reason !== "") throw githubError("invalid");
  return reason;
}

/** 只判不抛的那一半，给「想知道原因码」的调用方和测试。 */
export function checkMapping(mapping: GithubStatusMapping | undefined): string {
  if (mapping === undefined) return "MAPPING_REQUIRED";
  if (mapping.groups.length > MAX_GROUPS) return "TOO_MANY_GROUPS";
  switch (mapping.source) {
    case GithubStatusSource.NONE:
      if (mapping.groups.length > 0 || mapping.stateGroups.length > 0) {
        return "SOURCE_NONE_HAS_GROUPS";
      }
      if (mapping.projectId !== "" || mapping.projectFieldId !== "") {
        return "SOURCE_NONE_HAS_PROJECT";
      }
      return "";
    case GithubStatusSource.LABEL:
      // 一个仓库只有一个主来源；在标签映射上带着 project 标识会让这件事含糊。
      if (mapping.projectId !== "" || mapping.projectFieldId !== "") {
        return "LABEL_SOURCE_HAS_PROJECT";
      }
      break;
    case GithubStatusSource.PROJECT_FIELD:
      if (mapping.projectId === "" || mapping.projectFieldId === "") {
        return "PROJECT_IDS_REQUIRED";
      }
      break;
    default:
      return "SOURCE_UNSPECIFIED";
  }
  if (mapping.groups.length === 0) return "GROUPS_REQUIRED";
  const ids = new Set<string>();
  const labels = new Set<string>();
  const options = new Set<string>();
  for (const group of mapping.groups) {
    if (!GROUP_PATTERN.test(group.id) || ids.has(group.id)) {
      return "GROUP_ID_INVALID";
    }
    ids.add(group.id);
    if (group.title === "" || Buffer.byteLength(group.title, "utf8") > 128) {
      return "GROUP_TITLE_INVALID";
    }
    if (
      ![
        GithubIssueState.UNSPECIFIED,
        GithubIssueState.OPEN,
        GithubIssueState.CLOSED,
      ].includes(group.couplesIssueState)
    ) {
      return "GROUP_STATE_INVALID";
    }
    if (mapping.source === GithubStatusSource.LABEL) {
      if (
        group.label === "" ||
        Buffer.byteLength(group.label, "utf8") > 128 ||
        group.projectOptionId !== ""
      ) {
        return "GROUP_LABEL_INVALID";
      }
      // 两个分组认领同一个标签会让一个 Issue 的分组**每次**都是歧义的，而不只是
      // 冲突时。
      if (labels.has(group.label)) return "GROUP_LABEL_DUPLICATE";
      labels.add(group.label);
    } else {
      if (
        group.projectOptionId === "" ||
        Buffer.byteLength(group.projectOptionId, "utf8") > 256
      ) {
        return "GROUP_OPTION_INVALID";
      }
      if (options.has(group.projectOptionId)) return "GROUP_OPTION_DUPLICATE";
      options.add(group.projectOptionId);
    }
  }
  const states = new Map<GithubIssueState, string>();
  for (const coupling of mapping.stateGroups) {
    if (
      coupling.state !== GithubIssueState.OPEN &&
      coupling.state !== GithubIssueState.CLOSED
    ) {
      return "COUPLING_STATE_INVALID";
    }
    if (!ids.has(coupling.groupId)) return "COUPLING_GROUP_UNKNOWN";
    if (states.has(coupling.state)) return "COUPLING_STATE_DUPLICATE";
    states.set(coupling.state, coupling.groupId);
  }
  return detectCycle(mapping.groups, states);
}

/**
 * 沿着「分组 → 耦合的 Issue 状态 → 那个状态的分组」走一遍。映射回自己的分组是个
 * 不动点，没问题；任何更长的环意味着进入一个分组会把 Issue 移到另一个再移回来，
 * 所以被拒。
 */
export function detectCycle(
  groups: readonly GithubStatusGroup[],
  states: ReadonlyMap<GithubIssueState, string>,
): string {
  const next = new Map<string, string>();
  for (const group of groups) {
    if (group.couplesIssueState === GithubIssueState.UNSPECIFIED) continue;
    const target = states.get(group.couplesIssueState);
    if (target === undefined || target === group.id) continue;
    next.set(group.id, target);
  }
  const UNVISITED = 0;
  const ON_PATH = 1;
  const SETTLED = 2;
  const mark = new Map<string, number>();
  for (const group of groups) {
    if ((mark.get(group.id) ?? UNVISITED) !== UNVISITED) continue;
    let node = group.id;
    const path: string[] = [];
    for (;;) {
      const state = mark.get(node) ?? UNVISITED;
      if (state === ON_PATH) return "MAPPING_CYCLE";
      if (state === SETTLED) break;
      mark.set(node, ON_PATH);
      path.push(node);
      const target = next.get(node);
      if (target === undefined) break;
      node = target;
    }
    for (const visited of path) mark.set(visited, SETTLED);
  }
  return "";
}

/** 按标识找一个分组。 */
export function findGroup(
  mapping: GithubStatusMapping,
  id: string,
): GithubStatusGroup | undefined {
  return mapping.groups.find((candidate) => candidate.id === id);
}

/**
 * 给 issue 标注它的标签把它放进了哪个分组。
 *
 * 匹配到多于一个会被报成**冲突**而不是挑一个赢家，因为错的是配置，不是这个 Issue。
 */
export function applyLabelGroups(
  mapping: GithubStatusMapping,
  issues: readonly GithubIssue[],
): void {
  if (mapping.source !== GithubStatusSource.LABEL) return;
  const byLabel = new Map<string, string>();
  for (const entry of mapping.groups) byLabel.set(entry.label, entry.id);
  for (const issue of issues) {
    let matched = "";
    for (const label of issue.labels) {
      const id = byLabel.get(label.name);
      if (id === undefined) continue;
      if (matched !== "" && matched !== id) {
        issue.statusConflict = true;
        matched = "";
        break;
      }
      matched = id;
    }
    issue.statusGroupId = matched;
  }
}

/**
 * 用一个 Projects v2 的 Status 字段标注 issue。
 *
 * project 每页只读一次；不在这个 project 上的 Issue 保持未映射，而不是被猜进一
 * 个分组。
 */
export function applyProjectGroups(
  mapping: GithubStatusMapping,
  issues: readonly GithubIssue[],
  optionsByNumber: ReadonlyMap<number, string>,
): void {
  if (mapping.source !== GithubStatusSource.PROJECT_FIELD) return;
  const byOption = new Map<string, string>();
  for (const entry of mapping.groups) {
    byOption.set(entry.projectOptionId, entry.id);
  }
  for (const issue of issues) {
    const option = optionsByNumber.get(Number(issue.number));
    issue.statusGroupId =
      option === undefined ? "" : (byOption.get(option) ?? "");
  }
}
