import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { resolveImportSource } from "../workspaces/roots";
import { badRequest, notFound } from "../workspaces/support";

/**
 * The whiteboard asset store: content-addressed, bounded, and served back
 * under a name nothing may turn into a path.
 *
 * A port of the pre-merge implementation. Three of its decisions are the
 * whole design and are kept verbatim:
 *
 *   * **The name is the content.** `<sha256[..16]>.<ext>` means re-uploading
 *     the same picture is a no-op and two boards that paste the same
 *     screenshot share one file. It is also what makes "check, then write"
 *     safe: a name that appeared in between holds the same bytes.
 *   * **The type comes from a table here, never from the client.** The
 *     extension ends up in a file name and the MIME is echoed back as a
 *     `Content-Type`, so a whitelist is the only acceptable source for both.
 *   * **The store lives with the workspace**, at `<root>/.armadra/assets/`,
 *     not under the data directory — an asset belongs to the project it was
 *     pasted into, travels with it, and is what an agent is handed a path to.
 */

/** What may be stored, and the extension each type gets. */
const ASSET_TYPES: readonly (readonly [string, string])[] = [
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
  ["image/avif", "avif"],
  ["image/bmp", "bmp"],
];

/**
 * Same ceiling as the whiteboard snapshot: an image that does not fit is one
 * nobody should be pasting onto a board.
 */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** Where assets live, relative to the workspace root. */
export const ASSETS_DIRECTORY = ".armadra/assets";

export interface StoredAsset {
  /** `<sha256[..16]>.<ext>`; also the last path segment of `url`. */
  readonly id: string;
  /** Workspace-relative path, which is what an agent is handed. */
  readonly path: string;
  /**
   * Core-**relative** URL. The client prefixes its own origin — the core does
   * not know which port it was actually bound to.
   */
  readonly url: string;
  readonly mimeType: string;
  readonly bytes: number;
}

export function assetExtension(mime: string): string | undefined {
  const normalised = (mime.split(";")[0] ?? "").trim().toLowerCase();
  return ASSET_TYPES.find(([candidate]) => candidate === normalised)?.[1];
}

/**
 * The stored extension for a file on disk, or `undefined` when it is not one
 * of the eight image types. Folded onto the table's spelling — `jpeg` is
 * stored as `jpg`, exactly as `image/jpeg` is.
 */
export function assetExtensionOfFile(path: string): string | undefined {
  const raw = extname(path).replace(/^\./, "").toLowerCase();
  if (raw === "") return undefined;
  const extension = raw === "jpeg" ? "jpg" : raw;
  return ASSET_TYPES.find(([, candidate]) => candidate === extension)?.[1];
}

export function assetMime(extension: string): string | undefined {
  return ASSET_TYPES.find(([, candidate]) => candidate === extension)?.[0];
}

function hex16(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * Copy already-validated bytes into `<root>/.armadra/assets/` under their
 * content hash and describe where they landed.
 *
 * Shared by the upload and the import route so the two dedupe against the same
 * names and answer with the same shape; only how the bytes were obtained
 * differs.
 */
export function storeAsset(
  root: string,
  workspaceId: string,
  extension: string,
  bytes: Buffer,
): StoredAsset {
  if (bytes.byteLength === 0) throw badRequest("Asset is empty");
  if (bytes.byteLength > MAX_ASSET_BYTES)
    throw badRequest("Asset is too large");

  const id = `${hex16(bytes)}.${extension}`;
  const relative = `${ASSETS_DIRECTORY}/${id}`;
  const file = join(root, ASSETS_DIRECTORY, id);
  // Content-addressed: an identical upload is already on disk, and rewriting
  // it would only risk tearing a file another tab is reading.
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    mkdirSync(join(root, ASSETS_DIRECTORY), { recursive: true });
    writeFileSync(file, bytes);
  }
  return {
    id,
    path: relative,
    url: `/api/workspaces/${workspaceId}/assets/${id}`,
    mimeType: assetMime(extension) ?? "application/octet-stream",
    bytes: bytes.byteLength,
  };
}

/**
 * Copy one already-on-disk image into the store.
 *
 * The metadata is asked first on purpose: a 4 GiB video should be refused, not
 * read into memory and then refused.
 */
export function importAssetAt(
  root: string,
  workspaceId: string,
  requested: string,
): StoredAsset {
  const source = resolveImportSource(root, requested);
  const extension = assetExtensionOfFile(source);
  if (extension === undefined) {
    throw badRequest("Asset type is not an accepted image type");
  }
  const info = statSync(source, { throwIfNoEntry: false });
  if (info === undefined) throw notFound("Requested path does not exist");
  if (info.size > MAX_ASSET_BYTES) throw badRequest("Asset is too large");
  let bytes: Buffer;
  try {
    bytes = readFileSync(source);
  } catch (error) {
    throw badRequest(`Asset could not be read: ${String(error)}`);
  }
  return storeAsset(root, workspaceId, extension, bytes);
}

/** `data:image/png;base64,…` — the only data-URL form accepted. */
export function decodeAssetDataUrl(source: string): {
  readonly extension: string;
  readonly bytes: Buffer;
} {
  if (!source.startsWith("data:")) throw badRequest("Asset is not a data URL");
  const rest = source.slice("data:".length);
  const comma = rest.indexOf(",");
  if (comma < 0) throw badRequest("Asset is not a data URL");
  const meta = rest.slice(0, comma);
  const payload = rest.slice(comma + 1);
  if (!meta.endsWith(";base64")) {
    throw badRequest("Only base64 data URLs are accepted");
  }
  const extension = assetExtension(meta.slice(0, -";base64".length));
  if (extension === undefined) {
    throw badRequest("Asset type is not an accepted image type");
  }
  const trimmed = payload.trim();
  const bytes = Buffer.from(trimmed, "base64");
  // `Buffer.from` never fails; it stops at the first byte it cannot read, so
  // the round trip is what actually decides whether this was base64.
  if (
    bytes.toString("base64").replace(/=+$/, "") !== trimmed.replace(/=+$/, "")
  ) {
    throw badRequest("Asset is not valid base64");
  }
  return { extension, bytes };
}

/**
 * The bytes behind one asset id.
 *
 * The id is matched against the shape the uploader mints rather than resolved
 * as a path, which is what keeps a crafted id from reading somewhere else in
 * the workspace: sixteen hex digits, a dot, and one of eight extensions.
 */
export function readAsset(
  root: string,
  assetId: string,
): { readonly mime: string; readonly bytes: Buffer } {
  const dot = assetId.lastIndexOf(".");
  if (dot < 0) throw badRequest("Asset id is invalid");
  const hash = assetId.slice(0, dot);
  const extension = assetId.slice(dot + 1);
  const mime = assetMime(extension);
  if (
    mime === undefined ||
    hash.length !== 16 ||
    !/^[0-9a-fA-F]{16}$/.test(hash)
  ) {
    throw badRequest("Asset id is invalid");
  }
  try {
    return { mime, bytes: readFileSync(join(root, ASSETS_DIRECTORY, assetId)) };
  } catch {
    throw notFound("Asset was not found");
  }
}
