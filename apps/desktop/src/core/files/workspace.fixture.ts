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
    // Windows 不让删还被进程当 cwd 占着的目录；在本机跑的 Worker 被结束后，
    // 它拉起的语言服务要读到 stdin 的 EOF 才退，重试等它这一下。
    remove: () =>
      rmSync(path, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      }),
  };
}
