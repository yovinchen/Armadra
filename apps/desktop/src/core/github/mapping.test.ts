import { describe, expect, it } from "vitest";

import { GithubIssueState, GithubStatusSource } from "./types";
import {
  GithubIssueSchema,
  GithubLabelSchema,
  GithubStateCouplingSchema,
  GithubStatusGroupSchema,
  GithubStatusMappingSchema,
} from "./schema";
import { create } from "../contract/message";

import { applyLabelGroups, applyProjectGroups, checkMapping } from "./mapping";

function group(
  id: string,
  label: string,
  couples: GithubIssueState = GithubIssueState.UNSPECIFIED,
) {
  return create(GithubStatusGroupSchema, {
    id,
    title: id,
    label,
    couplesIssueState: couples,
  });
}

function labelMapping(...groups: ReturnType<typeof group>[]) {
  return create(GithubStatusMappingSchema, {
    source: GithubStatusSource.LABEL,
    groups,
  });
}

/** 移植自 合并前的实现。 */
describe("状态映射的校验", () => {
  it("没有映射、分组过多、来源未指定各有自己的原因码", () => {
    expect(checkMapping(undefined)).toBe("MAPPING_REQUIRED");
    expect(
      checkMapping(
        labelMapping(
          ...Array.from({ length: 33 }, (_, index) =>
            group(`g${index}`, `l${index}`),
          ),
        ),
      ),
    ).toBe("TOO_MANY_GROUPS");
    expect(
      checkMapping(create(GithubStatusMappingSchema, { groups: [] })),
    ).toBe("SOURCE_UNSPECIFIED");
  });

  it("NONE 不允许带分组或 project 标识", () => {
    expect(
      checkMapping(
        create(GithubStatusMappingSchema, {
          source: GithubStatusSource.NONE,
          groups: [group("a", "todo")],
        }),
      ),
    ).toBe("SOURCE_NONE_HAS_GROUPS");
    expect(
      checkMapping(
        create(GithubStatusMappingSchema, {
          source: GithubStatusSource.NONE,
          projectId: "P_1",
        }),
      ),
    ).toBe("SOURCE_NONE_HAS_PROJECT");
    expect(
      checkMapping(
        create(GithubStatusMappingSchema, { source: GithubStatusSource.NONE }),
      ),
    ).toBe("");
  });

  it("一个仓库只有一个主来源", () => {
    const mapping = labelMapping(group("a", "todo"));
    mapping.projectId = "P_1";
    mapping.projectFieldId = "F_1";
    expect(checkMapping(mapping)).toBe("LABEL_SOURCE_HAS_PROJECT");
    expect(
      checkMapping(
        create(GithubStatusMappingSchema, {
          source: GithubStatusSource.PROJECT_FIELD,
          groups: [group("a", "")],
        }),
      ),
    ).toBe("PROJECT_IDS_REQUIRED");
  });

  it("两个分组认领同一个标签是配置错误，不是一次冲突", () => {
    expect(
      checkMapping(labelMapping(group("a", "todo"), group("b", "todo"))),
    ).toBe("GROUP_LABEL_DUPLICATE");
    expect(
      checkMapping(labelMapping(group("a", "todo"), group("a", "doing"))),
    ).toBe("GROUP_ID_INVALID");
  });

  it("耦合必须指向已知分组，而且每个状态只能耦合一次", () => {
    const mapping = labelMapping(group("a", "todo"), group("b", "done"));
    mapping.stateGroups = [
      create(GithubStateCouplingSchema, {
        state: GithubIssueState.CLOSED,
        groupId: "missing",
      }),
    ];
    expect(checkMapping(mapping)).toBe("COUPLING_GROUP_UNKNOWN");
    mapping.stateGroups = [
      create(GithubStateCouplingSchema, {
        state: GithubIssueState.CLOSED,
        groupId: "b",
      }),
      create(GithubStateCouplingSchema, {
        state: GithubIssueState.CLOSED,
        groupId: "a",
      }),
    ];
    expect(checkMapping(mapping)).toBe("COUPLING_STATE_DUPLICATE");
    mapping.stateGroups = [
      create(GithubStateCouplingSchema, {
        state: GithubIssueState.UNSPECIFIED,
        groupId: "b",
      }),
    ];
    expect(checkMapping(mapping)).toBe("COUPLING_STATE_INVALID");
  });

  it("自反的耦合是不动点，更长的环被拒", () => {
    // a 进入时关闭 → 关闭映射回 a：合法的不动点。
    const fixed = labelMapping(
      group("a", "todo", GithubIssueState.CLOSED),
      group("b", "done"),
    );
    fixed.stateGroups = [
      create(GithubStateCouplingSchema, {
        state: GithubIssueState.CLOSED,
        groupId: "a",
      }),
    ];
    expect(checkMapping(fixed)).toBe("");

    // a 进入时关闭 → 关闭映射到 b，b 进入时打开 → 打开映射回 a：一次移动会
    // 对着远端永远来回震荡。
    const cycle = labelMapping(
      group("a", "todo", GithubIssueState.CLOSED),
      group("b", "done", GithubIssueState.OPEN),
    );
    cycle.stateGroups = [
      create(GithubStateCouplingSchema, {
        state: GithubIssueState.CLOSED,
        groupId: "b",
      }),
      create(GithubStateCouplingSchema, {
        state: GithubIssueState.OPEN,
        groupId: "a",
      }),
    ];
    expect(checkMapping(cycle)).toBe("MAPPING_CYCLE");
  });
});

describe("给 Issue 标注分组", () => {
  function issue(...labels: string[]) {
    return create(GithubIssueSchema, {
      number: 1n,
      labels: labels.map((name) => create(GithubLabelSchema, { name })),
    });
  }

  it("匹配到多个标签报成冲突，而不是挑一个赢家", () => {
    const mapping = labelMapping(group("a", "todo"), group("b", "doing"));
    const both = issue("todo", "doing");
    const one = issue("doing", "unrelated");
    applyLabelGroups(mapping, [both, one]);
    expect(both.statusConflict).toBe(true);
    expect(both.statusGroupId).toBe("");
    expect(one.statusConflict).toBe(false);
    expect(one.statusGroupId).toBe("b");
  });

  it("不在 project 上的 Issue 保持未映射，而不是被猜进一个分组", () => {
    const mapping = create(GithubStatusMappingSchema, {
      source: GithubStatusSource.PROJECT_FIELD,
      projectId: "P_1",
      projectFieldId: "F_1",
      groups: [
        create(GithubStatusGroupSchema, {
          id: "a",
          title: "a",
          projectOptionId: "opt-1",
        }),
      ],
    });
    const mapped = create(GithubIssueSchema, { number: 7n });
    const absent = create(GithubIssueSchema, { number: 8n });
    applyProjectGroups(mapping, [mapped, absent], new Map([[7, "opt-1"]]));
    expect(mapped.statusGroupId).toBe("a");
    expect(absent.statusGroupId).toBe("");
  });
});
