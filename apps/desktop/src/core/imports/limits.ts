/**
 * What one import may weigh, and where the copies live.
 *
 * Its own module because `core/files` needs `MAX_FILE_BYTES` for the download
 * ceiling and `core/imports` needs all three — importing the batch just to
 * read a number would make the two domains circular.
 */

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 256;

/**
 * What one import into a remote workspace may weigh when its Worker cannot
 * take chunked transfers (no `remote.transfer.v1`).
 *
 * Then the bytes travel inside one Worker frame, base64'd, and a frame is at
 * most 16 MiB; 11 MiB of content is what fits with room for the envelope. A
 * current Worker takes the local limits, the big files chunked ahead of the
 * publishing frame (`remote/transfer.ts`).
 */
export const MAX_REMOTE_IMPORT_BYTES = 11 * 1024 * 1024;

/** Where an import's copies land, relative to the workspace root. */
export const IMPORTS_DIRECTORY = ".armadra/imports";

/** The managed folder the imports, assets, exports and trash share. */
export const MANAGED_DIRECTORY = ".armadra";

/** A manifest above this size is refused before it is parsed. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;
