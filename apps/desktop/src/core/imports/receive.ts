import { badRequest } from "../workspaces/support";
import {
  type ImportBatch,
  type ImportManifest,
  manifestOf,
  validateManifest,
} from "./batch";
import { MAX_FILE_BYTES, MAX_MANIFEST_BYTES } from "./limits";
import { type MultipartField } from "./multipart";

/**
 * The upload protocol: a JSON manifest first, then the files it named.
 *
 * The first multipart field is the manifest; every later field's **name** is
 * its zero-based index into `manifest.paths`. Client filenames are never
 * trusted for anything — the manifest decides where each part lands, and a
 * part that does not correspond to an entry in it is refused rather than
 * dropped somewhere plausible.
 *
 * A port of `imports::read_manifest` / `imports::receive_files`. The Rust
 * versions stream the parts; this one reads them out of the body the server
 * already buffered, so the per-file ceiling is checked against the finished
 * part rather than as it arrives. Both refuse the same uploads.
 */

export function readManifest(
  fields: readonly MultipartField[],
  allowEmptyRoot: boolean,
): ImportManifest {
  const first = fields[0];
  if (first === undefined) throw badRequest("Import manifest is missing");
  if (first.name !== "manifest") {
    throw badRequest("Import manifest must come first");
  }
  if (first.bytes.length > MAX_MANIFEST_BYTES) {
    throw badRequest("Import manifest is too large");
  }
  const manifest = manifestOf(first.bytes);
  const empty =
    manifest.paths.length === 0 && manifest.directories.length === 0;
  if (!(allowEmptyRoot && empty)) validateManifest(manifest);
  return manifest;
}

export function receiveFiles(
  fields: readonly MultipartField[],
  batch: ImportBatch,
  manifest: ImportManifest,
): void {
  for (const directory of manifest.directories) batch.directory(directory);
  const received = new Set<number>();
  for (const field of fields.slice(1)) {
    const index = Number(field.name);
    if (
      !/^\d+$/.test(field.name) ||
      !Number.isSafeInteger(index) ||
      index >= manifest.paths.length
    ) {
      throw badRequest("Unexpected imported file");
    }
    if (received.has(index)) throw badRequest("Duplicate imported file");
    received.add(index);
    if (field.bytes.length > MAX_FILE_BYTES) {
      throw badRequest("A file exceeds the 16 MiB import limit");
    }
    batch.write(manifest.paths[index] as string, field.bytes);
  }
  if (received.size !== manifest.paths.length) {
    throw badRequest("Some imported files are missing");
  }
}
