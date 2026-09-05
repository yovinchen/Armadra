import {
  MAX_IMPORT_BATCH_BYTES,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_FILES,
} from "@armadra/shared";

export interface BrowserFolder {
  name: string;
  files: { file: File; path: string }[];
  directories: string[];
}
export interface FolderSource {
  name: string;
  read: () => Promise<BrowserFolder>;
}
export class FolderReadError extends Error {
  constructor(
    public readonly reason:
      | "onlyFolders"
      | "limit"
      | "invalidPath"
      | "unavailable",
  ) {
    super(reason);
  }
}

export interface BrowserEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink?: boolean;
  file?: (
    success: (file: File) => void,
    error: (error: DOMException) => void,
  ) => void;
  createReader?: () => {
    readEntries: (
      success: (entries: BrowserEntry[]) => void,
      error: (error: DOMException) => void,
    ) => void;
  };
}
interface FileHandle {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
}
export interface DirectoryHandle {
  kind: "directory";
  name: string;
  values: () => AsyncIterable<DirectoryHandle | FileHandle>;
}

function validPath(path: string): void {
  const parts = path.split("/");
  if (
    path.length > 4000 ||
    parts.length > 64 ||
    /[\\:\0]/.test(path) ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new FolderReadError("invalidPath");
  }
}

function collector(name: string) {
  validPath(name);
  const result: BrowserFolder = { name, files: [], directories: [] };
  const names = new Set<string>();
  let size = 0;
  return {
    result,
    directory(path: string) {
      validPath(path);
      if (names.has(path)) throw new FolderReadError("invalidPath");
      if (result.directories.length >= MAX_IMPORT_FILES)
        throw new FolderReadError("limit");
      names.add(path);
      result.directories.push(path);
    },
    file(path: string, file: File) {
      validPath(path);
      if (names.has(path)) throw new FolderReadError("invalidPath");
      if (
        result.files.length >= MAX_IMPORT_FILES ||
        file.size > MAX_IMPORT_FILE_BYTES ||
        size + file.size > MAX_IMPORT_BATCH_BYTES
      ) {
        throw new FolderReadError("limit");
      }
      names.add(path);
      size += file.size;
      result.files.push({ file, path });
    },
  };
}

export async function readDirectoryEntry(
  root: BrowserEntry,
): Promise<BrowserFolder> {
  if (!root.isDirectory || root.isFile)
    throw new FolderReadError("onlyFolders");
  const output = collector(root.name);
  async function walk(entry: BrowserEntry, path: string): Promise<void> {
    if (entry.isSymbolicLink) throw new FolderReadError("invalidPath");
    if (path) validPath(path);
    if (entry.isDirectory && entry.createReader) {
      if (path) output.directory(path);
      const reader = entry.createReader();
      // Chromium returns at most 100 entries per read. One read silently
      // truncates large directories; continue until the empty final batch.
      while (true) {
        const entries = await new Promise<BrowserEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!entries.length) break;
        for (const child of entries) {
          validPath(child.name);
          if (child.name.includes("/"))
            throw new FolderReadError("invalidPath");
          await walk(child, path ? `${path}/${child.name}` : child.name);
        }
      }
    } else if (entry.isFile && entry.file) {
      const file = await new Promise<File>((resolve, reject) =>
        entry.file!(resolve, reject),
      );
      output.file(path, file);
    } else throw new FolderReadError("unavailable");
  }
  await walk(root, "");
  return output.result;
}

export async function readDirectoryHandle(
  root: DirectoryHandle,
): Promise<BrowserFolder> {
  const output = collector(root.name);
  async function walk(directory: DirectoryHandle, path: string): Promise<void> {
    if (path) output.directory(path);
    for await (const child of directory.values()) {
      validPath(child.name);
      if (child.name.includes("/")) throw new FolderReadError("invalidPath");
      const next = path ? `${path}/${child.name}` : child.name;
      if (child.kind === "directory") await walk(child, next);
      else output.file(next, await child.getFile());
    }
  }
  await walk(root, "");
  return output.result;
}

/** FileList carries relative paths only. Missing directory metadata is an
 * explicit limitation; neither file.name nor fakepath is an original path. */
export function foldersFromFileList(files: readonly File[]): BrowserFolder[] {
  if (!files.length) throw new FolderReadError("unavailable");
  const groups = new Map<string, ReturnType<typeof collector>>();
  const directories = new Map<string, Set<string>>();
  for (const file of files) {
    const relative = file.webkitRelativePath;
    if (!relative) throw new FolderReadError("onlyFolders");
    validPath(relative);
    const [name, ...parts] = relative.split("/");
    if (!name || !parts.length) throw new FolderReadError("onlyFolders");
    let output = groups.get(name);
    if (!output) {
      output = collector(name);
      groups.set(name, output);
      directories.set(name, new Set());
    }
    for (let length = 1; length < parts.length; length++) {
      const directory = parts.slice(0, length).join("/");
      if (!directories.get(name)!.has(directory)) {
        output.directory(directory);
        directories.get(name)!.add(directory);
      }
    }
    output.file(parts.join("/"), file);
  }
  return [...groups.values()].map((group) => group.result);
}

/** Capture entries synchronously while the drop's data store is readable. */
export function droppedFolders(data: DataTransfer): FolderSource[] {
  const entries = Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => {
      const compatible = item as DataTransferItem & {
        getAsEntry?: () => FileSystemEntry | null;
      };
      return (compatible.getAsEntry?.() ??
        item.webkitGetAsEntry?.()) as unknown as BrowserEntry | null;
    });
  if (entries.length && entries.every(Boolean)) {
    return entries.map((entry) => ({
      name: entry!.name,
      read: () => readDirectoryEntry(entry!),
    }));
  }
  const files = Array.from(data.files ?? []);
  return foldersFromFileList(files).map((folder) => ({
    name: folder.name,
    read: async () => folder,
  }));
}

export async function chooseBrowserFolder(): Promise<FolderSource[]> {
  const picker = (
    window as Window & {
      showDirectoryPicker?: (options: {
        mode: "read";
      }) => Promise<DirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (picker) {
    try {
      const handle = await picker.call(window, { mode: "read" });
      return [{ name: handle.name, read: () => readDirectoryHandle(handle) }];
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        return [];
      throw error;
    }
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.webkitdirectory = true;
    input.hidden = true;
    input.addEventListener(
      "cancel",
      () => {
        input.remove();
        resolve([]);
      },
      { once: true },
    );
    input.addEventListener(
      "change",
      () => {
        const entries = Array.from(
          input.webkitEntries ?? [],
        ) as unknown as BrowserEntry[];
        const files = Array.from(input.files ?? []);
        input.remove();
        try {
          if (entries.length)
            resolve(
              entries.map((entry) => ({
                name: entry.name,
                read: () => readDirectoryEntry(entry),
              })),
            );
          else
            resolve(
              foldersFromFileList(files).map((folder) => ({
                name: folder.name,
                read: async () => folder,
              })),
            );
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
    document.body.append(input);
    input.click();
  });
}
