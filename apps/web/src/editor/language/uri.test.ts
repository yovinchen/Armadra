import { describe, expect, it } from "vitest";

import { isExternalUri, pathOfUri, workspaceUri } from "./uri";

describe("workspace uris", () => {
  it("round-trips a relative path, including one with spaces and CJK", () => {
    for (const path of [
      "src/main.rs",
      "docs/设计 说明.md",
      "a/b c/d+e%f.ts",
      "emoji/🐟.py",
    ]) {
      expect(pathOfUri(workspaceUri(path))).toBe(path);
    }
  });

  it("encodes the way the runtime does, so both sides agree byte for byte", () => {
    // `A-Za-z0-9-._~/:` 原样保留，其余按 UTF-8 字节转 `%XX`
    // （合并前的实现）。
    expect(workspaceUri("a b.rs")).toBe("armadra:///a%20b.rs");
    expect(workspaceUri("x/y-z_1.~ts")).toBe("armadra:///x/y-z_1.~ts");
    expect(workspaceUri("中")).toBe("armadra:///%E4%B8%AD");
  });

  it("drops leading slashes so the uri names a path inside the workspace", () => {
    expect(workspaceUri("/src/main.rs")).toBe("armadra:///src/main.rs");
  });

  it("refuses a path that would walk out of the workspace", () => {
    expect(pathOfUri("armadra:///../etc/passwd")).toBeNull();
    expect(pathOfUri("armadra:///a/../../b")).toBeNull();
    // `..` 只在整段是它的时候才是上一级；文件名里带两个点是正常的。
    expect(pathOfUri("armadra:///a..b.rs")).toBe("a..b.rs");
  });

  it("does not claim someone else's uri", () => {
    expect(pathOfUri("file:///Users/me/project/src/main.rs")).toBeNull();
    expect(pathOfUri("armadra-external:///0f0f")).toBeNull();
    expect(pathOfUri("https://example.com/x")).toBeNull();
  });

  it("recognises a location outside the workspace", () => {
    expect(isExternalUri("armadra-external:///deadbeef")).toBe(true);
    expect(isExternalUri("armadra:///src/main.rs")).toBe(false);
  });
});
