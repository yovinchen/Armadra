/**
 * The store and the local split: patching, persistence, and which of the two
 * files a key lands in.
 *
 * Ported from the second half of `apps/runtime/src/settings/tests.rs` and from
 * `apps/runtime/src/settings/local.rs`'s own cases, plus one this side owes and
 * the Rust side does not: the two implementations have to write the same bytes
 * for the same document, because during the changeover either of them may be
 * the one that wrote the file a person's next start reads.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  carriesLocal,
  isLocal,
  localPaths,
  overlay,
  sortJson,
  split,
  type JsonObject,
  type JsonValue,
} from "./local";
import { SettingsStore } from "./store";

const directories: string[] = [];

function workspace(): { shared: string; local: string } {
  const directory = mkdtempSync(join(tmpdir(), "armadra-settings-"));
  directories.push(directory);
  return {
    shared: join(directory, "settings.json"),
    local: join(directory, "worker-settings.json"),
  };
}

function open(files: { shared: string; local: string }): SettingsStore {
  return SettingsStore.load({ sharedFile: files.shared, localFile: files.local });
}

function readJson(file: string): JsonObject {
  return JSON.parse(readFileSync(file, "utf8")) as JsonObject;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the local split", () => {
  it("keeps every key and puts the local ones in the local half", () => {
    const document: JsonValue = {
      terminal: { backend: "tmux", detachedGraceMinutes: 60 },
      browser: { executablePath: "/opt/chrome", keepAlive: false },
      language: { servers: { rust: { path: "/x" } }, formatOnSave: true },
      editor: { fontSize: 13 },
    };
    const { shared, local } = split(document);
    expect(shared).toEqual({
      terminal: { detachedGraceMinutes: 60 },
      browser: { keepAlive: false },
      language: { formatOnSave: true },
      editor: { fontSize: 13 },
    });
    expect(local).toEqual({
      terminal: { backend: "tmux" },
      browser: { executablePath: "/opt/chrome" },
      language: { servers: { rust: { path: "/x" } } },
    });
    // Nothing is dropped: the two together are always the whole document.
    expect(overlay(shared, local)).toEqual(document);
  });

  /**
   * A section that held nothing but local keys must not be left behind as an
   * empty object — on the next machine that reads as "the user cleared it".
   */
  it("removes a section the split emptied from the shared half", () => {
    const { shared, local } = split({ power: { policy: "never" } });
    expect(shared).toEqual({});
    expect(local).toEqual({ power: { policy: "never" } });
  });

  it("lets the local file win over a stale shared value", () => {
    expect(
      overlay({ terminal: { backend: "direct" } }, { terminal: { backend: "tmux" } }),
    ).toEqual({ terminal: { backend: "tmux" } });
    // And with nothing local, the stale shared value is dropped rather than
    // obeyed: these keys are answered by this machine or not at all. The
    // section it emptied goes with it, for the same reason the split removes
    // one — an empty `terminal` would read as a cleared section.
    expect(overlay({ terminal: { backend: "direct" } }, {})).toEqual({});
  });

  it("treats a path under a local one as local too", () => {
    expect(isLocal("language.servers")).toBe(true);
    expect(isLocal("language.servers.rust.path")).toBe(true);
    expect(isLocal("terminal.backend")).toBe(true);
    expect(isLocal("terminal")).toBe(false);
    expect(isLocal("terminal.detachedGraceMinutes")).toBe(false);
    // A custom agent definition is what the user configured and is meant to
    // follow them; only the probe cache underneath it is local.
    expect(isLocal("agents.custom")).toBe(false);
    expect(localPaths()).toContain("agents.probes");
    expect(localPaths()).toHaveLength(6);
  });

  it("recognises a document written before the split", () => {
    expect(carriesLocal({ power: { policy: "manual" } })).toBe(true);
    expect(carriesLocal({ power: {} })).toBe(false);
    expect(carriesLocal({ editor: { fontSize: 13 } })).toBe(false);
  });
});

describe("SettingsStore", () => {
  it("keeps the other keys when one is patched, and writes them for the next start", () => {
    const files = workspace();
    writeFileSync(
      files.shared,
      '{"terminal":{"detachedGraceMinutes":30},"theme":"dark"}',
    );
    const store = open(files);
    const document = store.patch({ terminal: { backend: "direct" } });
    expect(document.terminal).toMatchObject({
      backend: "direct",
      detachedGraceMinutes: 30,
    });
    expect(document.theme).toBe("dark");
    expect(store.terminal()).toMatchObject({
      backend: "direct",
      detachedGraceMinutes: 30,
    });

    expect(open(files).terminal().backend).toBe("direct");
  });

  /**
   * A `worker-settings.json` carrying the account's preferences would send them
   * nowhere, and a `settings.json` carrying the machine's would send them
   * everywhere.
   */
  it("lands a patch in the file the key belongs to", () => {
    const files = workspace();
    const store = open(files);
    store.patch({
      terminal: { backend: "tmux", detachedGraceMinutes: 30 },
      power: { policy: "never" },
    });

    const shared = readJson(files.shared);
    expect((shared.terminal as JsonObject).detachedGraceMinutes).toBe(30);
    expect("backend" in (shared.terminal as JsonObject)).toBe(false);
    expect("power" in shared).toBe(false);

    const local = readJson(files.local);
    expect((local.terminal as JsonObject).backend).toBe("tmux");
    expect((local.power as JsonObject).policy).toBe("never");
    // Only the local paths are in it. `browser.executablePath` is one of them
    // and `normalize` always writes it, so an empty string here is the
    // documented "detect a browser" and not a leak of the account's half.
    expect(Object.keys(local).sort()).toEqual(["browser", "power", "terminal"]);
    expect("usage" in local).toBe(false);
    expect("detachedGraceMinutes" in (local.terminal as JsonObject)).toBe(false);

    // And the two are one document again on the next start.
    const reloaded = open(files);
    expect(reloaded.terminal()).toMatchObject({
      backend: "tmux",
      detachedGraceMinutes: 30,
    });
    expect(reloaded.get("power.policy")).toBe("never");
  });

  /**
   * The product has not shipped, so no compatibility with the old shape is
   * owed — but a settings file somebody already configured must not lose its
   * terminal backend just because this build reads two files instead of one.
   */
  it("moves the local keys of a pre-split file exactly once", () => {
    const files = workspace();
    writeFileSync(
      files.shared,
      JSON.stringify({
        terminal: { backend: "tmux", detachedGraceMinutes: 30 },
        browser: { executablePath: "/opt/chrome" },
        theme: "dark",
      }),
    );

    const store = open(files);
    expect(store.terminal().backend).toBe("tmux");
    expect(store.get("browser.executablePath")).toBe("/opt/chrome");

    // The move happens on load, not on the next patch: an export taken before
    // anybody changes a setting must already show the split.
    const shared = readJson(files.shared);
    expect("backend" in (shared.terminal as JsonObject)).toBe(false);
    // `browser` survives because `keepAlive` and `headful` are preferences
    // about the node, not about the machine; only the binary's path moves.
    expect("executablePath" in (shared.browser as JsonObject)).toBe(false);
    expect(shared.theme).toBe("dark");
    const local = readJson(files.local);
    expect((local.terminal as JsonObject).backend).toBe("tmux");
    expect((local.browser as JsonObject).executablePath).toBe("/opt/chrome");

    const reloaded = open(files);
    expect(reloaded.terminal()).toMatchObject({
      backend: "tmux",
      detachedGraceMinutes: 30,
    });
  });

  /**
   * Once both files exist the local one decides. A `settings.json` that arrived
   * from another machine still carrying a `terminal.backend` must not change
   * which backend this one uses.
   */
  it("does not let a shared document reintroduce a local key", () => {
    const files = workspace();
    writeFileSync(files.shared, '{"terminal":{"backend":"direct"}}');
    writeFileSync(files.local, '{"terminal":{"backend":"tmux"}}');
    expect(open(files).terminal().backend).toBe("tmux");
  });

  it("replaces an array wholesale, so deleting a host is an empty list", () => {
    const files = workspace();
    const store = open(files);
    let document = store.patch({
      ssh: {
        hosts: [
          { id: "box", name: "Box", host: "example.com", user: "ada", port: 2222 },
          { id: "evil", name: "Evil", host: "a;rm -rf /" },
        ],
      },
    });
    expect(document.ssh).toEqual({
      hosts: [
        { id: "box", name: "Box", host: "example.com", port: 2222, user: "ada" },
      ],
    });
    document = store.patch({ ssh: { hosts: [] } });
    expect(document.ssh).toEqual({ hosts: [] });
  });

  it("deletes a key a patch sets to null", () => {
    const store = SettingsStore.inMemory({ theme: "dark" });
    expect(store.snapshot().theme).toBe("dark");
    expect("theme" in store.patch({ theme: null })).toBe(false);
  });

  it("survives an unreadable file rather than refusing to answer", () => {
    const files = workspace();
    writeFileSync(files.shared, "{ not json");
    // The defaults are used and the file is rewritten on the first patch. A
    // core that refused to start over a hand-edited preferences file would be
    // unrecoverable without a text editor.
    expect(open(files).terminal().backend).toBe("auto");
  });

  /**
   * `settings.json` carries an execution host registry and whatever a person
   * put in a custom agent's environment. Neither belongs to the rest of the
   * machine's users (contract §6).
   */
  it("writes both halves 0600", () => {
    if (process.platform === "win32") return;
    const files = workspace();
    open(files).patch({ terminal: { backend: "tmux" } });
    expect(statSync(files.shared).mode & 0o777).toBe(0o600);
    expect(statSync(files.local).mode & 0o777).toBe(0o600);
  });

  /**
   * `serde_json` is built here without `preserve_order`, so a `Value::Object`
   * is a `BTreeMap` and every document the Rust Runtime writes has sorted keys.
   * A document this core wrote in insertion order would be the same document
   * and different bytes, and the pair would look like an edit to anything
   * diffing them.
   */
  it("writes sorted keys, the way the Rust runtime's BTreeMap does", () => {
    const files = workspace();
    open(files).patch({ zebra: 1, alpha: 2, middle: { zzz: 1, aaa: 2 } });
    const text = readFileSync(files.shared, "utf8");
    const keys = [...text.matchAll(/^ {2}"([^"]+)"/gm)].map((match) => match[1]);
    expect(keys).toEqual([...keys].sort());
    expect(text.indexOf('"aaa"')).toBeLessThan(text.indexOf('"zzz"'));
    // Two spaces, `": "`, and no trailing newline — `to_string_pretty`'s shape.
    expect(text.startsWith('{\n  "')).toBe(true);
    expect(text.endsWith("}")).toBe(true);
  });

  it("sorts on UTF-8 bytes rather than UTF-16 code units", () => {
    // The two orders disagree above the basic plane: U+1F600 is one code point
    // whose UTF-8 bytes start at 0xF0, but two UTF-16 units starting at 0xD83D
    // — which sorts before U+FB00, not after it.
    expect(Object.keys(sortJson({ "\u{1F600}": 1, "ﬀ": 2 }))).toEqual([
      "ﬀ",
      "\u{1F600}",
    ]);
  });
});
