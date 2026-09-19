import { badRequest } from "../workspaces/support";

/**
 * `multipart/form-data`, parsed from a buffered body.
 *
 * Hand-written, and the reason is the shape of what it has to read rather
 * than a dislike of dependencies. The two import routes take a body the core
 * has already buffered — `core/http/server.ts` reads it under the body
 * ceiling before any handler runs — so the streaming that `busboy` and
 * `formidable` exist to provide has nowhere to happen here, and what would be
 * left of them is a boundary split and a header parse. Both libraries also
 * bring their own temporary-file handling, and this domain writes its bytes
 * into a staging directory it controls (`batch.ts`); a second place that
 * decides where an upload lands is precisely what an import must not have.
 *
 * What it implements of RFC 7578 is what a browser `FormData` produces and
 * what the front end sends: a boundary from the `Content-Type`, `--boundary`
 * delimiters, CRLF-separated part headers, and `Content-Disposition: form-data;
 * name="…"`. Field names are the only header value read; a filename is parsed
 * but never trusted — the import manifest decides where each part goes, which
 * is the rule `apps/runtime/src/imports.rs` states and this preserves.
 */

export interface MultipartField {
  readonly name: string;
  /** The client's filename, for diagnostics only. Never a destination. */
  readonly filename?: string;
  readonly bytes: Buffer;
}

const DASH = 0x2d;
const CR = 0x0d;
const LF = 0x0a;

/**
 * The boundary token of a `multipart/form-data` content type, or `undefined`
 * when this is not one.
 */
export function boundaryOf(
  contentType: string | undefined,
): string | undefined {
  if (contentType === undefined) return undefined;
  const [type, ...parameters] = contentType.split(";");
  if ((type ?? "").trim().toLowerCase() !== "multipart/form-data") {
    return undefined;
  }
  for (const parameter of parameters) {
    const cut = parameter.indexOf("=");
    if (cut === -1) continue;
    if (parameter.slice(0, cut).trim().toLowerCase() !== "boundary") continue;
    const value = parameter.slice(cut + 1).trim();
    const unquoted =
      value.startsWith('"') && value.endsWith('"') && value.length >= 2
        ? value.slice(1, -1)
        : value;
    return unquoted === "" ? undefined : unquoted;
  }
  return undefined;
}

/**
 * Every part of `body`, in the order they were sent — which is the order the
 * import protocol depends on: the manifest must come first.
 */
export function parseMultipart(
  body: Buffer,
  contentType: string | undefined,
): MultipartField[] {
  const boundary = boundaryOf(contentType);
  if (boundary === undefined) throw badRequest("Invalid file upload");
  const delimiter = Buffer.from(`--${boundary}`, "utf8");
  const fields: MultipartField[] = [];

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) throw badRequest("Invalid file upload");
  cursor += delimiter.length;
  for (;;) {
    // `--` after the delimiter closes the body; anything else must be the
    // CRLF that starts the next part.
    if (body[cursor] === DASH && body[cursor + 1] === DASH) return fields;
    if (body[cursor] === CR && body[cursor + 1] === LF) cursor += 2;
    else if (body[cursor] === LF) cursor += 1;
    else throw badRequest("Invalid file upload");

    const blank = endOfHeaders(body, cursor);
    if (blank === undefined) throw badRequest("Incomplete file upload");
    const headers = body.subarray(cursor, blank.headerEnd).toString("utf8");
    const next = body.indexOf(delimiter, blank.bodyStart);
    if (next === -1) throw badRequest("Incomplete file upload");
    // The delimiter is preceded by the CRLF that terminates the part's body,
    // and that CRLF belongs to the delimiter rather than to the content.
    let end = next;
    if (body[end - 1] === LF) end -= 1;
    if (body[end - 1] === CR) end -= 1;
    const disposition = contentDisposition(headers);
    if (disposition === undefined) throw badRequest("Invalid file upload");
    fields.push({
      name: disposition.name,
      ...(disposition.filename === undefined
        ? {}
        : { filename: disposition.filename }),
      bytes: body.subarray(blank.bodyStart, end),
    });
    cursor = next + delimiter.length;
  }
}

/** Where the part's headers stop and its bytes start. */
function endOfHeaders(
  body: Buffer,
  from: number,
): { readonly headerEnd: number; readonly bodyStart: number } | undefined {
  for (let index = from; index < body.length; index += 1) {
    if (
      body[index] === CR &&
      body[index + 1] === LF &&
      body[index + 2] === CR &&
      body[index + 3] === LF
    ) {
      return { headerEnd: index, bodyStart: index + 4 };
    }
    // A client that writes bare LFs is still readable, and refusing it would
    // only make the failure harder to explain than the upload is to accept.
    if (body[index] === LF && body[index + 1] === LF) {
      return { headerEnd: index, bodyStart: index + 2 };
    }
  }
  return undefined;
}

/** `name` and `filename` from the part's `Content-Disposition`. */
function contentDisposition(
  headers: string,
): { readonly name: string; readonly filename?: string } | undefined {
  for (const line of headers.split(/\r?\n/)) {
    const cut = line.indexOf(":");
    if (cut === -1) continue;
    if (line.slice(0, cut).trim().toLowerCase() !== "content-disposition") {
      continue;
    }
    const value = line.slice(cut + 1);
    const name = parameter(value, "name");
    if (name === undefined) return undefined;
    const filename = parameter(value, "filename");
    return filename === undefined ? { name } : { name, filename };
  }
  return undefined;
}

function parameter(value: string, wanted: string): string | undefined {
  const quoted = new RegExp(`(?:^|;)\\s*${wanted}\\s*=\\s*"([^"]*)"`, "i").exec(
    value,
  );
  if (quoted !== null) return (quoted[1] as string).replace(/\\"/g, '"');
  const bare = new RegExp(`(?:^|;)\\s*${wanted}\\s*=\\s*([^;\\s]+)`, "i").exec(
    value,
  );
  return bare === null ? undefined : (bare[1] as string);
}
