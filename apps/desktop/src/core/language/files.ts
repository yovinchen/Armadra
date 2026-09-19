import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The language domain's view of the filesystem: the editor's own read and
 * save, from `core/files`, and nothing of its own.
 *
 * A `WorkspaceEdit` is a save the editor did not type, so it must go through
 * exactly the gate the editor's `PUT …/file` goes through — the same root
 * confinement, the same SHA-256 version check, the same temp-file-then-rename
 * — or a language server could write what a save could not. Re-exporting is
 * what makes that one gate rather than two that agree today.
 */
export {
  type FileContent,
  MAX_WRITE_FILE_SIZE,
  readTextFile,
} from "../files/read";
export { type FileWriteResult, writeTextFile } from "../files/write";

/** For tests that need a throwaway root. */
export function temporaryRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
