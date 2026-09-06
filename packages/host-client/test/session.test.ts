import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  CloseSessionResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  GetSessionContextUsageResponseSchema,
  GetSessionRequestSchema,
  GetSessionResponseSchema,
  ListSessionsResponseSchema,
  RecycleSessionResponseSchema,
  SessionAttachState,
  SessionKind,
  SessionSchema,
  SessionStatus,
  StartSessionRequestSchema,
  StartSessionResponseSchema,
  TerminateSessionRequestSchema,
  TerminateSessionResponseSchema,
  TerminationIntent,
} from "@armadra/protocol";
import { HostSessionClient } from "../src/session.js";
import { HostCanvasError } from "../src/canvas.js";
import type { HostAuthenticatedTransport } from "../src/automation.js";

const hostId = "1".repeat(32);
const workspaceId = "workspace-1";
/** 2^53 + 1: the first integer a JavaScript number cannot represent. */
const beyondDouble = 9_007_199_254_740_993n;

interface Sent {
  service: string;
  action: string;
  body: Uint8Array;
  mutation: boolean;
}

function client(reply: (call: Sent) => Uint8Array) {
  const calls: Sent[] = [];
  const session: HostAuthenticatedTransport = {
    send: (service, action, body, mutation) => {
      const call = { service, action, body, mutation };
      calls.push(call);
      return Promise.resolve(reply(call));
    },
  };
  return {
    api: new HostSessionClient({ session, hostId, workspaceId }),
    calls,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return create(SessionSchema, {
    sessionId: "session-one",
    workspaceId,
    sessionKey: "node-one",
    ownerNodeId: "node-one",
    kind: SessionKind.TERMINAL,
    status: SessionStatus.RUNNING,
    attachState: SessionAttachState.DETACHED,
    terminationIntent: TerminationIntent.NONE,
    backendKind: "tmux",
    generation: 3n,
    launch: { shell: "/bin/zsh", workingDirectory: "/项目/一" },
    createdAtUnixMs: 1_788_557_000_000n,
    updatedAtUnixMs: 1_788_557_900_000n,
    revision: 1n,
    ...overrides,
  });
}

describe("HostSessionClient", () => {
  it("reads a session and keeps its revision exact past 2^53", async () => {
    const { api, calls } = client(() =>
      toBinary(
        GetSessionResponseSchema,
        create(GetSessionResponseSchema, {
          session: session({ revision: beyondDouble }),
          run: {
            sessionId: "session-one",
            generation: 3n,
            backendRef: "armadra-node-one:0.0",
            startedAtUnixMs: 1_788_557_000_000n,
          },
        }),
      ),
    );
    const { session: record, run } = await api.get({ sessionKey: "node-one" });
    expect(record.state).toBe("running");
    expect(record.revision).toBe(beyondDouble);
    expect(record.generation).toBe(3n);
    expect(run?.backendRef).toBe("armadra-node-one:0.0");
    // A read is a read: the transport is told so, and a Host that required a
    // CSRF token for it would refuse a mounting node.
    expect(calls[0]?.mutation).toBe(false);
    const request = fromBinary(GetSessionRequestSchema, calls[0]!.body);
    expect(request.sessionKey).toBe("node-one");
    expect(request.sessionId).toBe("");
  });

  // Naming both an identifier and a key would let the two disagree, and
  // resolving that by precedence would answer about a session nobody asked
  // about. Naming neither asks nothing at all.
  it("refuses a lookup that is not exactly one question", async () => {
    const { api, calls } = client(() => new Uint8Array());
    await expect(api.get({})).rejects.toBeInstanceOf(HostCanvasError);
    await expect(
      api.get({ sessionId: "session-one", sessionKey: "node-one" }),
    ).rejects.toBeInstanceOf(HostCanvasError);
    expect(calls).toHaveLength(0);
  });

  // The whole point of the domain: creating records an intent, and starting is
  // a second decision. A client that could do both in one call would be back to
  // starting programs as a side effect of rendering.
  it("creates an intent without starting anything", async () => {
    const { api, calls } = client(() =>
      toBinary(
        CreateSessionResponseSchema,
        create(CreateSessionResponseSchema, {
          session: session({ status: SessionStatus.PENDING, generation: 0n }),
        }),
      ),
    );
    const record = await api.create({
      operationId: "session/session-one/create",
      sessionId: "session-one",
      sessionKey: "node-one",
      ownerNodeId: "node-one",
      kind: "agent",
      workingDirectory: "/项目/一",
      shell: "/bin/zsh",
      agentId: "claude",
      permissionMode: "plan",
      envRefs: ["ANTHROPIC_API_KEY"],
      expectedRevision: 0n,
    });
    expect(record.state).toBe("pending");
    expect(calls[0]?.action).toBe("Create");
    expect(calls[0]?.mutation).toBe(true);
    const request = fromBinary(CreateSessionRequestSchema, calls[0]!.body);
    expect(request.session?.launch?.agent?.agentId).toBe("claude");
    // Only names travel for the environment. A value here would be a secret
    // the Host's database had briefly held.
    expect(request.session?.launch?.envRefs).toEqual(["ANTHROPIC_API_KEY"]);
    // The workspace comes from the client, never from the caller's input: a
    // request that could name another workspace would be one the Host has to
    // refuse rather than one that cannot be made.
    expect(request.session?.workspaceId).toBe(workspaceId);
  });

  it("starts under the revision it read and carries no launch", async () => {
    const { api, calls } = client(() =>
      toBinary(
        StartSessionResponseSchema,
        create(StartSessionResponseSchema, {
          session: session({ generation: 1n }),
          run: {
            sessionId: "session-one",
            generation: 1n,
            workerInstanceId: "worker-a",
            backendRef: "armadra-node-one:0.0",
            startedAtUnixMs: 1_788_557_000_000n,
          },
        }),
      ),
    );
    const { session: record, run } = await api.start({
      operationId: "session/session-one/start",
      sessionId: "session-one",
      expectedRevision: 1n,
    });
    expect(record.state).toBe("running");
    expect(run?.workerInstanceId).toBe("worker-a");
    const request = fromBinary(StartSessionRequestSchema, calls[0]!.body);
    expect(request.expectedRevision).toBe(1n);
    // The launch was frozen at creation. A start that could restate it would be
    // a second place the command line is decided.
    expect(Object.keys(request)).not.toContain("launch");
  });

  it("passes the terminate mode through without mapping it", async () => {
    const { api, calls } = client(() =>
      toBinary(
        TerminateSessionResponseSchema,
        create(TerminateSessionResponseSchema, {
          session: session({
            status: SessionStatus.EXITED,
            attachState: SessionAttachState.EXITED,
            terminationIntent: TerminationIntent.USER,
            exitCode: 130,
            revision: 2n,
          }),
        }),
      ),
    );
    const record = await api.terminate({
      operationId: "session/session-one/terminate",
      sessionId: "session-one",
      expectedRevision: 1n,
      mode: "session",
    });
    expect(record.state).toBe("exited");
    expect(record.exitCode).toBe(130);
    const request = fromBinary(TerminateSessionRequestSchema, calls[0]!.body);
    // `interrupt` / `process` / `session` are the execution host's own words.
    // Mapping them here would make this client decide how hard to kill
    // somebody's program.
    expect(request.mode).toBe("session");
  });

  it("recycles in one call and reports the new generation", async () => {
    const { api } = client(() =>
      toBinary(
        RecycleSessionResponseSchema,
        create(RecycleSessionResponseSchema, {
          session: session({ generation: 4n, revision: 2n }),
          run: {
            sessionId: "session-one",
            generation: 4n,
            backendRef: "armadra-node-one:0.1",
            startedAtUnixMs: 1_788_557_900_000n,
          },
        }),
      ),
    );
    const { session: record, run } = await api.recycle({
      operationId: "session/session-one/recycle",
      sessionId: "session-one",
      expectedRevision: 1n,
    });
    // The logical key survives, which is what lets a mounting node find the
    // same session after somebody recycled it.
    expect(record.sessionKey).toBe("node-one");
    expect(record.generation).toBe(4n);
    expect(run?.generation).toBe(4n);
  });

  it("answers a close with the identifier it closed", async () => {
    const { api } = client(() =>
      toBinary(
        CloseSessionResponseSchema,
        create(CloseSessionResponseSchema, { sessionId: "session-one" }),
      ),
    );
    await expect(
      api.close({
        operationId: "session/session-one/close",
        sessionId: "session-one",
        expectedRevision: 1n,
      }),
    ).resolves.toBe("session-one");
  });

  // A session drawn as `running` because its status was unreadable is one
  // nobody will restart; one drawn as `exited` for the same reason is one
  // somebody will start twice. Neither default is acceptable.
  it("refuses a record whose lifecycle it cannot read", async () => {
    for (const broken of [
      session({ status: SessionStatus.UNSPECIFIED }),
      session({ attachState: SessionAttachState.UNSPECIFIED }),
      session({ kind: SessionKind.UNSPECIFIED }),
      session({ revision: 0n }),
      session({ deleted: true }),
    ]) {
      const { api } = client(() =>
        toBinary(
          GetSessionResponseSchema,
          create(GetSessionResponseSchema, { session: broken }),
        ),
      );
      await expect(
        api.get({ sessionId: "session-one" }),
      ).rejects.toBeInstanceOf(HostCanvasError);
    }
  });

  // LOST is not EXITED. The execution host may well still be holding the pane,
  // and drawing it as ended would offer a second program on top of the first.
  it("keeps a lost session distinct from an ended one", async () => {
    const { api } = client(() =>
      toBinary(
        ListSessionsResponseSchema,
        create(ListSessionsResponseSchema, {
          sessions: [
            session({ status: SessionStatus.LOST }),
            session({
              sessionId: "session-two",
              sessionKey: "node-two",
              status: SessionStatus.EXITED,
              exitCode: 0,
            }),
          ],
        }),
      ),
    );
    const listed = await api.list();
    expect(listed.map((entry) => entry.state)).toEqual(["lost", "exited"]);
    // And an exit code of zero is not an absent one: the first session ended
    // where nobody watched, and the second finished successfully.
    expect(listed[0]?.exitCode).toBeUndefined();
    expect(listed[1]?.exitCode).toBe(0);
  });

  it("refuses a context usage snapshot whose digest is missing", async () => {
    const { api } = client(() =>
      toBinary(
        GetSessionContextUsageResponseSchema,
        create(GetSessionContextUsageResponseSchema, {
          usage: new TextEncoder().encode("{}"),
          schemaVersion: 1,
        }),
      ),
    );
    await expect(api.contextUsage("session-one")).rejects.toBeInstanceOf(
      HostCanvasError,
    );
  });

  it("refuses a decision with no revision behind it", async () => {
    const { api, calls } = client(() => new Uint8Array());
    for (const decision of [
      { operationId: "", sessionId: "session-one", expectedRevision: 1n },
      { operationId: "op", sessionId: "", expectedRevision: 1n },
      { operationId: "op", sessionId: "session-one", expectedRevision: 0n },
    ]) {
      await expect(api.start(decision)).rejects.toBeInstanceOf(HostCanvasError);
    }
    expect(calls).toHaveLength(0);
  });
});
