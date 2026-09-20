import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markManagedDirectory } from "../files/paths";
import { badRequest } from "../workspaces/support";

/**
 * `POST /api/workspaces/{id}/exports/{exportId}/png` — a whiteboard export.
 *
 * Whatever is on the whiteboard — ink, a shape, a whole frame — only exists
 * as vectors inside the browser's whiteboard document, so the one party that
 * can rasterise it is the page. It uploads the PNG as a data URL and the core
 * drops the bytes at `<workspace>/.armadra/exports/<exportId>.png`, which is
 * the path a linked agent is handed (`ContextLink.content.pngPath`).
 *
 * The export id is not required to be a node: the thing exported is usually
 * a plain whiteboard item, which has no row anywhere. It only has to be a
 * uuid, which is what keeps the file name from being a path.
 */

export const EXPORTS_DIRECTORY = ".armadra/exports";
/** A 480×360 whiteboard is tens of kilobytes; the cap stops a runaway client. */
export const MAX_EXPORT_PNG_BYTES = 8 * 1024 * 1024;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExportPngResult {
  /** Absolute path, which is what an agent is told to open. */
  readonly path: string;
  /** The same file relative to the workspace root. */
  readonly relativePath: string;
  readonly bytes: number;
}

export function writePngExport(
  root: string,
  exportId: string,
  dataUrl: string,
): ExportPngResult {
  if (!UUID.test(exportId)) throw badRequest("Export id is invalid");
  if (dataUrl.length > MAX_EXPORT_PNG_BYTES) {
    throw badRequest("Exported image is too large");
  }
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw badRequest("Only base64 PNG data URLs are accepted");
  }
  const payload = dataUrl.slice(PNG_DATA_URL_PREFIX.length).trim();
  if (payload === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw badRequest("Exported image is not valid base64");
  }
  const bytes = Buffer.from(payload, "base64");
  const directory = join(root, EXPORTS_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  markManagedDirectory(join(root, ".armadra"));
  const path = join(directory, `${exportId}.png`);
  writeFileSync(path, bytes);
  return {
    path,
    relativePath: `${EXPORTS_DIRECTORY}/${exportId}.png`,
    bytes: bytes.length,
  };
}
