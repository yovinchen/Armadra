import type { CoreContext } from "../main";
import { answered, workspaceId } from "../workspaces/routes";
import { canonicalDirectory } from "../workspaces/roots";
import {
  DomainError,
  badRequest,
  jsonObject,
  optionalString,
} from "../workspaces/support";
import { getWorkspace } from "../workspaces/table";
import {
  assetExtension,
  decodeAssetDataUrl,
  importAssetAt,
  readAsset,
  storeAsset,
} from "./store";

/**
 * `/api/workspaces/{id}/assets` — upload, import from a path, and read-back.
 *
 * An upload takes two body shapes because the client has two kinds of source:
 * a `File`/`Blob` is posted raw with its own `Content-Type`, while an
 * already-decoded `data:` URL — a paste, a drag from another page — is posted
 * as `{"dataUrl": "…"}` with `Content-Type: application/json`. Both end in the
 * same content-addressed file.
 *
 * Remote workspaces are R5's: on this build the store follows the workspace,
 * and a workspace whose files are on an execution host has no local root to
 * put bytes in. That case refuses rather than writing to the wrong disk.
 */

export function install(context: CoreContext): void {
  const database = context.db.database;
  const { server } = context;

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/assets",
    answered((match, request) => {
      const workspace = getWorkspace(database, workspaceId(match));
      if (!workspace.permissions.write) {
        throw new DomainError(
          403,
          "forbidden",
          "This workspace is opened read-only",
        );
      }
      const contentType = String(request.headers["content-type"] ?? "");
      let extension: string;
      let bytes: Buffer;
      if (contentType.startsWith("application/json")) {
        const body = jsonObject(request.body);
        const dataUrl = optionalString(body, "dataUrl");
        if (dataUrl === undefined) {
          throw badRequest("Asset body is not a JSON data URL");
        }
        ({ extension, bytes } = decodeAssetDataUrl(dataUrl));
      } else {
        const known = assetExtension(contentType);
        if (known === undefined) {
          throw badRequest("Asset type is not an accepted image type");
        }
        extension = known;
        bytes = request.body;
      }
      return {
        status: 200,
        body: storeAsset(localRoot(workspace), workspace.id, extension, bytes),
      };
    }),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/assets/import",
    answered((match, request) => {
      const workspace = getWorkspace(database, workspaceId(match));
      const body = jsonObject(request.body);
      const path = optionalString(body, "path");
      if (path === undefined) throw badRequest("Requested path is invalid");
      return {
        status: 200,
        body: importAssetAt(localRoot(workspace), workspace.id, path),
      };
    }),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/assets/{assetId}",
    answered((match) => {
      const workspace = getWorkspace(database, workspaceId(match));
      const assetId = match.params.assetId ?? "";
      const { mime, bytes } = readAsset(localRoot(workspace), assetId);
      return {
        status: 200,
        raw: bytes,
        headers: {
          "content-type": mime,
          // The name is a content hash, so the bytes behind a given URL never
          // change and the response may be cached forever.
          "cache-control": "public, max-age=31536000, immutable",
          // An SVG is served as an image and must never be sniffed into a
          // document; the header costs nothing on the other seven types.
          "x-content-type-options": "nosniff",
        },
      };
    }),
  );
}

/**
 * The workspace's own directory, canonicalised.
 *
 * A remote workspace has no local root, and a picture must follow the project
 * rather than land on the controller's disk — so this refuses instead of
 * guessing. R5 brings the execution-host half back.
 */
function localRoot(workspace: {
  readonly rootPath: string;
  readonly executionHostId?: string;
}): string {
  if ((workspace.executionHostId ?? "") !== "") {
    throw new DomainError(501, "unsupported", "执行主机上的画布资产（R5）");
  }
  return canonicalDirectory(workspace.rootPath);
}
