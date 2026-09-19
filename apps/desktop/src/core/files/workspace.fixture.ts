import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "../workspaces/roots";

/**
 * A throwaway directory that stands in for a workspace root.
 *
 * Canonicalised for the same reason `workspaces/fixture.ts` canonicalises its
 * own: on macOS `os.tmpdir()` lives under `/var`, which is a symlink to
 * `/private/var`, and every resolver in this domain answers with the real
 * path. A test that compared against the uncanonicalised spelling would fail
 * on the platform rather than on the code.
 */
export interface Temporary {
  readonly path: string;
  remove(): void;
}

export function temporary(prefix = "armadra-files-"): Temporary {
  const path = canonicalize(mkdtempSync(join(tmpdir(), prefix)));
  return {
    path,
    remove: () => rmSync(path, { recursive: true, force: true }),
  };
}
