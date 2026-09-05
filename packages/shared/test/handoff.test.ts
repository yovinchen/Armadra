import { describe, expect, it } from "vitest";
import {
  handoffBundleSchema,
  handoffListSchema,
  handoffPrepareSchema,
  handoffViewSchema,
} from "../src/handoff.js";

/**
 * The fixture below is a verbatim `POST /api/workspaces/{id}/handoffs`
 * response captured from a running Rust runtime. Keeping the real payload here
 * is the point of the test: the schema exists to refuse a bundle the runtime
 * did not produce, so it has to be checked against what the runtime actually
 * sends rather than against a hand-written guess.
 */
const view = () => ({
  bundle: {
    version: 1,
    handoffId: "01a07198-14d9-79e1-b149-277f9ecbc561",
    workspaceId: "01a07198-121b-75f1-9605-c51cd3309258",
    createdAt: "2026-09-05T12:43:07.353627+00:00",
    source: {
      nodeId: "01a07198-1220-7f83-813b-72bd138ccc80",
      nodeTitle: "claude",
      sessionId: "01a07198-1220-7f83-813b-72d189a6c343",
      generation: 1,
      agentId: "claude",
      provider: "claude",
      providerSessionId: "provider-claude",
      modelId: null,
      accountId: null,
      executionHost: "local-runtime",
      workingDirectory: "/tmp/project",
    },
    target: {
      nodeId: "01a07198-1220-7f83-813b-72c2b57f0aa2",
      nodeTitle: "codex",
      sessionId: "01a07198-1220-7f83-813b-72ee5787298e",
      generation: 1,
      agentId: "codex",
      provider: "codex",
      providerSessionId: "provider-codex",
      modelId: null,
      accountId: null,
      executionHost: "local-runtime",
      workingDirectory: "/tmp/project",
    },
    cutoff: {
      kind: "unavailable",
      reference: null,
      sourceRevision: null,
      sha256: null,
      sourceUpdatedAt: "2026-09-05T12:43:06.656420+00:00",
    },
    sections: {
      goal: "Continue the reviewed work",
      constraints: "Keep the source running",
      completed: "",
      pending: "",
      decisions: "",
      toolSummary: "",
    },
    transcriptExcerpt: "",
    summaryMethod: "editableTemplateAndExcerpt",
    trust: "peerDataNotSystemInstructions",
    sourcePreserved: true,
    files: [],
    git: {
      headOid: null,
      indexDigest: null,
      worktreeDigest: null,
      repositoryId: null,
      worktreeId: null,
      status: "unavailable",
      worktreeDigestBasis: "statusSummary",
    },
    attachments: [],
    budget: {
      byteLimit: 8192,
      usedBytes: 1845,
      tokenEstimate: null,
      capacityTokens: null,
      availableTokens: null,
      reservedTokens: null,
      truncated: false,
      omitted: [
        "referencesAreLiveFilesNotCopiedCode",
        "tokenBudgetUnavailable",
        "noGenerationBoundTranscript",
        "gitFingerprintUnavailable",
        "worktreeDigestCoversStatusSummaryOnly",
      ],
    },
  },
  digest: "f22b9ae0342c94f65df959c519a6199dbf1e78ab4e310912321084a2203ac0f7",
  state: "prepared",
  mailboxId: null,
  traceId: null,
  errorCode: null,
  acceptedAt: null,
  updatedAt: "2026-09-05T12:43:07.353627+00:00",
  sourceHasNewActivity: false,
});

describe("handoff bundle contract", () => {
  it("accepts the runtime's own prepared bundle unchanged", () => {
    const parsed = handoffViewSchema.parse(view());
    expect(parsed.bundle.handoffId).toBe(view().bundle.handoffId);
    // The runtime emits UUIDv7 ids; the schema must not reject them.
    expect(parsed.bundle.source.nodeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(handoffListSchema.parse([view()])).toHaveLength(1);
  });

  it("keeps the trust marker and the untouched source as part of the shape", () => {
    // A bundle that claims to be a system instruction, or that claims the
    // source session was consumed, is not a bundle this app produced.
    expect(() =>
      handoffBundleSchema.parse({
        ...view().bundle,
        trust: "systemInstructions",
      }),
    ).toThrow();
    expect(() =>
      handoffBundleSchema.parse({ ...view().bundle, sourcePreserved: false }),
    ).toThrow();
    expect(() =>
      handoffBundleSchema.parse({
        ...view().bundle,
        attachments: [{ path: "secret" }],
      }),
    ).toThrow();
  });

  it("refuses a delivery state the runtime never reports", () => {
    expect(
      handoffViewSchema.parse({ ...view(), state: "unknownOutcome" }).state,
    ).toBe("unknownOutcome");
    expect(() =>
      handoffViewSchema.parse({ ...view(), state: "delivered" }),
    ).toThrow();
  });

  it("mirrors the runtime's budget tiers and template limits on the request", () => {
    const request = {
      sourceNodeId: view().bundle.source.nodeId,
      sourceSessionId: view().bundle.source.sessionId,
      sourceGeneration: 1,
      targetNodeId: view().bundle.target.nodeId,
      targetSessionId: view().bundle.target.sessionId,
      targetGeneration: 1,
      sections: { goal: "Continue" },
      byteBudget: 16384,
    };
    const parsed = handoffPrepareSchema.parse(request);
    expect(parsed.filePaths).toEqual([]);
    expect(parsed.includeTranscript).toBe(true);
    expect(parsed.sections.toolSummary).toBe("");
    // Only the three tiers the runtime accepts, and a goal is required: an
    // empty template would hand the target nothing to act on.
    expect(() =>
      handoffPrepareSchema.parse({ ...request, byteBudget: 4096 }),
    ).toThrow();
    expect(() =>
      handoffPrepareSchema.parse({ ...request, sections: { goal: "" } }),
    ).toThrow();
    expect(() =>
      handoffPrepareSchema.parse({
        ...request,
        filePaths: Array.from({ length: 33 }, (_, index) => `f${index}.ts`),
      }),
    ).toThrow();
  });
});
