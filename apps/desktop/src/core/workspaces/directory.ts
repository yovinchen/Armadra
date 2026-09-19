import { lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, parse, sep } from "node:path";
import { canonicalDirectory, prepareNewDirectory } from "./roots";
import { badRequest, forbidden } from "./support";

/**
 * Registering a directory as a workspace root, and creating one on request.
 *
 * `POST /api/workspaces/open-directory` is the desktop picker's route: the
 * folder already exists and nothing is copied, so the only questions are
 * whether the path is one the caller may name at all and whether any segment
 * of it is a symlink. The symlink check is per segment rather than on the leaf
 * because a link halfway up is exactly as effective at pointing the root
 * somewhere else.
 */

/** Every segment of `path` below the root, as absolute prefixes. */
function prefixes(path: string): string[] {
  const { root } = parse(path);
  const rest = path.slice(root.length).split(sep).filter(Boolean);
  const answer: string[] = [];
  let current = root;
  for (const segment of rest) {
    current = current.endsWith(sep)
      ? current + segment
      : current + sep + segment;
    answer.push(current);
  }
  return answer;
}

/**
 * A drive letter and a root are not filesystem entries of their own — statting
 * a bare `C:` fails — and neither can be a symlink, so only what hangs below
 * them is checked.
 */
export function rejectSymlinkComponents(path: string): void {
  for (const prefix of prefixes(path)) {
    const info = lstatSync(prefix, { throwIfNoEntry: false });
    if (info === undefined) {
      throw badRequest("Workspace root does not exist or cannot be accessed");
    }
    if (info.isSymbolicLink()) {
      throw forbidden("Symbolic links cannot be imported");
    }
  }
}

/** The canonical root behind an "open this folder" request. */
export function directorySource(path: string): string {
  if (!isAbsolute(path) || path.split(/[/\\]/).includes("..")) {
    throw badRequest(
      "Folder source must be an absolute path without traversal",
    );
  }
  rejectSymlinkComponents(path);
  return canonicalDirectory(path);
}

/**
 * `mkdir` one level for `createDirectory: true`.
 *
 * Splitting the requested path into parent and leaf keeps the whole check in
 * `roots.ts`: the parent is canonicalised and screened, and an existing leaf
 * is a 409 rather than a silent reuse.
 */
export function createRootDirectory(rootPath: string): void {
  const requested = rootPath.replace(/[/\\]+$/, "");
  const separator =
    requested.lastIndexOf("/") >= requested.lastIndexOf("\\")
      ? requested.lastIndexOf("/")
      : requested.lastIndexOf("\\");
  if (separator <= 0) throw badRequest("The parent directory is missing");
  const parent = requested.slice(0, separator);
  const name = requested.slice(separator + 1);
  if (parent === "") throw badRequest("The parent directory is missing");
  if (name === "") throw badRequest("Folder name is invalid");
  mkdirSync(prepareNewDirectory(parent, name));
}
