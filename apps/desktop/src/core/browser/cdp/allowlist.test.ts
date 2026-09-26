import { describe, expect, it } from "vitest";

import {
  ALLOWED_METHODS,
  BROWSER_COMMANDS,
  BROWSER_KEYS,
  FORBIDDEN_DOMAINS,
  FORBIDDEN_METHODS,
  NETWORK_METHODS,
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

  it("answers by reference only for the shadow reader, and only into requestNode", () => {
    const shadow = {
      ...base,
      functionDeclaration: SCRIPTS.shadowQuery,
      arguments: [{ value: "x-card >>> button" }],
    };
    expect(
      isAllowed("Runtime.callFunctionOn", { ...shadow, returnByValue: false }),
    ).toBe(true);
    expect(isAllowed("Runtime.callFunctionOn", shadow)).toBe(true);
    const { returnByValue: _drop, ...without } = shadow;
    expect(isAllowed("Runtime.callFunctionOn", without)).toBe(false);
    expect(isAllowed("DOM.requestNode", { objectId: "1.2.3" })).toBe(true);
    expect(isAllowed("DOM.requestNode", { objectId: "1.2.3", depth: -1 })).toBe(
      false,
    );
    expect(isAllowed("DOM.requestNode", {})).toBe(false);
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
    for (const key of ["a", "Meta", "ContextMenu", "F13", "+"]) {
      expect(
        isAllowed("Input.dispatchKeyEvent", { type: "keyDown", key }),
        key,
      ).toBe(false);
    }
  });

  it("judges a key and its modifiers together, chord by chord", () => {
    const chord = (key: string, modifiers: number) =>
      isAllowed("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key,
        modifiers,
      });
    // Letters and digits only inside a Control / Meta / Alt chord.
    expect(chord("a", 2)).toBe(true);
    expect(chord("z", 4 | 8)).toBe(true);
    expect(chord("7", 1)).toBe(true);
    expect(chord("a", 0)).toBe(false);
    expect(chord("a", 8)).toBe(false);
    // Clipboard and window chords never.
    for (const key of ["c", "v", "x", "w", "q", "t", "n"]) {
      expect(chord(key, 2), `Control+${key}`).toBe(false);
      expect(chord(key, 4), `Meta+${key}`).toBe(false);
    }
    // Named keys and F1–F12 with anything.
    expect(chord("Tab", 8)).toBe(true);
    expect(chord("F5", 0)).toBe(true);
    expect(chord("F12", 2)).toBe(true);
    // A modifier that is not a number is not a modifier.
    expect(
      isAllowed("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        modifiers: "2",
      }),
    ).toBe(false);
  });

  it("lets one lone character through as a char event, and nothing more", () => {
    const char = (params: Record<string, unknown>) =>
      isAllowed("Input.dispatchKeyEvent", { type: "char", ...params });
    expect(char({ text: "上" })).toBe(true);
    expect(char({ text: "😀" })).toBe(true);
    expect(char({ text: "ab" })).toBe(false);
    expect(char({ text: "a", modifiers: 4 })).toBe(false);
    expect(char({ text: "a", key: "a" })).toBe(false);
    expect(
      isAllowed("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        text: "\r",
      }),
    ).toBe(false);
  });

  it("only takes the editing commands that carry no text and touch no clipboard", () => {
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

describe("the developer surface", () => {
  it("reaches the Network domain through two subscriptions and nothing else", () => {
    expect(
      ALLOWED_METHODS.filter((method) => method.startsWith("Network.")),
    ).toEqual(NETWORK_METHODS);
    expect(isAllowed("Network.enable", { maxPostDataSize: 0 })).toBe(true);
    // A request body is not even carried on the event.
    expect(isAllowed("Network.enable", {})).toBe(false);
    expect(isAllowed("Network.enable", { maxPostDataSize: 65_536 })).toBe(
      false,
    );
    for (const method of [
      "Network.getResponseBody",
      "Network.getRequestPostData",
      "Network.getCookies",
      "Network.setExtraHTTPHeaders",
      "Network.replayXHR",
    ]) {
      expect(isAllowed(method, { requestId: "1" }), method).toBe(false);
    }
  });

  it("subscribes to the console log, and still evaluates nothing", () => {
    expect(isAllowed("Log.enable", {})).toBe(true);
    expect(isAllowed("Runtime.evaluate", { expression: "1" })).toBe(false);
  });
});

describe("the snapshot and the locator", () => {
  it("reads the accessibility tree of a frame, and one node", () => {
    expect(isAllowed("Accessibility.getFullAXTree", { frameId: "F1" })).toBe(
      true,
    );
    expect(
      isAllowed("Accessibility.getFullAXTree", { frameId: "F1", max: 1 }),
    ).toBe(false);
    expect(
      isAllowed("Accessibility.getPartialAXTree", {
        backendNodeId: 3,
        fetchRelatives: false,
      }),
    ).toBe(true);
    expect(
      isAllowed("Accessibility.getPartialAXTree", {
        backendNodeId: 3,
        fetchRelatives: true,
      }),
    ).toBe(false);
  });

  it("names a node by id, never by an object handle", () => {
    for (const method of [
      "DOM.getContentQuads",
      "DOM.getBoxModel",
      "DOM.scrollIntoViewIfNeeded",
      "DOM.focus",
    ]) {
      expect(isAllowed(method, { backendNodeId: 3 }), method).toBe(true);
      expect(isAllowed(method, { nodeId: 3 }), method).toBe(true);
      expect(isAllowed(method, { objectId: "x" }), method).toBe(false);
      expect(isAllowed(method, { nodeId: 1, backendNodeId: 2 }), method).toBe(
        false,
      );
    }
    expect(isAllowed("DOM.querySelector", { nodeId: 1, selector: "#a" })).toBe(
      true,
    );
    expect(
      isAllowed("DOM.querySelector", {
        nodeId: 1,
        selector: "x".repeat(1_001),
      }),
    ).toBe(false);
    expect(isAllowed("DOM.describeNode", { backendNodeId: 1 })).toBe(false);
  });

  it("auto-attaches iframes without ever pausing one", () => {
    const attach = {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    };
    expect(isAllowed("Target.setAutoAttach", attach)).toBe(true);
    expect(
      isAllowed("Target.setAutoAttach", {
        ...attach,
        waitForDebuggerOnStart: true,
      }),
    ).toBe(false);
    expect(
      isAllowed("Target.setAutoAttach", { ...attach, flatten: false }),
    ).toBe(false);
    expect(isAllowed("Target.attachToTarget", { targetId: "x" })).toBe(false);
  });
});

describe("drag, resize, pdf, full-page capture", () => {
  it("drops the page's own drag data, never files", () => {
    const data = {
      items: [{ mimeType: "text/plain", data: "x" }],
      dragOperationsMask: 1,
    };
    expect(
      isAllowed("Input.dispatchDragEvent", { type: "drop", x: 1, y: 1, data }),
    ).toBe(true);
    expect(
      isAllowed("Input.dispatchDragEvent", {
        type: "drop",
        x: 1,
        y: 1,
        data: { ...data, files: ["/etc/passwd"] },
      }),
    ).toBe(false);
    expect(
      isAllowed(
        "Input.dispatchDragEvent",
        { type: "drop", x: 9_000, y: 1, data },
        { width: 800, height: 600 },
      ),
    ).toBe(false);
    expect(isAllowed("Input.setInterceptDrags", { enabled: true })).toBe(true);
  });

  it("emulates a bounded desktop viewport only", () => {
    const size = {
      width: 800,
      height: 600,
      deviceScaleFactor: 0,
      mobile: false,
    };
    expect(isAllowed("Emulation.setDeviceMetricsOverride", size)).toBe(true);
    for (const wrong of [
      { width: 10 },
      { mobile: true },
      { deviceScaleFactor: 3 },
    ]) {
      expect(
        isAllowed("Emulation.setDeviceMetricsOverride", { ...size, ...wrong }),
      ).toBe(false);
    }
    expect(
      isAllowed("Emulation.setUserAgentOverride", { userAgent: "x" }),
    ).toBe(false);
  });

  it("prints inline, without templates or a stream", () => {
    expect(
      isAllowed("Page.printToPDF", { landscape: true, printBackground: true }),
    ).toBe(true);
    expect(
      isAllowed("Page.printToPDF", { transferMode: "ReturnAsStream" }),
    ).toBe(false);
    expect(
      isAllowed("Page.printToPDF", { headerTemplate: "<b>header</b>" }),
    ).toBe(false);
    expect(isAllowed("IO.read", { handle: "1" })).toBe(false);
  });

  it("captures beyond the viewport only as a boolean", () => {
    expect(
      isAllowed("Page.captureScreenshot", { captureBeyondViewport: true }),
    ).toBe(true);
    expect(
      isAllowed("Page.captureScreenshot", { captureBeyondViewport: "yes" }),
    ).toBe(false);
    expect(
      isAllowed("Page.captureScreenshot", { format: "png", extra: 1 }),
    ).toBe(false);
  });

  it("stops a load, and reloads without a script", () => {
    expect(isAllowed("Page.stopLoading", {})).toBe(true);
    expect(isAllowed("Page.reload", { scriptToEvaluateOnLoad: "x" })).toBe(
      false,
    );
  });
});
