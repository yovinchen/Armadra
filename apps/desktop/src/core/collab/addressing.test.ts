import { describe, expect, it } from "vitest";
import type { ContextLink } from "../canvas/context-links";
import {
  AddressError,
  MAX_HANDLE_CHARS,
  NO_HANDLES,
  handleOf,
  normalizeHandle,
  resolveLink,
} from "./addressing";

/** Ported from the addressing half of the pre-merge implementation. */

const link = (id: string, title: string, kind = "terminal"): ContextLink => ({
  id,
  title,
  kind,
});

function refusalOf(
  links: readonly ContextLink[],
  handles: ReadonlyMap<string, string>,
  wanted: string | undefined,
): AddressError {
  try {
    resolveLink(links, handles, wanted);
  } catch (error) {
    if (error instanceof AddressError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("handles", () => {
  it("folds case and accepts only the narrow character set", () => {
    expect(normalizeHandle("Review")).toBe("review");
    expect(normalizeHandle("  a-b_1  ")).toBe("a-b_1");
    expect(normalizeHandle("9lives")).toBe("9lives");
    expect(normalizeHandle("-bad")).toBeUndefined();
    expect(normalizeHandle("_bad")).toBeUndefined();
    expect(normalizeHandle("has space")).toBeUndefined();
    expect(normalizeHandle("评审")).toBeUndefined();
    expect(normalizeHandle("")).toBeUndefined();
    expect(normalizeHandle("x".repeat(MAX_HANDLE_CHARS + 1))).toBeUndefined();
  });

  it("re-validates a handle a board wrote rather than trusting it", () => {
    // A board written by an older client — or by hand — must not be able to
    // register a handle the rename verb would have refused.
    expect(handleOf({ handle: "Review" })).toBe("review");
    expect(handleOf({ handle: "has space" })).toBeUndefined();
    expect(handleOf({ handle: 7 })).toBeUndefined();
    expect(handleOf({})).toBeUndefined();
  });
});

describe("resolving a name against the caller's own links", () => {
  it("answers the only link when the flag is left off", () => {
    const links = [link("a", "Alpha")];
    expect(resolveLink(links, NO_HANDLES, undefined).id).toBe("a");
    expect(resolveLink(links, NO_HANDLES, "  ").id).toBe("a");
  });

  it("refuses rather than picking one of several", () => {
    const links = [link("a", "Alpha"), link("b", "Beta")];
    const refused = refusalOf(links, NO_HANDLES, undefined);
    expect(refused.code).toBe("target_unspecified");
    expect(refused.status).toBe(400);
    expect(refused.linked).toBe(2);
  });

  it("tries id, then handle, then exact title, then substring", () => {
    const links = [link("a", "Alpha"), link("b", "Beta review")];
    const handles = new Map([["b", "rev"]]);
    expect(resolveLink(links, handles, "a").id).toBe("a");
    expect(resolveLink(links, handles, "rev").id).toBe("b");
    expect(resolveLink(links, handles, "alpha").id).toBe("a");
    expect(resolveLink(links, handles, "review").id).toBe("b");
  });

  it("lets a handle beat a title that happens to be the same word", () => {
    // The handle was assigned on purpose; the title collision was not.
    const links = [link("a", "rev"), link("b", "Beta")];
    const handles = new Map([["b", "rev"]]);
    expect(resolveLink(links, handles, "rev").id).toBe("b");
  });

  it("refuses an ambiguous name and names the candidates", () => {
    const links = [link("a", "Build API"), link("b", "Build UI")];
    const refused = refusalOf(links, NO_HANDLES, "build");
    expect(refused.code).toBe("target_ambiguous");
    expect(refused.status).toBe(400);
    expect(refused.matches).toHaveLength(2);
    expect(refused.english("--to")).toContain("Build API（a）");
    expect(refused.refusal("--node").message).toContain("Build UI（b）");
  });

  it("answers an unlinked name as a permission refusal, not a lookup miss", () => {
    // Saying "not found" would let an agent probe the board by name.
    expect(refusalOf([link("a", "Alpha")], NO_HANDLES, "Beta").status).toBe(
      403,
    );
    expect(refusalOf([], NO_HANDLES, "Alpha").code).toBe("no_links");
    expect(refusalOf([], NO_HANDLES, "Alpha").status).toBe(403);
  });

  it("speaks Chinese to the context-link surface and English to the mailbox", () => {
    const refused = refusalOf([], NO_HANDLES, undefined);
    expect(refused.refusal("--node").message).toContain("没有可读的上下文");
    expect(refused.english("--to")).toContain("Draw a canvas link");
  });
});
