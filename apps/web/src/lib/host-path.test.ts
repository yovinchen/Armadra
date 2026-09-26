import { describe, expect, it } from "vitest";

import { isAbsoluteExecutable, isAbsoluteHostPath } from "./host-path";

describe("isAbsoluteHostPath", () => {
  it.each([
    ["/srv/project", true, false],
    ["/", true, false],
    ["C:\\Users\\Ada", false, true],
    ["C:/Users/Ada", false, true],
    ["c:\\", false, true],
    ["\\\\server\\share\\dir", false, true],
    ["\\\\server\\share", false, true],
    ["\\\\server", false, false],
    ["C:relative", false, false],
    ["relative/dir", false, false],
    ["~/project", false, false],
    ["", false, false],
    ["/a\u0000b", false, false],
    ["C:\\a<b", false, false],
    ["C:\\a\\b:c", false, false],
  ])("%j → posix %s, windows %s", (path, posix, windows) => {
    expect(isAbsoluteHostPath(path, "posix")).toBe(posix);
    expect(isAbsoluteHostPath(path, "windows")).toBe(windows);
  });
});

describe("isAbsoluteExecutable", () => {
  it("收 Windows 路径里的空格，不收 POSIX 路径里的", () => {
    expect(
      isAbsoluteExecutable("C:\\Program Files\\Tool\\tool.exe", "windows"),
    ).toBe(true);
    expect(isAbsoluteExecutable("/bin/echo --flag", "posix")).toBe(false);
    expect(isAbsoluteExecutable("/bin/echo", "posix")).toBe(true);
  });
});
