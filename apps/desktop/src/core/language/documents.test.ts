/**
 * Shadow documents: ownership, versions and incremental edits — a port of
 * `apps/runtime/src/language/tests/documents.rs`.
 */

import { describe, expect, it } from "vitest";

import {
  Documents,
  isClean,
  parseContentChanges,
  sha256,
  type ContentChange,
} from "./documents";

function full(text: string): ContentChange[] {
  return [{ kind: "full", text }];
}

function range(
  start: readonly [number, number],
  end: readonly [number, number],
  text: string,
): ContentChange[] {
  return [
    {
      kind: "range",
      start: { line: start[0], character: start[1] },
      end: { line: end[0], character: end[1] },
      rangeLength: undefined,
      text,
    },
  ];
}

const URI = "armadra:///x.rs";

describe("language/documents", () => {
  it("the first session to open a uri owns it", () => {
    const documents = new Documents();
    expect(documents.openDocument("a", URI, "rust", "one")).toEqual({
      kind: "opened",
      version: 1,
    });
    // The second session gets the document, not a second copy of it.
    expect(documents.openDocument("b", URI, "rust", "one")).toEqual({
      kind: "followed",
      owner: "a",
    });
    expect(documents.size).toBe(1);
    expect(documents.get(URI)?.readers).toHaveLength(2);
  });

  it("only the owner edits the document", () => {
    const documents = new Documents();
    documents.openDocument("a", URI, "rust", "one");
    documents.openDocument("b", URI, "rust", "one");
    expect(documents.change("a", URI, full("two"))).toBe(2);
    // A follower's edit is not the document.
    expect(documents.change("b", URI, full("three"))).toBeUndefined();
    expect(documents.get(URI)?.text).toBe("two");
  });

  it("closing the owner hands the document to the next session", () => {
    const documents = new Documents();
    documents.openDocument("a", URI, "rust", "one");
    documents.openDocument("b", URI, "rust", "one");
    documents.change("a", URI, full("edited"));
    const outcome = documents.close("a", URI);
    expect(outcome).toEqual({
      kind: "ownerMoved",
      owner: "b",
      // The version moves too, so the full re-send the caller makes is newer
      // than everything the server has already seen.
      version: 3,
      text: "edited",
    });
    expect(documents.change("b", URI, full("now mine"))).toBe(4);
    expect(documents.close("b", URI)).toEqual({ kind: "closed" });
    expect(documents.isEmpty()).toBe(true);
  });

  it("a follower leaving changes nothing", () => {
    const documents = new Documents();
    documents.openDocument("a", URI, "rust", "one");
    documents.openDocument("b", URI, "rust", "one");
    expect(documents.close("b", URI)).toEqual({ kind: "stillOpen" });
    expect(documents.close("a", "armadra:///nothing.rs")).toEqual({
      kind: "unknown",
    });
  });

  it("incremental edits are applied in utf-16 units", () => {
    const documents = new Documents();
    // `注` and `释` are one UTF-16 unit each; `📘` is two. A byte-offset
    // implementation gets every one of these wrong.
    documents.openDocument(
      "a",
      "armadra:///x.md",
      "markdown",
      "注释📘尾\nsecond",
    );
    documents.change("a", "armadra:///x.md", range([0, 2], [0, 4], "X"));
    expect(documents.get("armadra:///x.md")?.text).toBe("注释X尾\nsecond");
    documents.change("a", "armadra:///x.md", range([1, 0], [1, 6], "2nd"));
    expect(documents.get("armadra:///x.md")?.text).toBe("注释X尾\n2nd");
  });

  it("an unusable range is refused rather than guessed", () => {
    const documents = new Documents();
    documents.openDocument("a", URI, "rust", "one");
    // Line 9 does not exist. Applying "as close as possible" would corrupt the
    // shadow text and make every later incremental edit wrong.
    expect(
      documents.change("a", URI, range([9, 0], [9, 1], "z")),
    ).toBeUndefined();
    expect(documents.get(URI)?.text).toBe("one");
  });

  it("a document is clean until it diverges from disk", () => {
    const documents = new Documents();
    documents.openDocument("a", URI, "rust", "one");
    expect(isClean(documents.get(URI)!)).toBe(true);
    documents.change("a", URI, full("two"));
    // A dirty buffer blocks a `WorkspaceEdit`.
    expect(isClean(documents.get(URI)!)).toBe(false);
    documents.noteSaved(URI, sha256(documents.get(URI)!.text));
    expect(isClean(documents.get(URI)!)).toBe(true);
  });

  it("a content change array is read as the protocol writes it", () => {
    const changes = parseContentChanges({
      contentChanges: [
        { text: "whole file" },
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 2 },
          },
          rangeLength: 1,
          text: "x",
        },
      ],
    });
    expect(changes).toHaveLength(2);
    expect(changes[0]?.kind).toBe("full");
    expect(changes[1]?.kind).toBe("range");
  });
});
