import { describe, expect, it } from "vitest";
import {
  agentInfoSchema,
  answerApprovalRequestSchema,
  integrationRepairReportSchema,
  integrationStateSchema,
  contextLinksRequestSchema,
  gitCommitRequestSchema,
} from "../src/index.js";

const uuid = "019ff7d1-5c48-7d75-a0ed-64b52f44e214";

describe("runtime agents API", () => {
  it("describes an agent registry entry with local detection", () => {
    const info = agentInfoSchema.parse({
      id: "codex",
      label: "Codex",
      color: "#10a37f",
      launchCmd: "codex",
      promptMode: "argv",
      capabilities: ["hooks", "resume"],
      installed: true,
    });
    expect(info.resolvedPath).toBeNull();
    expect(info.capabilities).toContain("hooks");
  });

  /**
   * Hook 与技能是一个安装单元，所以状态也只有一份
   * （docs/design/agent-integration.md §5）。
   */
  it("reads hook and skill as one integration with one revision", () => {
    const state = integrationStateSchema.parse({
      agentId: "claude",
      mode: "launch",
      hook: { installed: true, path: "/data/integration/claude/settings.json" },
      skill: {
        installed: true,
        path: "/home/u/.claude/skills/armadra/SKILL.md",
        revision: 6,
      },
      legacy: { found: [] },
      revision: 406,
      installedRevision: 406,
      launchArgs: ["--settings", "/data/integration/claude/settings.json"],
      extraKeyFromANewerRuntime: 1,
    });
    expect(state.mode).toBe("launch");
    // 修订缺省是 0 = 这一半没装，而不是「装了个 0 版」。
    expect(state.hook.revision).toBe(0);
    expect(state.stale).toBe(false);
    expect(state.launchArgs).toHaveLength(2);

    // 只有三种注入方式，第四种是打错字。
    expect(
      integrationStateSchema.safeParse({
        agentId: "codex",
        mode: "somehow",
        hook: { installed: false },
        skill: { installed: false },
        legacy: { found: [] },
        revision: 406,
      }).success,
    ).toBe(false);
    expect(
      integrationStateSchema.safeParse({
        agentId: "nope",
        mode: "file",
        hook: { installed: false },
        skill: { installed: false },
        legacy: { found: [] },
        revision: 406,
      }).success,
    ).toBe(false);
  });

  it("reports a repair by what it removed and what it left alone", () => {
    const report = integrationRepairReportSchema.parse({
      agentId: "codex",
      found: [
        {
          kind: "codex_unknown_key",
          path: "/home/u/.codex/hooks.json",
          detail: "version",
        },
      ],
      removed: ["/home/u/.codex/hooks.json: version"],
      kept: ["/home/u/.codex/hooks.json: session_start → /opt/audit.sh"],
      backup: "/home/u/.codex/hooks.json.armadra-backup-20260913101500",
      backups: ["/home/u/.codex/hooks.json.armadra-backup-20260913101500"],
    });
    expect(report.found[0]?.detail).toBe("version");
    expect(report.kept).toHaveLength(1);
    // 什么都没找到时三个列表都是空的，而不是缺字段。
    const clean = integrationRepairReportSchema.parse({ agentId: "claude" });
    expect([clean.found, clean.removed, clean.kept, clean.backups]).toEqual([
      [],
      [],
      [],
      [],
    ]);
    expect(clean.backup).toBeUndefined();
  });

  it("validates approvals, context links and commits", () => {
    expect(
      answerApprovalRequestSchema.parse({ decision: "deny" }).decision,
    ).toBe("deny");
    expect(
      answerApprovalRequestSchema.safeParse({ decision: "maybe" }).success,
    ).toBe(false);
    expect(
      contextLinksRequestSchema.parse({
        links: [{ id: uuid, title: "Codex", kind: "terminal" }],
      }).links,
    ).toHaveLength(1);
    expect(contextLinksRequestSchema.parse({}).links).toEqual([]);
    expect(gitCommitRequestSchema.parse({ message: " ship v3 " }).message).toBe(
      "ship v3",
    );
    expect(gitCommitRequestSchema.safeParse({ message: "  " }).success).toBe(
      false,
    );
  });
});
