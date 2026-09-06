import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import {
  LanguageAckSchema,
  LanguageApplyEditRequestSchema,
  LanguageCapabilitiesSchema,
  LanguageControlAction,
  LanguageControlRequestSchema,
  LanguageFeature,
  LanguageFrameSchema,
  LanguageMessageKind,
  LanguageServerDescriptorSchema,
  LanguageServerState,
  LanguageSessionSchema,
  PlatformComponentKind,
  WorkerRequestSchema,
  WorkerResponseSchema,
} from "../src/index.js";

function fixture(name: string): Uint8Array {
  const hex = readFileSync(
    new URL(`../../../proto/fixtures/${name}.hex`, import.meta.url),
    "utf8",
  ).trim();
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function check<T extends DescMessage>(
  name: string,
  schema: T,
  init: MessageInitShape<T>,
) {
  const expected = create(schema, init);
  const wire = fixture(name);
  expect(fromBinary(schema, wire)).toEqual(expected);
  expect(toBinary(schema, expected)).toEqual(wire);
}

const maxUint64 = 18_446_744_073_709_551_615n;
const encoder = new TextEncoder();

describe("language service wire contract", () => {
  it("keeps a probe failure distinct from a running server", () => {
    check("language_capabilities", LanguageCapabilitiesSchema, {
      executionHostId: "local",
      servers: [
        {
          serverId: "ruff",
          languageId: "python",
          fileExtensions: ["py", "pyi"],
          executable: "/opt/homebrew/bin/ruff",
          version: "0.16.1",
          state: LanguageServerState.RUNNING,
          features: [
            LanguageFeature.DIAGNOSTICS,
            LanguageFeature.FORMATTING,
            LanguageFeature.CODE_ACTION,
          ],
          restartCount: 2,
          pid: 4242n,
          startTimeUnixMs: 1788556300000n,
          openDocuments: 3,
          probedAtUnixMs: 1788557000000n,
        },
        {
          serverId: "rust-analyzer",
          languageId: "rust",
          fileExtensions: ["rs"],
          state: LanguageServerState.UNSUPPORTED,
          reason: "server_probe_failed",
          probedAtUnixMs: 1788557000000n,
        },
      ],
      maxDocumentBytes: 1048576,
      maxSessions: 32,
      maxMessageBytes: 983040,
    });
    check("language_session", LanguageSessionSchema, {
      sessionId: "会话-1",
      serverId: "ruff",
      generation: maxUint64,
      state: LanguageServerState.RUNNING,
      serverCapabilitiesJson: encoder.encode(`{"hoverProvider":true}`),
    });
  });

  it("relays a JSON-RPC payload without re-encoding it", () => {
    check("language_frame_message", LanguageFrameSchema, {
      linkEpoch: "epoch-1",
      payload: {
        case: "message",
        value: {
          sessionId: "会话-1",
          sequence: 9007199254740993n,
          kind: LanguageMessageKind.RESPONSE,
          method: "textDocument/hover",
          requestId: "7:client-1",
          payloadJson: encoder.encode(
            `{"jsonrpc":"2.0","id":7,"result":{"contents":"注释 📘","uri":"armadra:///源码/主.py"}}`,
          ),
        },
      },
    });
    check("language_frame_ack", LanguageFrameSchema, {
      linkEpoch: "epoch-1",
      payload: {
        case: "ack",
        value: {
          sessionId: "会话-1",
          receivedThrough: maxUint64,
          availableCreditBytes: 4194304,
        },
      },
    });
  });

  it("treats an absent expected version as create-only", () => {
    check("language_apply_edit", LanguageApplyEditRequestSchema, {
      rootId: "root-1",
      sessionId: "会话-1",
      workspaceEditJson: encoder.encode(
        `{"changes":{"armadra:///src/主.py":[]}}`,
      ),
      expectedSha256: {
        "src/主.py":
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      },
      allowWrite: true,
    });
    const decoded = fromBinary(
      LanguageApplyEditRequestSchema,
      fixture("language_apply_edit"),
    );
    // Absence is the statement. An empty string would be a version, and a
    // version is checked before the write; absence means "must not exist".
    expect(Object.keys(decoded.expectedSha256)).toEqual(["src/主.py"]);
    expect(decoded.expectedSha256["src/新.py"]).toBeUndefined();
  });

  it("does not let an absent pid decode as zero", () => {
    const stopped = toBinary(
      LanguageServerDescriptorSchema,
      create(LanguageServerDescriptorSchema, { serverId: "ruff" }),
    );
    const measured = toBinary(
      LanguageServerDescriptorSchema,
      create(LanguageServerDescriptorSchema, { serverId: "ruff", pid: 0n }),
    );
    expect(stopped.length).not.toEqual(measured.length);
    expect(
      fromBinary(LanguageServerDescriptorSchema, stopped).pid,
    ).toBeUndefined();
  });

  it("reserves 0 for UNSPECIFIED in every language enumeration", () => {
    expect(LanguageServerState.UNSPECIFIED).toBe(0);
    expect(LanguageFeature.UNSPECIFIED).toBe(0);
    expect(LanguageMessageKind.UNSPECIFIED).toBe(0);
    expect(LanguageControlAction.UNSPECIFIED).toBe(0);
    expect(PlatformComponentKind.LANGUAGE_SERVER).toBe(6);
  });

  it("keeps stop and restart apart and defaults to neither", () => {
    check("language_control", LanguageControlRequestSchema, {
      rootId: "root-1",
      workspaceId: "ws-1",
      serverId: "ruff",
      action: LanguageControlAction.RESTART,
      allowExecute: true,
    });
    // An empty request is a caller that never said what it wanted. Reading it
    // as "restart" would start a process nobody asked for.
    const empty = create(LanguageControlRequestSchema, { serverId: "ruff" });
    const decoded = fromBinary(
      LanguageControlRequestSchema,
      toBinary(LanguageControlRequestSchema, empty),
    );
    expect(decoded.action).toBe(LanguageControlAction.UNSPECIFIED);
  });

  it("adds the Worker language branches without disturbing the others", () => {
    const request = create(WorkerRequestSchema, {
      requestId: "language-1",
      action: {
        case: "languageCapabilities",
        value: { rootId: "root-1", refresh: true },
      },
    });
    const decoded = fromBinary(
      WorkerRequestSchema,
      toBinary(WorkerRequestSchema, request),
    );
    expect(decoded.action.case).toBe("languageCapabilities");
    const response = create(WorkerResponseSchema, {
      requestId: "language-1",
      result: {
        case: "languageSession",
        value: { sessionId: "会话-1", state: LanguageServerState.STOPPED },
      },
    });
    const back = fromBinary(
      WorkerResponseSchema,
      toBinary(WorkerResponseSchema, response),
    );
    expect(back.result.case).toBe("languageSession");
    expect(
      back.result.case === "languageSession" && back.result.value.state,
    ).toBe(LanguageServerState.STOPPED);
  });

  it("carries an ack window big enough for the design's credit budget", () => {
    const ack = create(LanguageAckSchema, {
      sessionId: "会话-1",
      availableCreditBytes: 4 * 1024 * 1024,
    });
    expect(ack.availableCreditBytes).toBe(4194304);
  });
});
