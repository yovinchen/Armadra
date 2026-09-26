import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCRIPTS, isArmadraScript } from "./scripts";

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

  it("writes in exactly one member, and that one only picks an option", () => {
    const writers = Object.entries(SCRIPTS)
      .filter(([, body]) =>
        /selectedIndex =|dispatchEvent|\.checked =/.test(body),
      )
      .map(([name]) => name);
    expect(writers).toEqual(["chooseOption"]);
    const body = SCRIPTS.chooseOption;
    // Only on an enabled SELECT, only an enabled option of its own, by index.
    expect(body).toContain('el.tagName !== "SELECT" || el.disabled');
    expect(body).toContain("!option || option.disabled");
    expect(body.match(/ = /g)?.length).toBe(3);
    expect(body).toContain("el.selectedIndex = index;");
  });

  it("the element reader reports whether a field is filled, never its value", () => {
    const body = SCRIPTS.elementState;
    const uses = body.match(/el\.value/g) ?? [];
    expect(uses.length).toBe(1);
    expect(body).toContain("filled: !!(el.value ||");
    // The options of a native dropdown are the page's text, not the user's.
    expect(body).toContain("el.options[i].value");
  });

  it("the focused-field reader reports filled, never the value", () => {
    expect(SCRIPTS.activeField.match(/el\.value/g)?.length).toBe(1);
    expect(SCRIPTS.activeField).toContain("filled: !!(el.value ||");
  });
});

describe("isArmadraScript", () => {
  it("accepts exactly the members", () => {
    for (const body of Object.values(SCRIPTS))
      expect(isArmadraScript(body)).toBe(true);
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
