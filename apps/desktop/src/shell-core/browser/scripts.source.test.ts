import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ELEMENT_QUERY, SCRIPTS, isArmadraScript } from "./scripts";

/**
 * The structural guard on the frozen script table.
 *
 * Every assertion here is about the SOURCE FILE, not about behaviour, because
 * the properties being protected are properties of the text: a script that is
 * assembled, interpolated or concatenated is a script nobody has read, and no
 * runtime test can tell you afterwards what it said.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "scripts.ts"), "utf8");

describe("the frozen script table", () => {
  it("contains no template literal anywhere in the file", () => {
    // Including the prose. A flat search is only trustworthy if there are no
    // exceptions to reason about.
    expect(source.includes("`")).toBe(false);
  });

  it("contains no interpolation marker", () => {
    expect(source.includes("${")).toBe(false);
  });

  it("builds no script by concatenation", () => {
    // A `'...' +` or `+ '...'` inside the table would defeat the whole point.
    expect(/'\s*\+|\+\s*'/.test(source)).toBe(false);
  });

  it("writes to no HTML sink and evaluates nothing", () => {
    for (const sink of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "eval(",
      "Function(",
      "Runtime.evaluate",
      "executeJavaScript",
    ]) {
      expect(source.includes(sink), sink).toBe(false);
    }
  });

  it("has no writer: nothing clicks, submits, navigates or assigns", () => {
    for (const writer of [
      ".click()",
      ".submit()",
      ".focus()",
      "scrollIntoView",
      "location.href =",
      "location.assign",
      ".value =",
      "setAttribute",
      "removeAttribute",
    ]) {
      expect(source.includes(writer), writer).toBe(false);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(SCRIPTS)).toBe(true);
    expect(() => {
      (SCRIPTS as Record<string, string>).sneak = "function () { return 1; }";
    }).toThrow();
  });

  it("every member is one single-quoted function literal", () => {
    for (const [name, body] of Object.entries(SCRIPTS)) {
      expect(body.startsWith("function ("), name).toBe(true);
      expect(body.includes("\n"), name).toBe(false);
    }
  });

  it("every enumerating script carries the same element query, verbatim", () => {
    const enumerating = ["readMap", "resolveRef", "describeElement", "isVisible"] as const;
    for (const name of enumerating) {
      expect(SCRIPTS[name].includes(ELEMENT_QUERY), name).toBe(true);
    }
  });

  it("the read filters are in the script, where no caller can skip them", () => {
    // The six-element fixture's whole answer lives in these four clauses.
    for (const rule of [
      'st.display === "none"',
      'st.visibility === "hidden"',
      'el.hasAttribute("hidden")',
      'el.closest("[aria-hidden=true]")',
      'tag === "input" && type === "hidden"',
    ]) {
      expect(SCRIPTS.readMap.includes(rule), rule).toBe(true);
    }
  });

  it("readMap never returns a field's value, only whether it is filled", () => {
    // The only use of `.value` in readMap is as a truthiness test.
    const uses = SCRIPTS.readMap.match(/el\.value/g) ?? [];
    expect(uses.length).toBe(1);
    expect(SCRIPTS.readMap.includes('el.value ? "filled" : "empty"')).toBe(true);
  });

  it("a password field contributes no label of its own", () => {
    expect(SCRIPTS.readMap.includes('type !== "password"')).toBe(true);
  });
});

describe("isArmadraScript", () => {
  it("accepts exactly the members", () => {
    for (const body of Object.values(SCRIPTS)) expect(isArmadraScript(body)).toBe(true);
  });

  it("rejects a member with one character added", () => {
    expect(isArmadraScript(SCRIPTS.readTitle + " ")).toBe(false);
    expect(isArmadraScript(" " + SCRIPTS.readTitle)).toBe(false);
  });

  it("rejects anything else", () => {
    for (const stranger of [
      "function () { return document.cookie; }",
      "",
      undefined,
      null,
      42,
      SCRIPTS.readTitle.toUpperCase(),
    ]) {
      expect(isArmadraScript(stranger)).toBe(false);
    }
  });
});
