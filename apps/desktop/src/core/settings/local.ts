/**
 * `<data dir>/worker-settings.json` — the preferences that belong to *this*
 * execution host.
 *
 * Everything else in `settings.json` describes the account and follows it to
 * whichever machine the person opens Armadra on. A handful of keys do not:
 * which terminal backend this box actually has, where its browser binary is,
 * whether it may be kept awake, where its language servers live and what the
 * last probe of them found. Storing those with the account means the laptop's
 * `/opt/homebrew/bin/…` path travels to a Linux build box and points at
 * nothing.
 *
 * Two files, one document. The store merges them on load and splits again on
 * every write, so nothing else has to know there are two: `GET /api/settings`
 * still answers with one object, and a patch still names `terminal.backend`
 * rather than a file.
 *
 * Ported from the pre-merge implementation, path for path. The file
 * format and the split are the same bytes on both sides on purpose: during the
 * changeover a person may run the Rust Runtime one morning and the TypeScript
 * core the next, and the machine's own preferences must not be forgotten in
 * between.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * The dotted paths that stay on the execution host.
 *
 * A path, not a top-level key: `terminal` also holds `detachedGraceMinutes`,
 * which is a preference about how long a detached session is kept and is
 * exactly as true on a laptop as on a build box. Splitting whole sections
 * would drag those across too.
 *
 * | Path                     | Why it is local                                                                |
 * | ------------------------ | ------------------------------------------------------------------------------ |
 * | `terminal.backend`       | tmux exists on one machine and not the other; `sessionHost` is Windows only    |
 * | `browser.executablePath` | An absolute path to a binary on one filesystem                                 |
 * | `power.policy`           | Whether *this* machine may be held awake; a laptop and a server disagree       |
 * | `power.keepAwakeWhileWorking` | Same question, asked of the automatic lease while agents work             |
 * | `agents.probes`          | The CLI version cache — what was found on this box's PATH                      |
 * | `language.probes`        | Same, for language servers                                                     |
 * | `language.servers`       | Per-server executable path and argument overrides, resolved on this filesystem |
 *
 * `agents.custom[]` is deliberately **not** here: a custom agent definition is
 * what the user configured, and it is meant to follow them. Only the probe
 * cache underneath it is local.
 */
export const LOCAL_PATHS: readonly (readonly string[])[] = [
  ["terminal", "backend"],
  ["browser", "executablePath"],
  ["power", "policy"],
  ["power", "keepAwakeWhileWorking"],
  ["agents", "probes"],
  ["language", "probes"],
  ["language", "servers"],
];

/** The same paths as dotted strings, for the settings page and for tests. */
export function localPaths(): string[] {
  return LOCAL_PATHS.map((path) => path.join("."));
}

/**
 * Whether a dotted path is stored on the execution host rather than with the
 * account. A path *under* a local one is local too: `language.servers.rust`
 * travels with `language.servers`.
 */
export function isLocal(path: string): boolean {
  const segments = path.split(".");
  return LOCAL_PATHS.some(
    (local) =>
      segments.length >= local.length &&
      local.every((part, index) => segments[index] === part),
  );
}

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function take(
  document: JsonObject,
  path: readonly string[],
): JsonValue | undefined {
  const [head, ...rest] = path;
  if (head === undefined) return undefined;
  if (rest.length === 0) {
    if (!(head in document)) return undefined;
    const value = document[head];
    delete document[head];
    return value;
  }
  const nested = document[head];
  if (!isJsonObject(nested)) return undefined;
  const taken = take(nested, rest);
  // A section that only ever held local keys must not survive as `{}`: an
  // empty `language` object in the shared document would read as "the user
  // cleared their language settings" on the next machine.
  if (Object.keys(nested).length === 0) delete document[head];
  return taken;
}

function put(
  document: JsonObject,
  path: readonly string[],
  value: JsonValue,
): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    document[head] = value;
    return;
  }
  const existing = document[head];
  const nested: JsonObject = isJsonObject(existing) ? existing : {};
  document[head] = nested;
  put(nested, rest, value);
}

function read(
  document: JsonObject,
  path: readonly string[],
): JsonValue | undefined {
  const [head, ...rest] = path;
  if (head === undefined) return undefined;
  const value = document[head];
  if (value === undefined) return undefined;
  if (rest.length === 0) return value;
  return isJsonObject(value) ? read(value, rest) : undefined;
}

/** A structural clone that keeps the JSON typing. */
export function clone<T extends JsonValue>(value: T): T {
  return (
    value === null || typeof value !== "object"
      ? value
      : JSON.parse(JSON.stringify(value))
  ) as T;
}

/**
 * Split one document into the part that follows the account and the part that
 * stays here. The two together are always the whole document: nothing is
 * dropped, and a key that is in neither file did not exist.
 */
export function split(document: JsonValue): {
  shared: JsonObject;
  local: JsonObject;
} {
  const shared: JsonObject = isJsonObject(document) ? clone(document) : {};
  const local: JsonObject = {};
  for (const path of LOCAL_PATHS) {
    const value = take(shared, path);
    if (value !== undefined) put(local, path, value);
  }
  return { shared, local };
}

/**
 * Overlay the execution host's document on the account's.
 *
 * The local file wins for every local path, and only for those: a stale
 * `settings.json` that still carries `terminal.backend` (one written before the
 * split, or by an older build) does not get to decide which backend this
 * machine uses.
 */
export function overlay(shared: JsonValue, local: JsonValue): JsonObject {
  const document: JsonObject = isJsonObject(shared) ? clone(shared) : {};
  const localObject: JsonObject = isJsonObject(local) ? clone(local) : {};
  for (const path of LOCAL_PATHS) {
    const value = read(localObject, path);
    if (value !== undefined) {
      put(document, path, value);
      continue;
    }
    // Not "leave whatever the shared document had": the whole point is that
    // these keys are answered by this machine or not at all, and `normalize`
    // fills a missing one with the default.
    take(document, path);
  }
  return document;
}

/**
 * The same document with every object's keys in ascending order.
 *
 * Not cosmetic, and not optional. `serde_json` is built here without the
 * `preserve_order` feature, so a `Value::Object` is a `BTreeMap` and everything
 * the Rust Runtime writes — `settings.json`, `worker-settings.json`, and every
 * `/api/settings` response body — comes out with sorted keys. A document this
 * core wrote in insertion order would be the same document and different bytes,
 * and the pair would look like an edit to anything diffing them.
 *
 * Arrays keep their order: an array is a list, not a map.
 *
 * The comparison is on UTF-8 bytes rather than `String.prototype.sort`'s UTF-16
 * code units, because `BTreeMap<String, _>` orders by bytes. The two agree on
 * every ASCII key and disagree above the basic plane, which is exactly the kind
 * of difference that would sit in a file for months before anybody noticed.
 */
export function sortJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map(sortJson) as T;
  if (!isJsonObject(value)) return value;
  const sorted: JsonObject = {};
  for (const key of Object.keys(value).sort(compareUtf8)) {
    sorted[key] = sortJson(value[key] as JsonValue);
  }
  return sorted as T;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Whether a document still carries a local key. Used once, on load, to notice a
 * `settings.json` written before the split so its values can be moved rather
 * than silently ignored.
 */
export function carriesLocal(document: JsonValue): boolean {
  if (!isJsonObject(document)) return false;
  return LOCAL_PATHS.some((path) => read(document, path) !== undefined);
}
