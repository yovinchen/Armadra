import { shell } from "electron";
import { ipcRejection } from "../shared/ipc";
import {
  SCHEME_NOT_ALLOWED,
  isAllowedExternalUrl,
} from "../shell-core/external-url";

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
