import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  Database,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileTerminal,
  FileText,
  Folder,
} from "lucide-react";

import { FileTypeIcon, fileIconFor } from "./file-icons";

/**
 * 用户实测：文件管理器和源码控制里「文件图标都是问号」。那个问号是 Git 的
 * 未跟踪状态字母，不是图标——这份测试钉住的是：常见类型各有图标，认不出来
 * 的走通用文件图标，**任何情况下都不会退回问号**。
 */

afterEach(() => cleanup());

describe("文件类型图标", () => {
  it("目录永远是文件夹", () => {
    expect(fileIconFor("src", "directory")).toBe(Folder);
    expect(fileIconFor("src/nodes", "directory")).toBe(Folder);
    // 目录名里带点也还是目录。
    expect(fileIconFor(".github", "directory")).toBe(Folder);
  });

  it("常见类型各有各的图标", () => {
    const cases: [string, unknown][] = [
      ["main.ts", FileCode],
      ["FilesNode.tsx", FileCode],
      ["client.js", FileCode],
      ["sample.rs", FileCode],
      ["main.go", FileCode],
      ["app.css", FileCode],
      ["package.json", FileJson],
      ["README.md", FileText],
      ["Cargo.toml", FileCog],
      ["pnpm-workspace.yaml", FileCog],
      ["build.sh", FileTerminal],
      ["icon.png", FileImage],
      ["logo.svg", FileImage],
      ["armadra.db", Database],
      ["bundle.zip", FileArchive],
      ["pnpm-lock.yaml", FileLock],
      ["Cargo.lock", FileLock],
      ["Dockerfile", FileCog],
      [".gitignore", FileCog],
      ["LICENSE", FileText],
    ];
    for (const [name, icon] of cases) {
      expect(fileIconFor(name), name).toBe(icon);
    }
  });

  it("大小写和路径都不影响判断", () => {
    expect(fileIconFor("SRC/App.TSX")).toBe(FileCode);
    expect(fileIconFor("apps/web/package.json")).toBe(FileJson);
    // 多段扩展名按最后一段认。
    expect(fileIconFor("armadra.tar.gz")).toBe(FileArchive);
  });

  it("认不出来的是通用文件图标，不是问号", () => {
    expect(fileIconFor("mystery")).toBe(File);
    expect(fileIconFor("data.qqq")).toBe(File);
    expect(fileIconFor("archive.")).toBe(File);
    expect(fileIconFor("")).toBe(File);
  });

  it("渲染出来是一个内联 SVG，页面上没有任何问号", () => {
    const { container } = render(<FileTypeIcon path="main.rs" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("lucide-file-code");
    expect(container.textContent).toBe("");
  });

  it("通用图标渲染的也是文件图标", () => {
    const { container } = render(<FileTypeIcon path="mystery" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-file",
    );
    expect(container.textContent).toBe("");
  });
});
