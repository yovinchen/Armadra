import { type Stats, lstatSync, statSync } from "node:fs";

/**
 * `fs::metadata` and `fs::symlink_metadata`, in the shape the rest of the
 * domain wants them: `undefined` for "not there", a throw for anything else.
 *
 * Node's `throwIfNoEntry: false` only covers `ENOENT`. A path whose parent is
 * not searchable answers `EACCES`, and that is a refusal the caller has to see
 * rather than a file it may treat as absent — which is why this does not
 * swallow every error the way a `try {} catch { return undefined }` would.
 */

export function metadata(path: string): Stats | undefined {
  return statSync(path, { throwIfNoEntry: false });
}

export function symlinkMetadata(path: string): Stats | undefined {
  return lstatSync(path, { throwIfNoEntry: false });
}

/**
 * `Permissions::readonly()`: no write bit set for anybody.
 *
 * Rust asks the same question of the same mode word, and Node reports the mode
 * on every platform it supports. On Windows the mode is synthesised from the
 * read-only attribute, which is exactly the bit the editor means.
 */
export function isReadonly(info: Stats): boolean {
  return (info.mode & 0o222) === 0;
}
