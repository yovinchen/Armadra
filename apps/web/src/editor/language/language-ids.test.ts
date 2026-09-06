import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LANGUAGE_EXTENSIONS,
  LANGUAGE_FILE_NAMES,
  languageIdFor,
} from "./language-ids";

/** vitest 在 `apps/web` 里跑，所以从它的工作目录出发找 Runtime 的候选表。 */
const REGISTRY = resolve(process.cwd(), "../runtime/src/language/registry.rs");

describe("language ids", () => {
  it("names the language of a path and answers null for anything else", () => {
    expect(languageIdFor("src/main.rs")).toBe("rust");
    expect(languageIdFor("apps/web/src/App.tsx")).toBe("typescript");
    expect(languageIdFor("scripts/build.mjs")).toBe("javascript");
    expect(languageIdFor("go.mod")).toBe("go");
    expect(languageIdFor("pkg/go.mod")).toBe("go");
    // 认不出来是一个答案：编辑器照常打开，只是不开会话。
    expect(languageIdFor("notes.txt")).toBeNull();
    expect(languageIdFor("LICENSE")).toBeNull();
    expect(languageIdFor(".gitignore")).toBeNull();
  });

  it("matches the extension case-insensitively", () => {
    expect(languageIdFor("Main.PY")).toBe("python");
    expect(languageIdFor("Config.YAML")).toBe("yaml");
  });

  /**
   * 这张表和 Runtime 的候选表必须逐条对上。不一致的后果不是编译错误，而是
   * 「打开了一条永远不会有诊断的会话」——Web 按一个 languageId 开会话，
   * Runtime 按另一个找 server（语言服务设计 §4.2）。
   */
  it("covers exactly the languages and extensions the runtime registry lists", () => {
    const source = readFileSync(REGISTRY, "utf8");
    const rust = [
      ...source.matchAll(
        /language_id:\s*"([^"]+)",\s*\n\s*extensions:\s*&\[([^\]]*)\]/g,
      ),
    ].map(([, languageId, extensions]) => ({
      languageId,
      extensions: [...(extensions ?? "").matchAll(/"([^"]+)"/g)].map(
        ([, value]) => value,
      ),
    }));
    expect(rust.length).toBeGreaterThan(0);
    expect(rust.map((entry) => entry.languageId)).toEqual(
      LANGUAGE_EXTENSIONS.map(([languageId]) => languageId),
    );
    for (const [index, entry] of rust.entries()) {
      expect(entry.extensions).toEqual([...LANGUAGE_EXTENSIONS[index]![1]]);
    }

    const names = [...source.matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map(
      ([, file, languageId]) => [file, languageId],
    );
    expect(names).toEqual(
      LANGUAGE_FILE_NAMES.map(([file, languageId]) => [file, languageId]),
    );
  });
});
