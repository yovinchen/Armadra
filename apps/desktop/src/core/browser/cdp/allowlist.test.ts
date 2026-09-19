import { describe, expect, it } from "vitest";

import {
  ALLOWED_METHODS,
  BROWSER_COMMANDS,
  BROWSER_KEYS,
  FORBIDDEN_DOMAINS,
  FORBIDDEN_METHODS,
  isAllowed,
  isNavigableUrl,
  refusalMessage,
} from "./allowlist";
import { SCRIPTS } from "./scripts";

describe("the allowlist is default deny", () => {
  it("refuses a method it has never heard of", () => {
    expect(isAllowed("Beep.boop", {})).toBe(false);
    expect(isAllowed(undefined, {})).toBe(false);
    expect(isAllowed("", {})).toBe(false);
  });

  it("refuses every named exclusion", () => {
    for (const method of FORBIDDEN_METHODS) {
      expect(isAllowed(method, {}), method).toBe(false);
      expect(ALLOWED_METHODS.includes(method), method).toBe(false);
    }
  });

  it("holds no method from a forbidden domain", () => {
    for (const domain of FORBIDDEN_DOMAINS) {
      const leaked = ALLOWED_METHODS.filter((method) =>
        method.startsWith(`${domain}.`),
      );
      expect(leaked, domain).toEqual([]);
    }
  });

  it("refuses a params object that is not an object", () => {
    expect(isAllowed("Page.enable", [])).toBe(false);
    expect(isAllowed("Page.enable", "x")).toBe(false);
  });

  it("says nothing about why", () => {
    expect(refusalMessage("Runtime.evaluate")).toBe(
      "browser: the command Runtime.evaluate is not permitted for agent control",
    );
  });
});

describe("Page.navigate", () => {
  it("takes http and https", () => {
    expect(
      isAllowed("Page.navigate", { url: "https://example.com/a?b=1" }),
    ).toBe(true);
    expect(isAllowed("Page.navigate", { url: "http://127.0.0.1:8080/" })).toBe(
      true,
    );
  });

  it("refuses everything else, file:// included", () => {
    for (const url of [
      "file:///etc/passwd",
      "about:config",
      "javascript:alert(1)",
      "data:text/html,<b>x",
      "chrome://settings",
      "",
      42,
    ]) {
      expect(isAllowed("Page.navigate", { url }), String(url)).toBe(false);
    }
  });

  it("is the same gate isNavigableUrl exposes", () => {
    expect(isNavigableUrl("https://a.example")).toBe(true);
    expect(isNavigableUrl("file:///tmp")).toBe(false);
  });
});

describe("Runtime.callFunctionOn", () => {
  const base = {
    functionDeclaration: SCRIPTS.readTitle,
    objectId: "1.2.3",
    returnByValue: true,
  };

  it("takes a member of the frozen table", () => {
    expect(isAllowed("Runtime.callFunctionOn", base)).toBe(true);
  });

  it("refuses a declaration that is not one, byte for byte", () => {
    expect(
      isAllowed("Runtime.callFunctionOn", {
        ...base,
        functionDeclaration: SCRIPTS.readTitle + " ",
      }),
    ).toBe(false);
    expect(
      isAllowed("Runtime.callFunctionOn", {
        ...base,
        functionDeclaration: "function () { return document.cookie; }",
      }),
    ).toBe(false);
  });

  it("requires the answer to come back by value", () => {
    expect(
      isAllowed("Runtime.callFunctionOn", { ...base, returnByValue: false }),
    ).toBe(false);
    const { returnByValue: _drop, ...without } = base;
    expect(isAllowed("Runtime.callFunctionOn", without)).toBe(false);
  });

  it("takes at most one scalar argument", () => {
    expect(
      isAllowed("Runtime.callFunctionOn", {
        ...base,
        arguments: [{ value: 7 }],
      }),
    ).toBe(true);
    expect(
      isAllowed("Runtime.callFunctionOn", {
        ...base,
        arguments: [{ value: "x" }],
      }),
    ).toBe(true);
    expect(
      isAllowed("Runtime.callFunctionOn", {
        ...base,
        arguments: [{ value: 1 }, { value: 2 }],
      }),
    ).toBe(false);
    expect(
      isAllowed("Runtime.callFunctionOn", {
        ...base,
        arguments: [{ objectId: "1.2.3" }],
      }),
    ).toBe(false);
    expect(
      isAllowed("Runtime.callFunctionOn", {
        ...base,
        arguments: [{ unserializableValue: "Infinity" }],
      }),
    ).toBe(false);
    expect(
      isAllowed("Runtime.callFunctionOn", {
        ...base,
        arguments: [{ value: { a: 1 } }],
      }),
    ).toBe(false);
  });

  it("refuses awaitPromise and userGesture", () => {
    expect(
      isAllowed("Runtime.callFunctionOn", { ...base, awaitPromise: true }),
    ).toBe(false);
    expect(
      isAllowed("Runtime.callFunctionOn", { ...base, userGesture: true }),
    ).toBe(false);
  });
});

describe("DOM.getDocument", () => {
  it("takes a shallow read", () => {
    expect(isAllowed("DOM.getDocument", { depth: 0 })).toBe(true);
    expect(isAllowed("DOM.getDocument", { depth: 1 })).toBe(true);
  });

  it("refuses the whole tree and refuses piercing frames", () => {
    expect(isAllowed("DOM.getDocument", { depth: -1 })).toBe(false);
    expect(isAllowed("DOM.getDocument", { depth: 2 })).toBe(false);
    expect(isAllowed("DOM.getDocument", { depth: 0, pierce: true })).toBe(
      false,
    );
  });
});

describe("input", () => {
  it("bounds a mouse event by the measured viewport", () => {
    const viewport = { width: 520, height: 332 };
    const at = (x: number, y: number) =>
      isAllowed(
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x, y },
        viewport,
      );
    expect(at(0, 0)).toBe(true);
    expect(at(520, 332)).toBe(true);
    expect(at(521, 100)).toBe(false);
    expect(at(-1, 100)).toBe(false);
    expect(at(100, 333)).toBe(false);
  });

  it("refuses a key event carrying text", () => {
    expect(
      isAllowed("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" }),
    ).toBe(true);
    expect(
      isAllowed("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        text: "x",
      }),
    ).toBe(false);
    expect(
      isAllowed("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        unmodifiedText: "x",
      }),
    ).toBe(false);
  });

  it("only takes keys from the closed list", () => {
    for (const key of BROWSER_KEYS) {
      expect(
        isAllowed("Input.dispatchKeyEvent", { type: "keyDown", key }),
        key,
      ).toBe(true);
    }
    for (const key of ["a", "F12", "Meta", "ContextMenu"]) {
      expect(
        isAllowed("Input.dispatchKeyEvent", { type: "keyDown", key }),
        key,
      ).toBe(false);
    }
  });

  it("only takes the two editing commands", () => {
    for (const command of BROWSER_COMMANDS) {
      expect(
        isAllowed("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          commands: [command],
        }),
        command,
      ).toBe(true);
    }
    expect(
      isAllowed("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        commands: ["paste"],
      }),
    ).toBe(false);
  });

  it("insertText is text and only text", () => {
    expect(isAllowed("Input.insertText", { text: "hello" })).toBe(true);
    expect(isAllowed("Input.insertText", { text: "x".repeat(4_097) })).toBe(
      false,
    );
    expect(
      isAllowed("Input.insertText", { text: "hi", commands: ["selectAll"] }),
    ).toBe(false);
  });
});

describe("capture", () => {
  it("takes a clip of numbers and nothing else", () => {
    expect(isAllowed("Page.captureScreenshot", { format: "png" })).toBe(true);
    expect(
      isAllowed("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width: 10, height: 10, scale: 1 },
      }),
    ).toBe(true);
    expect(
      isAllowed("Page.captureScreenshot", {
        clip: { x: 0, y: 0, width: 10, height: "10" },
      }),
    ).toBe(false);
    expect(isAllowed("Page.captureScreenshot", { format: "webp" })).toBe(false);
  });
});
