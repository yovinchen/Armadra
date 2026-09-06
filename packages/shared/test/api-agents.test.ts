import { describe, expect, it } from "vitest";
import {
  agentInfoSchema,
  answerApprovalRequestSchema,
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
