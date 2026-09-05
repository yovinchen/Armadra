import { describe, expect, it } from "vitest";
import {
  applyLanguageEditRequestSchema,
  applyLanguageEditResultSchema,
  languageServerDescriptorSchema,
  languageServiceStatusSchema,
  openLanguageSessionRequestSchema,
  openLanguageSessionResponseSchema,
  workspaceEventSchema,
} from "../src/index.js";

const sha = "a".repeat(64);

const runningServer = {
  serverId: "ruff",
  languageId: "python",
  fileExtensions: ["py", "pyi"],
  executable: "/opt/homebrew/bin/ruff",
  version: "0.16.1",
  state: "running",
  features: ["diagnostics", "formatting", "codeAction"],
  restartCount: 0,
  pid: 4242,
  startTimeUnixMs: 1788556300000,
  openDocuments: 1,
  probedAtUnixMs: 1788557000000,
};

describe("language service schemas (design §2.9)", () => {
  it("keeps every not-usable answer distinct and reasoned", () => {
    const missing = languageServerDescriptorSchema.parse({
      ...runningServer,
      serverId: "gopls",
      languageId: "go",
      executable: "",
      version: "",
      state: "unsupported",
      reason: "server_not_found",
      features: [],
      pid: null,
      startTimeUnixMs: null,
      openDocuments: 0,
    });
    expect(missing.state).toBe("unsupported");
    expect(missing.reason).toBe("server_not_found");
    // A server that is not running carries no pid at all, so nothing in the
    // resource panel can claim a process that does not exist.
    expect(missing.pid).toBeNull();

    // "unsupported" is not a free-text state: an invented one is refused.
    expect(
      languageServerDescriptorSchema.safeParse({
        ...runningServer,
        state: "maybe",
      }).success,
    ).toBe(false);
    // Nor is a feature the client would have to guess how to render.
    expect(
      languageServerDescriptorSchema.safeParse({
        ...runningServer,
        features: ["semanticTokens"],
      }).success,
    ).toBe(false);
  });

  it("lists servers even when the workspace may not run them", () => {
    const status = languageServiceStatusSchema.parse({
      status: "unavailable",
      reason: "execution_not_granted",
      executionHostId: "local",
      servers: [
        {
          ...runningServer,
          state: "unsupported",
          reason: "execution_not_granted",
        },
      ],
    });
    expect(status.servers).toHaveLength(1);
    expect(status.servers[0]?.state).toBe("unsupported");
  });

  it("carries a session open request and its answer", () => {
    const request = openLanguageSessionRequestSchema.parse({
      languageId: "python",
      clientId: "node-1",
      clientCapabilities: { textDocument: { hover: {} } },
    });
    expect(request.languageId).toBe("python");
    const answer = openLanguageSessionResponseSchema.parse({
      sessionId: "session-1",
      generation: 3,
      serverId: "ruff",
      state: "running",
      serverCapabilities: { hoverProvider: true },
    });
    expect(answer.state).toBe("running");
  });

  it("requires a real content version for every path it will overwrite", () => {
    const request = applyLanguageEditRequestSchema.parse({
      edit: { changes: { "armadra:///src/main.py": [] } },
      expectedSha256: { "src/main.py": sha },
    });
    expect(Object.keys(request.expectedSha256)).toEqual(["src/main.py"]);
    // A truncated or upper-case digest is not a version.
    expect(
      applyLanguageEditRequestSchema.safeParse({
        edit: {},
        expectedSha256: { "src/main.py": "abc" },
      }).success,
    ).toBe(false);
    // Partial application is a real outcome and both lists come back.
    const result = applyLanguageEditResultSchema.parse({
      applied: [{ path: "src/main.py", sha256: sha, size: 12 }],
      failed: [
        { path: "src/other.py", code: "conflict", message: "版本不匹配" },
      ],
    });
    expect(result.applied).toHaveLength(1);
    expect(result.failed[0]?.code).toBe("conflict");
  });

  it("adds language events to the workspace stream without disturbing it", () => {
    const session = workspaceEventSchema.parse({
      type: "language.session",
      workspaceId: "ws-1",
      sessionId: "session-1",
      serverId: "ruff",
      generation: 2,
      state: "crashed",
      reason: "server_probe_failed",
      restartCount: 3,
      progress: { percent: 40, title: "indexing" },
    });
    expect(session.type).toBe("language.session");
    const server = workspaceEventSchema.parse({
      type: "language.server",
      workspaceId: "ws-1",
      executionHostId: "local",
      server: runningServer,
    });
    expect(server.type === "language.server" && server.server.serverId).toBe(
      "ruff",
    );
    // The pre-existing events still parse: the union grew, it did not change.
    expect(
      workspaceEventSchema.parse({
        type: "board.changed",
        boardId: "b",
        updatedAt: "2026-09-06T00:00:00Z",
      }).type,
    ).toBe("board.changed");
  });
});
