import { describe, expect, it } from "vitest";
import {
  CLAIMED_INTENTS,
  keydownIntercept,
  type KeydownInput,
} from "./keydown-intercept";

function input(overrides: Partial<KeydownInput> = {}): KeydownInput {
  return {
    type: "keyDown",
    key: "w",
    meta: false,
    control: false,
    shift: false,
    alt: false,
    ...overrides,
  };
}

describe("the main-process keydown intercept", () => {
  it("claims exactly one chord in this build", () => {
    // The closed list. Adding an entry takes a chord away from the page
    // app-wide, so it must be a reviewed edit to THIS array, not a new branch.
    expect(CLAIMED_INTENTS).toEqual(["close-window"]);
  });

  it("claims the platform's own close-window chord", () => {
    expect(keydownIntercept(input({ meta: true }), "darwin")).toBe(
      "close-window",
    );
    expect(keydownIntercept(input({ control: true }), "win32")).toBe(
      "close-window",
    );
    expect(keydownIntercept(input({ meta: true, key: "W" }), "darwin")).toBe(
      "close-window",
    );
  });

  it("leaves the other platform's modifier alone", () => {
    expect(keydownIntercept(input({ control: true }), "darwin")).toBeNull();
    expect(keydownIntercept(input({ meta: true }), "win32")).toBeNull();
  });

  it("matches the modifiers exactly, so neighbouring chords survive", () => {
    // ⌘⇧W is the menu's Close All Windows; ⌘⌥W is nothing. Neither is ours.
    for (const extra of [{ shift: true }, { alt: true }, { control: true }])
      expect(
        keydownIntercept(input({ meta: true, ...extra }), "darwin"),
        JSON.stringify(extra),
      ).toBeNull();
  });

  it("never swallows ordinary typing", () => {
    // `w` is a character people type. Without a primary-modifier requirement
    // this branch would eat every one of them (nodeterm #193).
    expect(keydownIntercept(input(), "darwin")).toBeNull();
    expect(keydownIntercept(input({ shift: true }), "darwin")).toBeNull();
    for (const key of ["a", "q", "m", "0", "Enter"])
      expect(keydownIntercept(input({ meta: true, key }), "darwin")).toBeNull();
  });

  it("only looks at key-down", () => {
    for (const type of ["keyUp", "char", "rawKeyDown"])
      expect(
        keydownIntercept(input({ type, meta: true }), "darwin"),
      ).toBeNull();
  });
});
