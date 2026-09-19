import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cacheControlFor,
  contentTypeFor,
  hashedAsset,
  openWebRoot,
  resolveFile,
  resolveWithinRoot,
  staticHeaders,
} from "./web-root";

function fixture(): { root: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "armadra-webroot-"));
  const outside = mkdtempSync(join(tmpdir(), "armadra-outside-"));
  writeFileSync(join(outside, "secret.txt"), "不该被读到");
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app-D3fK9x2a.js"), "1");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  symlinkSync(join(root, "assets", "app-D3fK9x2a.js"), join(root, "inside.js"));
  return { root, outside };
}

describe("静态托管", () => {
  it("字符串上的收敛：解码、塌缩、落在根外就没有下一步", () => {
    const root = "/srv/web";
    expect(resolveWithinRoot(root, "/index.html")).toBe("/srv/web/index.html");
    expect(resolveWithinRoot(root, "/a//b/../index.html")).toBe(
      "/srv/web/a/index.html",
    );
    // 编码过的 `..` 与直接写的 `..` 塌缩成同一个答案，而它在根外。
    expect(resolveWithinRoot(root, "/%2e%2e%2f%2e%2e%2fetc")).toBeUndefined();
    expect(resolveWithinRoot(root, "/../../etc")).toBeUndefined();
    expect(resolveWithinRoot(root, "/index.html?v=1")).toBe(
      "/srv/web/index.html",
    );
    expect(resolveWithinRoot(root, "/%ff")).toBeUndefined();
    expect(resolveWithinRoot(root, "/a\0b")).toBeUndefined();
  });

  it("realpath 上的复核挡住指向包外的符号链接", async () => {
    const { root } = fixture();
    const web = await openWebRoot(root);
    expect(await resolveFile(web, "/link.txt")).toBeUndefined();
    // 指向包内的链接照常服务。
    expect((await resolveFile(web, "/inside.js"))?.relative).toBe(
      join("assets", "app-D3fK9x2a.js"),
    );
  });

  it("单页回退只接住没有扩展名的路径", async () => {
    const { root } = fixture();
    const web = await openWebRoot(root);
    expect((await resolveFile(web, "/workspace/abc"))?.relative).toBe(
      "index.html",
    );
    expect(await resolveFile(web, "/assets/missing.js")).toBeUndefined();
  });

  it("没有 index.html 的目录不是 apps/web 的产物", async () => {
    const empty = mkdtempSync(join(tmpdir(), "armadra-empty-"));
    await expect(openWebRoot(empty)).rejects.toThrow(/index\.html/);
  });

  it("缓存按产物形状分档", () => {
    expect(hashedAsset("app-D3fK9x2a.js")).toBe(true);
    expect(hashedAsset("plain.js")).toBe(false);
    expect(cacheControlFor("index.html")).toBe("no-store");
    expect(cacheControlFor(join("assets", "app-D3fK9x2a.js"))).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(cacheControlFor("favicon.ico")).toBe("no-cache");
  });

  it("类型与安全头", () => {
    expect(contentTypeFor("/a/b.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/a/b.unknown")).toBe("application/octet-stream");
    const headers = staticHeaders();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["cache-control"]).toBe("no-store");
  });
});
