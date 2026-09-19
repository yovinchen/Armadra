/**
 * Crashing, idle stopping and hanging — the lifecycle branches a real server
 * reaches only by accident, driven by the mock's `--crash-after` and `--hang`
 * switches. A port of `apps/runtime/src/language/tests/lifecycle.rs`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { Harness, isDiagnostics, until } from "./fixture";
import { REQUEST_FAILED } from "./jsonrpc";
import type { JsonObject, JsonValue } from "./jsonrpc";
import { reason } from "./limits";
import { MAX_RESTARTS } from "./limits";
import { expireRequests, restartDelay } from "./mux";
import {
  initializeParams,
  isRuntimeVariable,
  serverEnvironment,
} from "./server";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

function start(extra: readonly string[]): Harness {
  harness = new Harness(extra);
  return harness;
}

function didOpenOf(text: string): JsonValue {
  return {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "armadra:///notes.md",
        languageId: "markdown",
        version: 1,
        text,
      },
    },
  };
}

describe("language/lifecycle", () => {
  it("a crash restarts the server and replays the open documents", async () => {
    // Three client messages get through — `initialize`, `initialized` and the
    // first `didOpen` — and the fourth kills it. The restart has to re-send
    // that didOpen from the shadow document, which is the whole point of
    // keeping one.
    const test = start(["--crash-after=3"]);
    test.join("a", true);
    await test.hub.ensureStarted();
    test.send("a", didOpenOf("TODO first\n"));
    expect(
      await test.expect("a", isDiagnostics),
      "the first server published diagnostics",
    ).toBeDefined();

    // The fourth message is the one it dies on.
    test.send("a", {
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: "armadra:///notes.md" },
        contentChanges: [{ text: "TODO second\n" }],
      },
    });

    // The crash is noticed, the restart budget allows it, and after the
    // back-off the replayed didOpen produces diagnostics again.
    expect(
      await until(20_000, () => test.hub.restartCount > 0),
      "the crash was counted",
    ).toBe(true);
    expect(
      await test.expect("a", isDiagnostics),
      "the restarted server was given the open document back",
    ).toBeDefined();
  }, 40_000);

  it("a server that keeps crashing stops being restarted", () => {
    // A server that fails on startup fails on startup every time. Three tries
    // with a growing pause, and then it stays stopped until a person asks — an
    // endless restart loop looks like a busy machine, not like a problem.
    expect(restartDelay(1)).toBe(1);
    expect(restartDelay(2)).toBe(5);
    expect(restartDelay(3)).toBe(20);
    expect(restartDelay(4)).toBeUndefined();
    expect(restartDelay(MAX_RESTARTS + 1)).toBeUndefined();
  });

  it("an idle server stops and the next open brings it back", async () => {
    const test = start([]);
    test.join("a", true);
    await test.hub.ensureStarted();
    test.send("a", didOpenOf("TODO here\n"));
    expect(await test.expect("a", isDiagnostics)).toBeDefined();

    // Closing the last document is what starts the idle clock.
    test.send("a", {
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri: "armadra:///notes.md" } },
    });
    expect(test.hub.documents.isEmpty()).toBe(true);
    expect(test.hub.idleSince).toBeDefined();

    // The sweep would do this after ten minutes; the test does it directly so
    // it can assert what comes *after* the stop.
    await test.hub.stopProcess("idleStopped", reason.IDLE);
    expect(test.hub.state).toBe("idleStopped");
    expect(test.hub.process).toBeUndefined();

    // Opening a document again restarts it, and the session never had to know.
    expect(await test.hub.ensureStarted()).toBeUndefined();
    expect(test.hub.state).toBe("running");
    test.send("a", didOpenOf("TODO again\n"));
    expect(
      await test.expect("a", isDiagnostics),
      "diagnostics reappear after an idle stop",
    ).toBeDefined();
  });

  it("a hung request is failed and cancelled rather than left waiting", async () => {
    const test = start(["--hang"]);
    test.join("a", true);
    await test.hub.ensureStarted();
    test.send("a", didOpenOf("alpha\n"));
    expect(await test.expect("a", isDiagnostics)).toBeDefined();
    test.send("a", {
      jsonrpc: "2.0",
      id: 5,
      method: "textDocument/hover",
      params: {
        textDocument: { uri: "armadra:///notes.md" },
        position: { line: 0, character: 1 },
      },
    });
    expect(test.hub.pending.size).toBe(1);
    // Expiry is normally 30 s; the sweep's own deadline is passed in so the
    // test asserts the behaviour rather than waiting for the clock.
    expireRequests(test.hub, 0);
    const answer = await test.expect("a", (value) => value["id"] === 5);
    expect(answer, "the session is told the request failed").toBeDefined();
    expect((answer?.["error"] as JsonObject)["code"]).toBe(REQUEST_FAILED);
    expect(test.hub.pending.size).toBe(0);
    // The in-flight budget is released, so the session is not permanently
    // poorer for having asked a question the server ignored.
    expect(test.hub.sessions.get("a")?.inFlight).toBe(0);
  });

  it("a stopped server leaves no process behind", async () => {
    const test = start([]);
    await test.hub.ensureStarted();
    const pid = test.hub.process?.pid;
    expect(pid, "a running server has a pid").toBeTypeOf("number");
    await test.hub.stopProcess("stopped", reason.USER);
    // Its own process group plus a group kill is what makes this true for a
    // server that forked helpers; the mock has none, so this checks the leader
    // at least.
    expect(
      await until(10_000, () => !processAlive(pid as number)),
      "the server process is gone",
    ).toBe(true);
  });
});

function processAlive(pid: number): boolean {
  // Signal 0 asks "could I signal this?", which answers "does it exist?"
  // without touching it.
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("language/server", () => {
  it("a language server never inherits the core's own variables", () => {
    // A language server is the project's code. It needs `PATH` and the
    // toolchain variables; it must not be handed anything that identifies or
    // authorises Armadra.
    expect(isRuntimeVariable("ARMADRA_HOOK_TOKEN")).toBe(true);
    expect(isRuntimeVariable("ARMADRA_DATA_DIR")).toBe(true);
    expect(isRuntimeVariable("ARMADRA_NODE_ID")).toBe(true);
    expect(isRuntimeVariable("PATH")).toBe(false);
    expect(isRuntimeVariable("GOPATH")).toBe(false);
    expect(isRuntimeVariable("CARGO_HOME")).toBe(false);
    const environment = serverEnvironment({
      PATH: "/usr/bin",
      ARMADRA_HOOK_TOKEN: "secret",
      CLAUDE_HOOK_URL: "http://localhost",
      GOPATH: "/go",
    });
    expect(environment["PATH"]).toBe("/usr/bin");
    expect(environment["GOPATH"]).toBe("/go");
    expect(environment["ARMADRA_HOOK_TOKEN"]).toBeUndefined();
    expect(environment["CLAUDE_HOOK_URL"]).toBeUndefined();
  });

  it("the initialize params name exactly one workspace folder", () => {
    const params = initializeParams("/项目/仓库", {}, undefined, "1.2.3");
    const folders = params["workspaceFolders"] as JsonObject[];
    // Multi-root is out of scope; a second folder would let a server index a
    // directory the workspace does not cover.
    expect(folders).toHaveLength(1);
    expect(folders[0]?.["uri"]).toBe(params["rootUri"]);
    expect(params["rootUri"]).toBe("file:///项目/仓库");
  });
});
