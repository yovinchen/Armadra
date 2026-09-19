import { describe, expect, it } from "vitest";

import { RefTable, parseRef, verifyIdentity } from "./refs";

const PAGE = [
  { index: 0, role: "link", name: "Home" },
  { index: 4, role: "button", name: "Sign in" },
  { index: 9, role: "input", name: "Email" },
];

describe("parseRef", () => {
  it("takes the @N form and nothing else", () => {
    expect(parseRef("@1")).toBe(1);
    expect(parseRef(" @42 ")).toBe(42);
    for (const bad of ["@0", "@", "1", "@-1", "@1x", "@99999", "button"]) {
      expect(parseRef(bad), bad).toBeNull();
    }
  });
});

describe("a ref is scoped to a navigation generation", () => {
  it("resolves a ref minted in the current generation", () => {
    const table = new RefTable();
    table.mint(PAGE);
    const found = table.lookup(2);
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.record.index).toBe(4);
      expect(found.record.name).toBe("Sign in");
    }
  });

  it("refuses every ref after a navigation, and re-resolves nothing", () => {
    const table = new RefTable();
    table.mint(PAGE);
    table.bumpGeneration();
    const found = table.lookup(2);
    expect(found.ok).toBe(false);
    // The table is EMPTY, not merely marked: there is no path through which a
    // later call could find the old element again.
    expect(table.size()).toBe(0);
  });

  it("calls a ref it never minted unknown, not stale", () => {
    const table = new RefTable();
    table.mint(PAGE);
    const found = table.lookup(99);
    expect(found).toEqual({ ok: false, reason: "unknown" });
  });

  it("re-minting replaces the table rather than appending to it", () => {
    const table = new RefTable();
    table.mint(PAGE);
    table.mint([{ index: 3, role: "button", name: "Only" }]);
    expect(table.size()).toBe(1);
    expect(table.lookup(2).ok).toBe(false);
  });

  it("counts generations up, never back", () => {
    const table = new RefTable();
    const first = table.currentGeneration();
    table.bumpGeneration();
    table.bumpGeneration();
    expect(table.currentGeneration()).toBe(first + 2);
  });
});

describe("verifyIdentity", () => {
  const record = { ordinal: 1, index: 4, role: "button", name: "Sign in", generation: 1 };

  it("accepts the same element after a reflow", () => {
    expect(verifyIdentity(record, { role: "button", name: "Sign  in" })).toBe(true);
    expect(verifyIdentity(record, { role: "button", name: " Sign in " })).toBe(true);
  });

  it("refuses an element that merely sits at the same position", () => {
    expect(verifyIdentity(record, { role: "button", name: "Delete account" })).toBe(false);
    expect(verifyIdentity(record, { role: "link", name: "Sign in" })).toBe(false);
  });
});
