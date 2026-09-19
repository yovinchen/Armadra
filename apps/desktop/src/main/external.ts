import { app, shell } from "electron";
import { ipcRejection } from "../shared/ipc";
import {
  SCHEME_NOT_ALLOWED,
  isAllowedExternalUrl,
} from "../shell-core/external-url";
import { PATH_NOT_ALLOWED, revealablePath } from "../shell-core/reveal-path";
import { dataDir } from "../shell-core/paths";

/**
 * `shell.openExternal`, behind the allow-list in
 * `shell-core/external-url.ts`.
 *
 * This is the one call in the surface that leaves the sandbox entirely, and
 * the page is not the author of the URLs that reach it — a Markdown link in an
 * agent's answer, a redirect in a browser node and a remote announcement feed
 * all arrive here. The refusal is a rejection with a `{ code, message }`, not a
 * silent no-op: a link that does nothing reads as a broken app, while a named
 * code lets the page say why.
 */
export async function openExternal(url: unknown): Promise<void> {
  if (!isAllowedExternalUrl(url))
    throw ipcRejection(
      SCHEME_NOT_ALLOWED,
      "only http and https links may be opened outside the app",
    );
  await shell.openExternal(url);
}

/**
 * The roots a reveal may open, resolved at call time.
 *
 * `app.getPath("downloads")` is read here rather than captured at module load
 * because Electron only answers it once the app is ready, and this module is
 * imported before that.
 */
export function revealRoots(): string[] {
  const roots = [dataDir()];
  try {
    roots.push(app.getPath("downloads"));
  } catch {
    // A platform with no downloads directory simply has one fewer root; it is
    // not a reason to refuse to reveal the data directory.
  }
  return roots;
}

/**
 * `shell.showItemInFolder`, behind the root allow-list in
 * `shell-core/reveal-path.ts`.
 *
 * This is NOT `openExternal` with a `file://` URL, and the allow-list is why:
 * `openExternal` resolves a scheme against the operating system's handler
 * table, so admitting `file:` there would admit every other consumer of that
 * table too. Revealing does one thing — open a file manager window on a path
 * inside a directory this shell owns — and can therefore be allowed without
 * widening anything else.
 */
export function showItemInFolder(path: unknown): void {
  const allowed = revealablePath(path, revealRoots());
  if (allowed === null)
    throw ipcRejection(
      PATH_NOT_ALLOWED,
      "only paths inside the data or downloads directory may be revealed",
    );
  shell.showItemInFolder(allowed);
}
