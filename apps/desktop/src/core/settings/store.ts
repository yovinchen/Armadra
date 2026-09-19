/**
 * The in-memory settings document and its typed accessors, backed by
 * `<data dir>/settings.json` and `<data dir>/worker-settings.json`.
 *
 * Ported from `apps/runtime/src/settings/store.rs`. The two implementations
 * read and write the same two files in the same format, and this is load
 * bearing rather than tidy: during the changeover the switch may select either
 * core between two starts, and a person's terminal backend, browser path and
 * power policy have to survive that.
 *
 * Three properties the rest of the core depends on:
 *
 *  1. **One document, two files.** Callers name `terminal.backend`, never a
 *     file. The split happens on write and the overlay on read.
 *  2. **A patch merges, per section.** A key written by a newer build (or by
 *     hand) survives a `PATCH` from an older one.
 *  3. **Both halves are written every time**, even when only one changed: the
 *     two are one document, and a run that wrote a new `settings.json` beside a
 *     `worker-settings.json` from before the change would leave the pair
 *     describing a state that never existed.
 */

import { readFileSync } from "node:fs";

import { writeSecret } from "../paths";
import {
  carriesLocal,
  clone,
  isJsonObject,
  overlay,
  sortJson,
  split,
  type JsonObject,
  type JsonValue,
} from "./local";
import { merge, normalize } from "./schema";

export interface SettingsStoreFiles {
  /** `<data dir>/settings.json` — the half that follows the account. */
  readonly sharedFile: string;
  /** `<data dir>/worker-settings.json` — the half that stays on this machine. */
  readonly localFile: string;
}

export interface SettingsStoreOptions extends Partial<SettingsStoreFiles> {
  /** Reported when a write fails; a store with no log stays silent. */
  readonly onError?: (error: unknown) => void;
}

/**
 * `serde_json::to_string_pretty` — two spaces, `": "` between key and value, one
 * array element per line, `{}` and `[]` for the empty cases. `JSON.stringify`
 * with an indent of 2 produces the same text for the same (sorted) document.
 */
function pretty(document: JsonValue): string {
  return JSON.stringify(sortJson(document), null, 2);
}

function readJson(file: string | undefined): JsonValue {
  if (file === undefined || file.length === 0) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as JsonValue;
  } catch {
    // A missing or unreadable file is not an error: the defaults are used and
    // the file is written on the first patch.
    return null;
  }
}

export class SettingsStore {
  private document: JsonObject;
  private readonly sharedFile: string | undefined;
  private readonly localFile: string | undefined;
  private readonly onError: (error: unknown) => void;

  private constructor(
    document: JsonObject,
    options: SettingsStoreOptions = {},
  ) {
    this.document = document;
    this.sharedFile = options.sharedFile;
    this.localFile = options.localFile;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * Reads both halves and merges them into one document.
   *
   * The first load of a `settings.json` written before the split still carries
   * the local keys. They are moved rather than ignored — the person configured
   * tmux once and must not have to configure it again — and both files are
   * rewritten straight away, so the move happens once instead of waiting for
   * whatever the next patch happens to be.
   */
  static load(
    options: SettingsStoreFiles & SettingsStoreOptions,
  ): SettingsStore {
    const shared = readJson(options.sharedFile);
    const local = readJson(options.localFile);
    const migrating = carriesLocal(shared);
    const localHalf =
      migrating && local === null
        ? // Nothing local has ever been written, so the values in
          // `settings.json` are the ones this machine is actually using: take
          // them as the local half.
          split(shared).local
        : local;
    const store = new SettingsStore(
      normalize(overlay(shared, localHalf)),
      options,
    );
    if (migrating) {
      // Best effort: a read-only data directory still serves the merged
      // document, it just re-does this on the next start.
      store.persist();
    }
    return store;
  }

  /** A store that answers from memory and writes nothing. For tests. */
  static inMemory(document: JsonValue = null): SettingsStore {
    return new SettingsStore(normalize(document));
  }

  /** The whole document, exactly as `GET /api/settings` answers it. */
  snapshot(): JsonObject {
    return sortJson(clone(this.document));
  }

  /**
   * Merge a patch in, normalise the result and write both halves.
   *
   * The merged document is returned, which is what `PATCH /api/settings`
   * answers: a caller that patched one key should not have to re-read to learn
   * what the normaliser made of it.
   */
  patch(patch: JsonValue): JsonObject {
    const next: JsonValue = merge(clone<JsonObject>(this.document), patch);
    this.document = normalize(next);
    this.persist();
    return this.snapshot();
  }

  /** `terminal.backend`, `terminal.detachedGraceMinutes`, … already valid. */
  terminal(): {
    backend: string;
    detachedGraceMinutes: number;
    dormantAfterSeconds: number;
  } {
    const terminal = this.document.terminal;
    const read = isJsonObject(terminal) ? terminal : {};
    return {
      backend: typeof read.backend === "string" ? read.backend : "auto",
      detachedGraceMinutes:
        typeof read.detachedGraceMinutes === "number"
          ? read.detachedGraceMinutes
          : 1_440,
      dormantAfterSeconds:
        typeof read.dormantAfterSeconds === "number"
          ? read.dormantAfterSeconds
          : 120,
    };
  }

  /** One dotted path out of the document, for the accessors other domains need. */
  get(path: string): JsonValue | undefined {
    let current: JsonValue = this.document;
    for (const segment of path.split(".")) {
      if (!isJsonObject(current)) return undefined;
      const next: JsonValue | undefined = current[segment];
      if (next === undefined) return undefined;
      current = next;
    }
    return current;
  }

  /**
   * `usage.enabled` — read on every refresh tick, so flipping the switch takes
   * effect without a restart.
   */
  usageEnabled(): boolean {
    const value = this.get("usage.enabled");
    return typeof value === "boolean" ? value : true;
  }

  /**
   * `usage.providers.<id>`. An unknown id answers `false`: the core only queries
   * providers it has a module for.
   */
  usageProviderEnabled(id: string): boolean {
    const providers = this.get("usage.providers");
    if (!isJsonObject(providers)) return false;
    const value = providers[id];
    // `normalize` has already dropped ids this build does not know, so an
    // absent key here is an unknown provider rather than an unset switch.
    return typeof value === "boolean" ? value : false;
  }

  /**
   * Writes the merged document back as its two halves.
   *
   * Through the 0600 primitive (contract §6) rather than a plain write:
   * `settings.json` carries an execution host registry and whatever a person
   * put in a custom agent's environment, and neither belongs to the rest of the
   * machine's users.
   */
  private persist(): void {
    if (this.sharedFile === undefined || this.sharedFile.length === 0) return;
    const halves = split(this.document);
    try {
      writeSecret(this.sharedFile, pretty(halves.shared));
      if (this.localFile !== undefined && this.localFile.length > 0) {
        writeSecret(this.localFile, pretty(halves.local));
      }
    } catch (error) {
      this.onError(error);
    }
  }
}
