import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two system pickers, against a stand-in `dialog`.
 *
 * Nothing here is a judgement call — which is the point. Every assertion is
 * about a parameter reaching Electron: the properties that decide what the
 * panel can select, the window it is attached to (a free panel can end up
 * BEHIND the window it belongs to, with no way back), and the fact that a
 * cancelled dialog is an empty list rather than a rejection.
 */

interface Call {
  window: unknown;
  options: Electron.OpenDialogOptions;
}

const calls: Call[] = [];
let answer: { canceled: boolean; filePaths: string[] } = {
  canceled: false,
  filePaths: ["/picked"],
};
let mainWindow: unknown = { id: 1 };

vi.mock("electron", () => ({
  dialog: {
    showOpenDialog: async (
      first: unknown,
      second?: Electron.OpenDialogOptions,
    ) => {
      if (second === undefined) {
        calls.push({ window: null, options: first as never });
      } else {
        calls.push({ window: first, options: second });
      }
      return answer;
    },
  },
}));

vi.mock("./window", () => ({ getMainWindow: () => mainWindow }));

import { pickDirectory } from "./dialogs";

beforeEach(() => {
  calls.length = 0;
  answer = { canceled: false, filePaths: ["/picked"] };
  mainWindow = { id: 1 };
});

describe("the folder picker", () => {
  it("can open a directory and create one", async () => {
    // The New folder flow leans on the panel's own "New Folder" button.
    await pickDirectory();
    expect(calls[0]?.options.properties).toEqual([
      "openDirectory",
      "createDirectory",
    ]);
  });

  it("passes a default path through when it was given one", async () => {
    await pickDirectory({ defaultPath: "/home/somebody/projects" });
    expect(calls[0]?.options.defaultPath).toBe("/home/somebody/projects");
  });

  it("omits the default path rather than sending undefined", async () => {
    await pickDirectory();
    expect("defaultPath" in (calls[0]?.options ?? {})).toBe(false);
  });
});

describe("where the panel is attached", () => {
  it("is a sheet on the window when there is one", async () => {
    await pickDirectory();
    expect(calls[0]?.window).toEqual({ id: 1 });
  });

  it("is free-floating only when there is no window to attach to", async () => {
    mainWindow = null;
    await pickDirectory();
    expect(calls[0]?.window).toBe(null);
  });
});

describe("cancelling", () => {
  it("is an empty list, never a rejection", async () => {
    // Cancelling is the ordinary outcome, and every caller already treats
    // "nothing picked" as one.
    answer = { canceled: true, filePaths: ["/ignored"] };
    await expect(pickDirectory()).resolves.toEqual([]);
  });

  it("answers with absolute paths rather than bytes", async () => {
    // The page hands a path to the Runtime, which is the process allowed to
    // read it; the file never travels through the renderer.
    await expect(pickDirectory()).resolves.toEqual(["/picked"]);
  });
});
