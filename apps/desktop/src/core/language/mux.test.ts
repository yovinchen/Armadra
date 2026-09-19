/**
 * The proxy against a real child process (`tools/probes/mock-lsp.mjs`) — a
 * port of `apps/runtime/src/language/tests/mux.rs`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Harness, diagnosticsFor, didOpen, isResponse } from "./fixture";
import { METHOD_NOT_FOUND, REQUEST_FAILED } from "./jsonrpc";
import type { JsonObject, JsonValue } from "./jsonrpc";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

function start(extra: readonly string[] = []): Harness {
  harness = new Harness(extra);
  return harness;
}

function requestOf(
  id: JsonValue,
  method: string,
  params: JsonValue,
): JsonValue {
  return { jsonrpc: "2.0", id, method, params };
}

function hoverOf(id: number): JsonValue {
  return requestOf(id, "textDocument/hover", {
    textDocument: { uri: "armadra:///notes.md" },
    position: { line: 0, character: 1 },
  });
}

describe("language/mux", () => {
  it("diagnostics reach every session with relative uris", async () => {
    const test = start();
    test.join("a", true);
    test.join("b", true);
    expect(await test.hub.ensureStarted()).toBeUndefined();
    expect(test.hub.state).toBe("running");

    test.send("a", didOpen("armadra:///notes.md", "line\nTODO here\n"));
    // Both sessions get the diagnostics, because they belong to the document
    // and not to whoever opened it.
    for (const who of ["a", "b"]) {
      const published = await test.expect(
        who,
        diagnosticsFor("armadra:///notes.md"),
      );
      expect(published, who).toBeDefined();
      const params = published?.["params"] as JsonObject;
      expect((params["diagnostics"] as JsonValue[]).length).toBe(1);
      // Nothing absolute reaches a session, ever.
      expect(JSON.stringify(published)).not.toContain("file://");
    }

    // The second session opening the same file must not open it twice: the
    // server holds one buffer, and a second didOpen would be a protocol error.
    test.send("b", didOpen("armadra:///notes.md", "line\nTODO here\n"));
    expect(test.hub.documents.size).toBe(1);
  });

  it("two sessions using the same request id get their own answers", async () => {
    const test = start();
    test.join("a", true);
    test.join("b", true);
    await test.hub.ensureStarted();
    test.send("a", didOpen("armadra:///notes.md", "alpha beta\n"));
    await test.expect("a", diagnosticsFor("armadra:///notes.md"));

    // Both sessions send id 1. Without a per-session namespace the second
    // answer would be delivered to the first session.
    for (const who of ["a", "b"]) test.send(who, hoverOf(1));
    for (const who of ["a", "b"]) {
      const answer = await test.expect(who, isResponse("1"));
      expect(answer, who).toBeDefined();
      // The id the client used comes back, not the namespaced one.
      expect(answer?.["id"]).toBe(1);
      expect((answer?.["result"] as JsonObject)["contents"]).toBe("alpha");
    }
  });

  it("a session cannot cancel another session's request", async () => {
    const test = start(["--hang"]);
    test.join("a", true);
    test.join("b", true);
    await test.hub.ensureStarted();
    test.send("a", didOpen("armadra:///notes.md", "alpha\n"));
    await test.expect("a", diagnosticsFor("armadra:///notes.md"));
    test.send("a", hoverOf(1));
    // Session `b` guesses the id — both sessions count from 1, so guessing is
    // trivial — and asks for it to be cancelled.
    test.send("b", {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 1 },
    });
    // `a`'s request is still outstanding: the cancel named an id that is not
    // `b`'s, and ids are namespaced precisely so that is checkable.
    expect(test.hub.pending.size).toBe(1);
    expect([...test.hub.pending.values()][0]?.sessionId).toBe("a");

    // The owner's own cancel does take effect.
    test.send("a", {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 1 },
    });
    expect(test.hub.pending.size).toBe(0);
  });

  it("an answer past the ceiling becomes an error for the session that asked", async () => {
    const test = start(["--big-response"]);
    test.join("a", true);
    await test.hub.ensureStarted();
    test.send("a", didOpen("armadra:///notes.md", "alpha\n"));
    await test.expect("a", diagnosticsFor("armadra:///notes.md"));
    test.send("a", hoverOf(4));
    const answer = await test.expect("a", isResponse("4"));
    expect(
      answer,
      "the session is told rather than left waiting",
    ).toBeDefined();
    expect((answer?.["error"] as JsonObject)["code"]).toBe(REQUEST_FAILED);
    expect(answer?.["result"]).toBeUndefined();
  });

  it("a read-only workspace cannot rename", async () => {
    const test = start();
    test.join("reader", false);
    await test.hub.ensureStarted();
    test.send("reader", didOpen("armadra:///notes.md", "old text\n"));
    await test.expect("reader", diagnosticsFor("armadra:///notes.md"));
    test.send(
      "reader",
      requestOf(9, "textDocument/rename", {
        textDocument: { uri: "armadra:///notes.md" },
        position: { line: 0, character: 0 },
        newName: "new",
      }),
    );
    const answer = await test.expect("reader", isResponse("9"));
    expect((answer?.["error"] as JsonObject)["code"]).toBe(METHOD_NOT_FOUND);
    // Nothing was sent to the server, so nothing is outstanding.
    expect(test.hub.pending.size).toBe(0);
  });

  it("locations outside the workspace are opaque and commands are dropped", async () => {
    const test = start();
    test.join("a", true);
    await test.hub.ensureStarted();
    test.send("a", didOpen("armadra:///notes.md", "alpha\n"));
    await test.expect("a", diagnosticsFor("armadra:///notes.md"));

    test.send(
      "a",
      requestOf(2, "textDocument/definition", {
        textDocument: { uri: "armadra:///notes.md" },
        position: { line: 0, character: 0 },
      }),
    );
    const definition = JSON.stringify(await test.expect("a", isResponse("2")));
    expect(definition).toContain("armadra:///notes.md");
    // The second location is `/usr/lib/elsewhere.txt`. The session may learn
    // that it is outside the workspace; it may not learn where it is.
    expect(definition).toContain("armadra-external:///");
    expect(definition).not.toContain("usr");
    expect(definition).not.toContain("elsewhere");

    test.send(
      "a",
      requestOf(3, "textDocument/codeAction", {
        textDocument: { uri: "armadra:///notes.md" },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        context: { diagnostics: [] },
      }),
    );
    const answer = await test.expect("a", isResponse("3"));
    const actions = answer?.["result"] as JsonObject[];
    // A command-only action would need `workspace/executeCommand` to apply, so
    // it is removed here rather than offered and then refused on click.
    expect(actions).toHaveLength(1);
    expect(actions[0]?.["title"]).toBe("with edit");
  });

  it("a server-initiated request is answered by the host, not the browser", async () => {
    const test = start();
    test.join("a", true);
    await test.hub.ensureStarted();
    // The mock sends `workspace/configuration` right after `initialize`. It
    // must never appear on a session's socket: the browser is not the client
    // and cannot answer for a server it does not own.
    test.send("a", didOpen("armadra:///notes.md", "alpha\n"));
    await test.expect("a", diagnosticsFor("armadra:///notes.md"));
    const methods = test
      .received("a")
      .map((value) => value["method"])
      .filter((method) => method !== "textDocument/publishDiagnostics");
    expect(methods, "a server-initiated request reached the browser").toEqual(
      [],
    );
  });

  it("a session gets its initialize answered from cache", async () => {
    const test = start();
    test.join("a", true);
    await test.hub.ensureStarted();
    test.send("a", requestOf(0, "initialize", { capabilities: {} }));
    const answer = await test.expect("a", isResponse("0"));
    expect(
      ((answer?.["result"] as JsonObject)["capabilities"] as JsonObject)[
        "hoverProvider"
      ],
    ).toBe(true);
    // A session shutting down does not shut down a server other sessions are
    // still using.
    test.send("a", requestOf(99, "shutdown", null));
    expect(await test.expect("a", isResponse("99"))).toBeDefined();
    expect(test.hub.state).toBe("running");
  });
});

/* ---------------------------- workspace/applyEdit -------------------------- */

/**
 * Matches the diagnostic the mock publishes to report what the client did with
 * its `workspace/applyEdit`. Diagnostics are the only thing a server says
 * about itself that the proxy forwards, so they are the channel the outcome
 * can be read on without inventing a private protocol.
 */
function applyReport(value: JsonObject): boolean {
  if (value["method"] !== "textDocument/publishDiagnostics") return false;
  const params = value["params"];
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return false;
  }
  const diagnostics = params["diagnostics"];
  return (
    Array.isArray(diagnostics) &&
    diagnostics.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        entry["source"] === "mock-lsp-apply",
    )
  );
}

function reportMessage(value: JsonObject | undefined): string {
  const params = value?.["params"] as JsonObject | undefined;
  const diagnostics = params?.["diagnostics"] as JsonObject[] | undefined;
  const message = diagnostics?.[0]?.["message"];
  return typeof message === "string" ? message : "";
}

describe("language/mux workspace/applyEdit", () => {
  it("a server may ask for an edit and it is really written", async () => {
    const test = start(["--apply-edit"]);
    writeFileSync(join(test.root, "notes.md"), "keep this\nsecond\n", "utf8");
    test.join("a", true);
    await test.hub.ensureStarted();
    test.send("a", didOpen("armadra:///notes.md", "keep this\nsecond\n"));

    const report = await test.expect("a", applyReport);
    expect(report, "the server hears an answer").toBeDefined();
    expect(reportMessage(report)).toBe("applied=true reason=");
    expect(readFileSync(join(test.root, "notes.md"), "utf8")).toBe(
      "DONE this\nsecond\n",
    );
    // Each write announces itself, which is how an open and clean editor
    // reloads.
    expect(test.changedFiles.map((file) => file.path)).toEqual(["notes.md"]);
  });

  it("a read-only workspace refuses the edit a server asks for", async () => {
    const test = start(["--apply-edit"]);
    writeFileSync(join(test.root, "notes.md"), "keep this\n", "utf8");
    // The same gate a client-initiated rename passes.
    test.join("reader", false);
    await test.hub.ensureStarted();
    test.send("reader", didOpen("armadra:///notes.md", "keep this\n"));

    const report = await test.expect("reader", applyReport);
    expect(reportMessage(report)).toBe("applied=false reason=read_only");
    expect(readFileSync(join(test.root, "notes.md"), "utf8")).toBe(
      "keep this\n",
    );
  });

  it("an edit reaching outside the workspace is refused whole", async () => {
    const test = start(["--apply-outside"]);
    writeFileSync(join(test.root, "notes.md"), "keep this\n", "utf8");
    test.join("a", true);
    await test.hub.ensureStarted();
    test.send("a", didOpen("armadra:///notes.md", "keep this\n"));

    const report = await test.expect("a", applyReport);
    expect(reportMessage(report)).toBe(
      "applied=false reason=edit_not_applicable",
    );
    expect(readFileSync(join(test.root, "notes.md"), "utf8")).toBe(
      "keep this\n",
    );
  });
});
