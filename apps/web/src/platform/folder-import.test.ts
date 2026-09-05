import { describe, expect, it } from "vitest";
import { MAX_IMPORT_FILE_BYTES } from "@armadra/shared";
import {
  foldersFromFileList,
  readDirectoryEntry,
  readDirectoryHandle,
  type BrowserEntry,
  type DirectoryHandle,
} from "./folder-import";

function directory(name: string, batches: BrowserEntry[][]): BrowserEntry {
  return {
    name,
    isDirectory: true,
    isFile: false,
    createReader: () => {
      let at = 0;
      return { readEntries: (resolve) => resolve(batches[at++] ?? []) };
    },
  };
}
function entry(
  name: string,
  file = new File(["contents"], name),
): BrowserEntry {
  return {
    name,
    isDirectory: false,
    isFile: true,
    file: (resolve) => resolve(file),
  };
}

describe("browser directory imports", () => {
  it("reads every directory batch and preserves nested empty directories", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      entry(`file-${index}.txt`),
    );
    const folder = await readDirectoryEntry(
      directory("project", [
        first,
        [entry("last.txt"), directory("empty", [])],
        [],
      ]),
    );
    expect(folder.files).toHaveLength(101);
    expect(folder.files.at(-1)?.path).toBe("last.txt");
    expect(folder.directories).toEqual(["empty"]);
  });
  it("can import a completely empty directory from an entry or handle", async () => {
    expect(await readDirectoryEntry(directory("empty", []))).toEqual({
      name: "empty",
      files: [],
      directories: [],
    });
    const handle: DirectoryHandle = {
      kind: "directory",
      name: "empty",
      async *values() {},
    };
    expect((await readDirectoryHandle(handle)).files).toEqual([]);
  });
  it("rejects ordinary files, traversal, exposed symbolic links and size excess", async () => {
    await expect(readDirectoryEntry(entry("a.txt"))).rejects.toMatchObject({
      reason: "onlyFolders",
    });
    await expect(
      readDirectoryEntry(directory("project", [[entry("../escape")]])),
    ).rejects.toMatchObject({ reason: "invalidPath" });
    await expect(
      readDirectoryEntry(
        directory("project", [[{ ...entry("link"), isSymbolicLink: true }]]),
      ),
    ).rejects.toMatchObject({ reason: "invalidPath" });
    const large = new File([], "large");
    Object.defineProperty(large, "size", { value: MAX_IMPORT_FILE_BYTES + 1 });
    await expect(
      readDirectoryEntry(directory("project", [[entry("large", large)]])),
    ).rejects.toMatchObject({ reason: "limit" });
  });
  it("groups picker-relative paths without inventing an original disk location", () => {
    const one = new File(["a"], "a.txt");
    Object.defineProperty(one, "webkitRelativePath", {
      value: "first/src/a.txt",
    });
    const two = new File(["b"], "b.txt");
    Object.defineProperty(two, "webkitRelativePath", { value: "second/b.txt" });
    const folders = foldersFromFileList([one, two]);
    expect(folders.map((folder) => folder.name)).toEqual(["first", "second"]);
    expect(folders[0]?.directories).toEqual(["src"]);
    expect(folders[0]?.files[0]?.path).toBe("src/a.txt");
    expect(() => foldersFromFileList([new File(["a"], "a.txt")])).toThrow();
    expect(() => foldersFromFileList([])).toThrow();
  });
});
