import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { rejectSymlinkComponents } from "../workspaces/directory";
import {
  canonicalDirectory,
  resolveImportSource,
  resolveInRoot,
} from "../workspaces/roots";
import { badRequest, conflict, forbidden } from "../workspaces/support";
import { mimeOrOctetStream } from "../files/mime";
import { relativeToRoot } from "../files/paths";
import { metadata, symlinkMetadata } from "../files/stat";
import {
  IMPORTS_DIRECTORY,
  MANAGED_DIRECTORY,
  MAX_BATCH_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
} from "./limits";

/**
 * File imports are copies, never a grant to read beyond the workspace later.
 *
 * A port of `apps/runtime/src/imports.rs`. Each batch has an exclusive staging
 * directory and commits as one rename, so a half-written import is never
 * visible under the name the canvas is told about — and a batch that fails
 * anywhere leaves the workspace exactly as it found it.
 *
 * There is no ledger table, here or in the Runtime. The ledger **is** the
 * directory layout: `.armadra/imports/<uuid>/` is minted per batch and is
 * never reused, `.pending-<uuid>` is the same batch before it committed, and
 * the answer the client gets names the committed directory. A row in SQLite
 * would be a second record of the same fact that a crash between the rename
 * and the insert could disagree with.
 */

/** Validate both separator styles on every host; never accept a fake path. */
export function relativePath(value: string): string {
  if (
    value === "" ||
    value.length > 4000 ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.includes(":") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw badRequest("Import paths must be plain relative paths");
  }
  return value;
}

export interface ImportManifest {
  readonly paths: readonly string[];
  readonly directories: readonly string[];
}

export function validateManifest(manifest: ImportManifest): void {
  if (
    manifest.paths.length > MAX_FILES ||
    manifest.directories.length > MAX_FILES ||
    (manifest.paths.length === 0 && manifest.directories.length === 0)
  ) {
    throw badRequest("An import must contain 1–256 files or directories");
  }
  const seen = new Set<string>();
  for (const path of [...manifest.paths, ...manifest.directories]) {
    relativePath(path);
    if (seen.has(path)) throw badRequest("Duplicate import path");
    seen.add(path);
  }
}

/** A JSON document read off the wire, shaped into a manifest or refused. */
export function manifestOf(bytes: Buffer): ImportManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw badRequest("Invalid import manifest");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("Invalid import manifest");
  }
  const record = parsed as Record<string, unknown>;
  const paths = record.paths;
  const directories = record.directories ?? [];
  if (!isStringArray(paths) || !isStringArray(directories)) {
    throw badRequest("Invalid import manifest");
  }
  return { paths, directories };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((one) => typeof one === "string");
}

/**
 * The managed directory may already exist, but none of its components may be
 * symlinks: a user-created `.armadra` symlink cannot redirect file writes.
 */
function ensureDirectory(path: string): void {
  const info = symlinkMetadata(path);
  if (info === undefined) {
    mkdirSync(path);
    return;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw forbidden("Import destination is not a regular directory");
  }
}

export interface ImportedFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly mimeType: string;
  readonly preview: "image" | "text" | "download";
}

export interface ImportResult {
  readonly path: string;
  readonly files: readonly ImportedFile[];
}

export class ImportBatch {
  private readonly staging: string;
  private readonly destination: string;
  private readonly relative: string;
  private bytes = 0;
  private readonly paths: string[] = [];
  private committed = false;

  private constructor(parent: string, prefix: string) {
    const base = canonicalDirectory(parent);
    const id = randomUUID();
    this.staging = join(base, `.pending-${id}`);
    mkdirSync(this.staging);
    this.destination = join(base, id);
    this.relative = prefix === "" ? id : `${prefix}/${id}`;
  }

  /** A batch that lands under `<workspace>/.armadra/imports/`. */
  static into(root: string): ImportBatch {
    const base = canonicalDirectory(root);
    ensureDirectory(join(base, MANAGED_DIRECTORY));
    ensureDirectory(join(base, MANAGED_DIRECTORY, "imports"));
    return new ImportBatch(
      join(base, MANAGED_DIRECTORY, "imports"),
      IMPORTS_DIRECTORY,
    );
  }

  /**
   * A browser folder becomes an independent workspace rooted in a managed
   * UUID directory. It never claims to be the browser's original folder.
   */
  static workspace(parent: string): ImportBatch {
    ensureDirectory(parent);
    return new ImportBatch(parent, "");
  }

  /** Where the committed copy will live. Only meaningful after `commit*`. */
  get path(): string {
    return this.destination;
  }

  directory(path: string): void {
    const relative = relativePath(path);
    let current = this.staging;
    for (const component of relative.split("/")) {
      current = join(current, component);
      ensureDirectory(current);
    }
  }

  write(path: string, bytes: Buffer): void {
    const relative = relativePath(path);
    if (
      this.paths.length >= MAX_FILES ||
      bytes.length > MAX_FILE_BYTES ||
      this.bytes + bytes.length > MAX_BATCH_BYTES
    ) {
      throw badRequest("Import exceeds the file count or size limit");
    }
    const cut = relative.lastIndexOf("/");
    if (cut !== -1) this.directory(relative.slice(0, cut));
    let handle: number;
    try {
      handle = openSync(
        join(this.staging, ...relative.split("/")),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw conflict("An imported file already exists");
      }
      throw error;
    }
    try {
      writeSync(handle, bytes);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    this.bytes += bytes.length;
    this.paths.push(relative);
  }

  /** Copy a file the desktop shell dropped in, from anywhere it may read. */
  copy(root: string, requested: string): void {
    const source = isAbsolute(requested)
      ? requested
      : join(root, relativePath(requested));
    rejectSymlinkComponents(source);
    const resolved = resolveImportSource(root, source);
    const name = resolved.slice(
      Math.max(resolved.lastIndexOf("/"), resolved.lastIndexOf("\\")) + 1,
    );
    if (name === "") throw badRequest("Invalid file name");
    this.write(this.availableCopyName(name), readFileSync(resolved));
  }

  /**
   * Desktop drops can include equally named files from different source
   * directories. Allocate in input order and keep the extension intact; files,
   * directories and symlinks all reserve their existing names. `write` still
   * opens exclusively, so a late collision cannot overwrite data.
   */
  private availableCopyName(name: string): string {
    relativePath(name);
    const dot = name.lastIndexOf(".");
    // A leading dot is a dotfile's whole name, not an extension: `.env` keeps
    // its name and becomes `.env-2`, never `-2.env`.
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot + 1) : undefined;
    let candidate = name;
    let ordinal = 2;
    while (symlinkMetadata(join(this.staging, candidate)) !== undefined) {
      candidate =
        extension === undefined
          ? `${stem}-${ordinal}`
          : `${stem}-${ordinal}.${extension}`;
      ordinal += 1;
    }
    return candidate;
  }

  commit(root: string): ImportResult {
    this.finish();
    return {
      path: this.relative,
      files: this.paths.map((path) =>
        fileInfo(root, `${this.relative}/${path}`),
      ),
    };
  }

  /**
   * Publish the directory and hand it to `register`, which turns it into a
   * workspace row. A `register` that throws takes the copy with it: the Rust
   * version leans on `Drop` for the same rollback, and the caller must not be
   * able to forget it.
   */
  commitWorkspace<T>(register: (path: string) => T): T {
    this.finish();
    try {
      return register(this.destination);
    } catch (error) {
      rmSync(this.destination, { recursive: true, force: true });
      throw error;
    }
  }

  /** Remove the staging directory of a batch that will not be committed. */
  discard(): void {
    if (this.committed) return;
    rmSync(this.staging, { recursive: true, force: true });
  }

  private finish(): void {
    // A UUID destination is never reused; a conflicting entry is an error.
    if (existsSync(this.destination)) {
      throw conflict("Import destination already exists");
    }
    renameSync(this.staging, this.destination);
    this.committed = true;
  }
}

/** `GET …/file-info` — what a card has to show before it opens anything. */
export function fileInfo(root: string, requested: string): ImportedFile {
  const base = canonicalDirectory(root);
  const path = resolveInRoot(base, requested);
  const info = metadata(path);
  if (info === undefined) throw badRequest("Requested path does not exist");
  if (!info.isFile()) throw badRequest("Requested path is not a file");
  const mime = mimeOrOctetStream(path);
  const preview: ImportedFile["preview"] = mime.startsWith("image/")
    ? "image"
    : info.size <= 1024 * 1024 && isText(path)
      ? "text"
      : "download";
  return {
    path: relativeToRoot(base, path),
    name: path.slice(
      Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1,
    ),
    size: info.size,
    mimeType: mime,
    preview,
  };
}

function isText(path: string): boolean {
  const bytes = readFileSync(path);
  return (
    bytes.length <= 1024 * 1024 &&
    !bytes.includes(0) &&
    isUtf8(bytes) &&
    !bytes.subarray(0, 5).equals(Buffer.from("%PDF-", "utf8")) &&
    !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  );
}

function isUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
