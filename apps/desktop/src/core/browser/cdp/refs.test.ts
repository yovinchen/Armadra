import { describe, expect, it } from "vitest";

import { RefTable, parseRef, refName, verifyIdentity } from "./refs";

describe("the ref syntax", () => {
  it("takes e12 and the spellings a model copies out of a snapshot line", () => {
    for (const spelling of [
      "e12",
      "@e12",
      "ref=e12",
      "[ref=e12]",
      "@12",
      " e12 ",
    ])
      expect(parseRef(spelling), spelling).toBe(12);
  });

  it("takes nothing else", () => {
    for (const spelling of [
      "",
      "e",
      "e0",
      "12x",
      "button",
      "e1-2",
      "#e1",
      "e1234567",
    ])
      expect(parseRef(spelling), spelling).toBeNull();
  });

  it("prints as e<N>", () => {
    expect(refName(7)).toBe("e7");
  });
});

describe("a ref table", () => {
  it("gives the same element the same ref across snapshots", () => {
    const table = new RefTable();
    const first = table.mint("", 40, "button", "保存", "https://a.test");
    const again = table.mint("", 40, "button", "已保存", "https://a.test");
    expect(again.ordinal).toBe(first.ordinal);
    // The label moved on; the element is the same one.
    expect(again.name).toBe("已保存");
  });

  it("tells two sessions' nodes apart even with the same backend id", () => {
    const table = new RefTable();
    const page = table.mint("", 5, "button", "a", "");
    const frame = table.mint("child-1", 5, "button", "a", "");
    expect(frame.ordinal).not.toBe(page.ordinal);
  });

  it("never hands a number out twice, not even after a navigation", () => {
    const table = new RefTable();
    const before = table.mint("", 1, "link", "下一页", "https://a.test");
    table.bumpGeneration();
    const after = table.mint("", 1, "link", "下一页", "https://a.test");
    expect(after.ordinal).toBeGreaterThan(before.ordinal);
    // The old one is STALE — the page changed — not unknown.
    expect(table.lookup(before.ordinal)).toMatchObject({
      ok: false,
      reason: "stale",
    });
    expect(table.lookup(after.ordinal).ok).toBe(true);
  });

  it("calls a ref it never minted unknown", () => {
    expect(new RefTable().lookup(99)).toEqual({ ok: false, reason: "unknown" });
  });

  it("forgets a node that turned out to be gone, so its next mint is new", () => {
    const table = new RefTable();
    const first = table.mint("", 3, "button", "x", "");
    table.forget(first);
    expect(table.mint("", 3, "button", "x", "").ordinal).not.toBe(
      first.ordinal,
    );
  });

  it("counts only live refs", () => {
    const table = new RefTable();
    table.mint("", 1, "button", "a", "");
    table.mint("", 2, "button", "b", "");
    expect(table.size()).toBe(2);
    table.bumpGeneration();
    expect(table.size()).toBe(0);
  });
});

describe("verifyIdentity", () => {
  const record = { role: "button", name: "Sign in" };

  it("accepts the same element after a reflow", () => {
    expect(verifyIdentity(record, { role: "button", name: "Sign  in" })).toBe(
      true,
    );
    expect(verifyIdentity(record, { role: "button", name: " Sign in " })).toBe(
      true,
    );
  });

  it("refuses an element that merely sits where it was", () => {
    expect(
      verifyIdentity(record, { role: "button", name: "Delete account" }),
    ).toBe(false);
    expect(verifyIdentity(record, { role: "link", name: "Sign in" })).toBe(
      false,
    );
  });
});
