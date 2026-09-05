import { expect, it } from "vitest";
import { gitMessageRequestSchema, gitMessageDraftSchema } from "./git-message";
const source = {
  expectedHead: null,
  indexDigest: "a".repeat(64),
  sourceDigest: "b".repeat(64),
  includedFiles: ["code.rs"],
  excludedFiles: [".env"],
  truncated: false,
  redacted: true,
};
it("accepts only a provider and observed source identity, never client-provided diff or credentials", () => {
  const request = {
    provider: "claude-bare",
    expectedHead: null,
    indexDigest: source.indexDigest,
  };
  expect(gitMessageRequestSchema.safeParse(request).success).toBe(true);
  for (const extra of [
    { apiKey: "secret" },
    { patch: "arbitrary diff" },
    { command: "arbitrary CLI" },
  ])
    expect(
      gitMessageRequestSchema.safeParse({ ...request, ...extra }).success,
    ).toBe(false);
});
it("keeps source exclusions and the generated message in a typed draft", () => {
  expect(
    gitMessageDraftSchema.parse({
      ...source,
      provider: "claude-bare",
      message: "改善工作区显示",
    }).excludedFiles,
  ).toEqual([".env"]);
});
