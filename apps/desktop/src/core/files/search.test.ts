import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../workspaces/support";
import {
  type SearchRequest,
  globSet,
  indexFiles,
  searchContent,
} from "./search";
import { type Temporary, temporary } from "./workspace.fixture";

/** Ported from the test module of the pre-merge implementation. */

const MAX_SEARCH_FILE_BYTES = 1_048_576;

async function refusal(run: () => unknown): Promise<DomainError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function request(query: string): SearchRequest {
  return { query };
}

describe("the workspace index and search", () => {
  let root: Temporary;
  beforeEach(() => {
    root = temporary();
  });
  afterEach(() => {
    root.remove();
  });

  /** The same tree the pre-merge implementation's `workspace()` helper builds. */
  function workspace(): string {
    mkdirSync(join(root.path, "src/api"), { recursive: true });
    mkdirSync(join(root.path, "node_modules/pkg"), { recursive: true });
    mkdirSync(join(root.path, ".git"), { recursive: true });
    writeFileSync(
      join(root.path, "src/api/client.ts"),
      "export const a = 1;\n",
    );
    writeFileSync(
      join(root.path, "src/main.rs"),
      "fn main() {}\nlet needle = 2;\n",
    );
    writeFileSync(join(root.path, "README.md"), "needle in a haystack\n");
    writeFileSync(join(root.path, "node_modules/pkg/index.js"), "needle\n");
    writeFileSync(join(root.path, ".git/config"), "needle\n");
    return root.path;
  }

  it("matches names first and skips build folders", () => {
    const path = workspace();
    const index = indexFiles(path, "client", undefined);
    expect(index.entries[0]?.path).toBe("src/api/client.ts");
    expect(index.truncated).toBe(false);

    const all = indexFiles(path, "", undefined);
    const paths = all.entries.map((entry) => entry.path);
    expect(paths).toContain("README.md");
    expect(paths.every((one) => !one.includes("node_modules"))).toBe(true);
    expect(paths.every((one) => !one.startsWith(".git"))).toBe(true);
  });

  it("reports truncation and caps the limit", () => {
    for (let index = 0; index < 10; index += 1) {
      writeFileSync(join(root.path, `file${index}.txt`), "x");
    }
    const page = indexFiles(root.path, "file", 3);
    expect(page.entries).toHaveLength(3);
    expect(page.truncated).toBe(true);
  });

  it("never follows a symlink out of the workspace", () => {
    const outside = temporary();
    try {
      writeFileSync(join(outside.path, "secret.txt"), "shh");
      symlinkSync(outside.path, join(root.path, "escape"));
      symlinkSync(
        join(outside.path, "secret.txt"),
        join(root.path, "secret.txt"),
      );
      expect(indexFiles(root.path, "secret", undefined).entries).toEqual([]);
    } finally {
      outside.remove();
    }
  });

  it("finds literals with a line and a column", async () => {
    const path = workspace();
    const result = await searchContent(path, request("needle"));
    expect(result.files.map((file) => file.path)).toEqual([
      "README.md",
      "src/main.rs",
    ]);
    const main = result.files.find((file) => file.path === "src/main.rs");
    expect(main?.matches[0]?.line).toBe(2);
    expect(main?.matches[0]?.column).toBe(5);
    expect(main?.matches[0]?.length).toBe(6);
    expect(result.totalMatches).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("honours case, regex and globs", async () => {
    const path = workspace();
    expect(
      (await searchContent(path, { ...request("NEEDLE"), caseSensitive: true }))
        .files,
    ).toEqual([]);
    expect(
      (await searchContent(path, { query: "need\\w+", regex: true })).files,
    ).toHaveLength(2);

    const onlyMarkdown = await searchContent(path, {
      ...request("needle"),
      include: "*.md",
    });
    expect(onlyMarkdown.files).toHaveLength(1);
    expect(onlyMarkdown.files[0]?.path).toBe("README.md");

    const withoutMarkdown = await searchContent(path, {
      ...request("needle"),
      exclude: "**/*.md",
    });
    expect(withoutMarkdown.files).toHaveLength(1);
    expect(withoutMarkdown.files[0]?.path).toBe("src/main.rs");
  });

  it("pages by file and reports the next offset", async () => {
    const path = workspace();
    const page = await searchContent(path, { ...request("needle"), limit: 1 });
    expect(page.files).toHaveLength(1);
    expect(page.truncated).toBe(true);
    expect(page.nextOffset).toBe(1);

    const rest = await searchContent(path, {
      ...request("needle"),
      limit: 1,
      offset: page.nextOffset,
    });
    expect(rest.files).toHaveLength(1);
    expect(rest.files[0]?.path).toBe("src/main.rs");
    expect(rest.nextOffset).toBeNull();
  });

  it("caps matches per file and skips binary and large files", async () => {
    writeFileSync(join(root.path, "many.txt"), "hit\n".repeat(50));
    writeFileSync(
      join(root.path, "binary.bin"),
      Buffer.from([0x68, 0x69, 0x74, 0x00, 0x68]),
    );
    const oversized = Buffer.alloc(MAX_SEARCH_FILE_BYTES + 1, 0x78);
    oversized.write("hit", 0, "utf8");
    writeFileSync(join(root.path, "big.txt"), oversized);

    const result = await searchContent(root.path, {
      ...request("hit"),
      maxMatchesPerFile: 5,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.matches).toHaveLength(5);
    expect(result.files[0]?.truncated).toBe(true);
    expect(result.skipped).toBe(2);
  });

  it("refuses an empty or invalid pattern", async () => {
    const path = workspace();
    expect((await refusal(() => searchContent(path, request("")))).status).toBe(
      400,
    );
    expect(
      (
        await refusal(() =>
          searchContent(path, { query: "(unclosed", regex: true }),
        )
      ).status,
    ).toBe(400);
  });

  it("does not match a whole word inside an identifier", async () => {
    writeFileSync(join(root.path, "a.txt"), "needles\nneedle\n");
    const result = await searchContent(root.path, {
      ...request("needle"),
      wholeWord: true,
    });
    expect(result.totalMatches).toBe(1);
    expect(result.files[0]?.matches[0]?.line).toBe(2);
  });

  it("stops a search whose caller aborted it", async () => {
    const path = workspace();
    const before = new AbortController();
    before.abort();
    await expect(
      searchContent(path, request("needle"), before.signal),
    ).rejects.toThrow();

    // Enough files that the walk has to yield at least once; the abort lands
    // while it is between two batches, not after it has finished.
    for (let index = 0; index < 400; index += 1) {
      writeFileSync(
        join(path, `f${String(index).padStart(3, "0")}.txt`),
        "x\n",
      );
    }
    const during = new AbortController();
    const running = searchContent(path, request("needle"), during.signal);
    during.abort();
    await expect(running).rejects.toThrow();

    // Without an abort the same tree still answers in full.
    const complete = await searchContent(path, request("needle"));
    expect(complete.files).toHaveLength(2);
    expect(complete.truncated).toBe(false);
  });

  it("translates globs into anchored expressions", () => {
    const set = globSet("*.rs, src/**/*.ts");
    expect(set?.test("main.rs")).toBe(true);
    expect(set?.test("deep/nested/main.rs")).toBe(true);
    expect(set?.test("src/api/client.ts")).toBe(true);
    expect(set?.test("src/client.ts")).toBe(true);
    expect(set?.test("src/api/client.tsx")).toBe(false);
    expect(globSet(undefined)).toBeUndefined();
    expect(globSet("  ,  ")).toBeUndefined();
  });
});
