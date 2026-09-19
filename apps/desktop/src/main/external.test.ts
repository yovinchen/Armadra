import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

/**
 * The two ways out of the sandbox, against a stand-in `shell`.
 *
 * Both allow-lists are pure and tested on their own
 * (`shell-core/external-url.ts`, `shell-core/reveal-path.ts`). What is worth
 * asserting here is the join: that a refused URL or path NEVER REACHES
 * ELECTRON, and that the refusal is a `{ code, message }` rejection rather
 * than a silent no-op — a link that does nothing reads as a broken app.
 */

const opened: string[] = [];
const revealed: string[] = [];
let downloadsPath: string | null = "/home/somebody/Downloads";

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "downloads") throw new Error(`unexpected path ${name}`);
      if (downloadsPath === null) throw new Error("no downloads directory");
      return downloadsPath;
    },
  },
  shell: {
    openExternal: async (url: string) => {
      opened.push(url);
    },
    showItemInFolder: (path: string) => {
      revealed.push(path);
    },
  },
}));

import { errorCode } from "../shared/ipc";
import { dataDir } from "../shell-core/paths";
import { openExternal, revealRoots, showItemInFolder } from "./external";

beforeEach(() => {
  opened.length = 0;
  revealed.length = 0;
  downloadsPath = "/home/somebody/Downloads";
});

describe("opening a link outside the app", () => {
  it("hands http and https to the operating system", async () => {
    await openExternal("https://example.test/docs");
    await openExternal("http://127.0.0.1:1420/");
    expect(opened).toEqual([
      "https://example.test/docs",
      "http://127.0.0.1:1420/",
    ]);
  });

  it("refuses every other scheme, and Electron never sees it", async () => {
    for (const url of [
      "file:///etc/passwd",
      "mailto:somebody@example.test",
      "javascript:void(0)",
      "vscode://open?file=/etc/passwd",
      "not a url",
      42,
      null,
    ]) {
      await expect(openExternal(url), String(url)).rejects.toThrow();
    }
    expect(opened).toEqual([]);
  });

  it("refuses with a code the page can read back", async () => {
    // Electron serializes a rejected handler by its message alone, so the
    // code has to survive inside it.
    const error = await openExternal("file:///etc/passwd").catch(
      (cause: unknown) => cause,
    );
    expect(errorCode(error)).toBe("scheme_not_allowed");
  });

  it("is not fooled by a scheme hidden behind another one", async () => {
    await expect(
      openExternal("javascript:void(0)//http://example.test"),
    ).rejects.toThrow();
    expect(opened).toEqual([]);
  });
});

describe("revealing a path in the file manager", () => {
  it("opens a window on the data directory", () => {
    showItemInFolder(dataDir());
    expect(revealed).toEqual([dataDir()]);
  });

  it("opens a window on a file inside the downloads directory", () => {
    const file = join("/home/somebody/Downloads", "report.pdf");
    showItemInFolder(file);
    expect(revealed).toEqual([file]);
  });

  it("refuses anything outside those roots, and Electron never sees it", () => {
    for (const path of [
      "/etc/passwd",
      "/home/somebody",
      join(dataDir(), "..", "..", "etc", "passwd"),
      "relative/path",
      "",
      null,
    ]) {
      expect(() => showItemInFolder(path), String(path)).toThrow();
    }
    expect(revealed).toEqual([]);
  });

  it("refuses with a code the page can read back", () => {
    let code: string | undefined;
    try {
      showItemInFolder("/etc/passwd");
    } catch (cause) {
      code = errorCode(cause);
    }
    expect(code).toBe("path_not_allowed");
  });

  it("still reveals the data directory on a platform with no downloads one", () => {
    // One fewer root is not a reason to refuse the root this product owns.
    downloadsPath = null;
    expect(revealRoots()).toEqual([dataDir()]);
    showItemInFolder(dataDir());
    expect(revealed).toEqual([dataDir()]);
  });
});
