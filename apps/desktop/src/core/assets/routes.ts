import type { CoreContext } from "../main";
import { executeOn, isRemote } from "../remote/execute";
import {
  INLINE_FILE_BYTES,
  INLINE_TOTAL_BYTES,
  discard,
  upload,
} from "../remote/transfer";
import { answered, workspaceId } from "../workspaces/routes";
import { canonicalDirectory } from "../workspaces/roots";
import {
  DomainError,
  badRequest,
  jsonObject,
  optionalString,
} from "../workspaces/support";
import { getWorkspace } from "../workspaces/table";
import { writePngExport } from "./exports";
import {
  assetExtension,
  assetMime,
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
 * The store follows the workspace. On a remote one every route runs on its
 * execution host through the Worker (`assets.*`): the bytes go there — in the
 * frame when small, as a chunked transfer (`remote/transfer.ts`) otherwise —
 * and are read back from there. Nothing lands on this machine's disk at the
 * same path.
 */

export function install(context: CoreContext): void {
  const database = context.db.database;
  const { server } = context;

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/exports/{exportId}/png",
    answered(async (match, request) => {
      const workspace = getWorkspace(database, workspaceId(match));
      if (!workspace.permissions.write) {
        throw new DomainError(
          403,
          "forbidden",
          "This workspace is opened read-only",
        );
      }
      const body = jsonObject(request.body);
      const dataUrl = optionalString(body, "dataUrl");
      if (dataUrl === undefined) {
        throw badRequest("Export body is not a JSON data URL");
      }
      if (isRemote(workspace)) {
        const exportId = match.params.exportId ?? "";
        return {
          status: 200,
          body: await withStaged(
            workspace,
            Buffer.from(dataUrl, "utf8"),
            INLINE_TOTAL_BYTES,
            (carried) =>
              executeOn(workspace, "assets.exportPng", {
                exportId,
                ...(carried.transfer === undefined
                  ? { dataUrl }
                  : { transfer: carried.transfer }),
              }),
          ),
        };
      }
      return {
        status: 200,
        body: writePngExport(
          canonicalDirectory(workspace.rootPath),
          match.params.exportId ?? "",
          dataUrl,
        ),
      };
    }),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/assets",
    answered(async (match, request) => {
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
      if (isRemote(workspace)) {
        const mimeType = assetMime(extension) ?? "application/octet-stream";
        return {
          status: 200,
          body: await withStaged(
            workspace,
            bytes,
            INLINE_FILE_BYTES,
            (carried) =>
              executeOn(workspace, "assets.store", {
                workspaceId: workspace.id,
                mimeType,
                ...(carried.transfer === undefined
                  ? { base64: bytes.toString("base64") }
                  : { transfer: carried.transfer }),
              }),
          ),
        };
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
    answered(async (match, request) => {
      const workspace = getWorkspace(database, workspaceId(match));
      const body = jsonObject(request.body);
      const path = optionalString(body, "path");
      if (path === undefined) throw badRequest("Requested path is invalid");
      if (isRemote(workspace)) {
        // The path names a file on the execution host, inside the workspace.
        return {
          status: 200,
          body: await executeOn(workspace, "assets.import", {
            workspaceId: workspace.id,
            path,
          }),
        };
      }
      return {
        status: 200,
        body: importAssetAt(localRoot(workspace), workspace.id, path),
      };
    }),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/assets/{assetId}",
    answered(async (match) => {
      const workspace = getWorkspace(database, workspaceId(match));
      const assetId = match.params.assetId ?? "";
      const { mime, bytes } = isRemote(workspace)
        ? await readRemoteAsset(workspace, assetId)
        : readAsset(localRoot(workspace), assetId);
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

async function readRemoteAsset(
  workspace: { readonly rootPath: string; readonly executionHostId?: string },
  assetId: string,
): Promise<{ readonly mime: string; readonly bytes: Buffer }> {
  const answer = (await executeOn(workspace, "assets.read", { assetId })) as {
    mime: string;
    base64: string;
  };
  return { mime: answer.mime, bytes: Buffer.from(answer.base64, "base64") };
}

/**
 * Run `send` with `bytes` either in its frame or staged ahead as a chunked
 * transfer, whichever their size calls for; a staged transfer the call did
 * not consume is taken back.
 */
async function withStaged<T>(
  workspace: { readonly rootPath: string; readonly executionHostId?: string },
  bytes: Buffer,
  inlineLimit: number,
  send: (carried: { readonly transfer?: string }) => Promise<T>,
): Promise<T> {
  if (bytes.byteLength <= inlineLimit) return await send({});
  const transfer = await upload(workspace, bytes);
  try {
    return await send({ transfer });
  } catch (failure) {
    await discard(workspace, transfer);
    throw failure;
  }
}

/**
 * The workspace's own directory, canonicalised. Only for a local workspace:
 * the remote one goes through the Worker above, so this refuses rather than
 * guessing at a path on the wrong disk.
 */
function localRoot(workspace: {
  readonly rootPath: string;
  readonly executionHostId?: string;
}): string {
  if ((workspace.executionHostId ?? "") !== "") {
    throw new DomainError(
      500,
      "internal_error",
      "A remote workspace's assets are on its execution host",
    );
  }
  return canonicalDirectory(workspace.rootPath);
}
