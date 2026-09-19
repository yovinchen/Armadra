/**
 * Uri rewriting in both directions, field by field — a port of
 * `apps/runtime/src/language/tests/uri.rs`.
 *
 * The failure this file exists to catch is a *missing field*. A rewrite that
 * covers `textDocument.uri` and forgets `LocationLink.targetUri` does not fail
 * loudly: navigation quietly stops working, or worse, an absolute path reaches
 * the browser.
 */

import { describe, expect, it } from "vitest";

import { Rewriter } from "./uri";
import type { JsonObject } from "./jsonrpc";

function rewriter(): Rewriter {
  return new Rewriter("/项目/仓库");
}

describe("language/uri", () => {
  it("a workspace path survives a round trip", () => {
    const subject = rewriter();
    const web = subject.workspaceUri("src/主.py");
    expect(web).toBe("armadra:///src/%E4%B8%BB.py");
    const value: JsonObject = { textDocument: { uri: web } };
    subject.rewrite(value, "toHost");
    expect((value["textDocument"] as JsonObject)["uri"]).toBe(
      "file:///%E9%A1%B9%E7%9B%AE/%E4%BB%93%E5%BA%93/src/%E4%B8%BB.py",
    );
    subject.rewrite(value, "toWeb");
    expect((value["textDocument"] as JsonObject)["uri"]).toBe(web);
    expect(subject.relativeOf(web)).toBe("src/主.py");
  });

  it("every known field is rewritten, not just the first", () => {
    const subject = rewriter();
    const value: JsonObject = {
      result: [
        { uri: "file:///项目/仓库/a.rs", range: {} },
        { targetUri: "file:///项目/仓库/b.rs", targetRange: {} },
        { location: { uri: "file:///项目/仓库/c.rs" } },
      ],
      params: {
        diagnostics: [
          {
            relatedInformation: [
              { location: { uri: "file:///项目/仓库/d.rs" } },
            ],
          },
        ],
      },
    };
    subject.rewrite(value, "toWeb");
    const text = JSON.stringify(value);
    // Not one `file://` may survive anywhere in the message.
    expect(text).not.toContain("file://");
    for (const name of ["a", "b", "c", "d"]) {
      expect(text).toContain(`armadra:///${name}.rs`);
    }
  });

  it("a workspace edit rewrites its keys as well as its values", () => {
    const subject = rewriter();
    const value: JsonObject = {
      result: {
        changes: { "file:///项目/仓库/a.rs": [{ newText: "x" }] },
        documentChanges: [
          {
            textDocument: { uri: "file:///项目/仓库/b.rs", version: 1 },
            edits: [],
          },
        ],
      },
    };
    subject.rewrite(value, "toWeb");
    const result = value["result"] as JsonObject;
    // A generic value walk never sees a uri that is a *key*.
    expect(Object.keys(result["changes"] as JsonObject)).toContain(
      "armadra:///a.rs",
    );
    expect(
      (
        (result["documentChanges"] as JsonObject[])[0]?.[
          "textDocument"
        ] as JsonObject
      )["uri"],
    ).toBe("armadra:///b.rs");
  });

  it("a path outside the root becomes opaque", () => {
    const subject = rewriter();
    const value: JsonObject = { uri: "file:///usr/lib/other.rs" };
    subject.rewrite(value, "toWeb");
    const external = value["uri"] as string;
    expect(Rewriter.isExternal(external)).toBe(true);
    // Opaque means opaque: nothing of the path is recoverable from it.
    expect(external).not.toContain("usr");
    expect(external).not.toContain("other");
    // Stable across calls, so a list the user is reading does not reshuffle.
    const again: JsonObject = { uri: "file:///usr/lib/other.rs" };
    subject.rewrite(again, "toWeb");
    expect(again["uri"]).toBe(external);
    // And it cannot be handed back in to reach the file.
    expect(subject.relativeOf(external)).toBeUndefined();
    const back: JsonObject = { uri: external };
    subject.rewrite(back, "toHost");
    expect((back["uri"] as string).startsWith("file://")).toBe(false);
  });

  it("a sibling directory is not inside the root", () => {
    const subject = new Rewriter("/project");
    const value: JsonObject = { uri: "file:///project-2/secret.rs" };
    subject.rewrite(value, "toWeb");
    expect(Rewriter.isExternal(value["uri"] as string)).toBe(true);
  });

  it("other schemes and prose are left alone", () => {
    const subject = rewriter();
    const value: JsonObject = {
      uri: "untitled:Untitled-1",
      // Hover markdown legitimately contains uris. Rewriting text would break
      // documentation links and could rewrite words a user typed.
      result: { contents: "see file:///项目/仓库/README.md for details" },
    };
    subject.rewrite(value, "toWeb");
    expect(value["uri"]).toBe("untitled:Untitled-1");
    expect((value["result"] as JsonObject)["contents"]).toContain(
      "file:///项目/仓库/README.md",
    );
  });

  it("a traversal is not a workspace path", () => {
    const subject = rewriter();
    expect(subject.relativeOf("armadra:///../etc/passwd")).toBeUndefined();
    expect(subject.relativeOf("armadra:///")).toBeUndefined();
    expect(subject.relativeOf("file:///项目/仓库/a.rs")).toBeUndefined();
  });
});
