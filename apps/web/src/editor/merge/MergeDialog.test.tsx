import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";

const gitRepositoryIntegration = vi.fn();
const readFile = vi.fn();
const writeFile = vi.fn();
const gitMarkResolved = vi.fn();

vi.mock("@/api/client", () => ({
  runtimeApi: {
    gitRepositoryIntegration: (...args: unknown[]) =>
      gitRepositoryIntegration(...args),
    readFile: (...args: unknown[]) => readFile(...args),
    writeFile: (...args: unknown[]) => writeFile(...args),
    gitMarkResolved: (...args: unknown[]) => gitMarkResolved(...args),
  },
}));

import { hasConflictMarkers, openMergeView } from "./conflict";
import { MergeDialog } from "./MergeDialog";
import { useMergeStore } from "./merge-store";

installDomPolyfills();

const side = (preview: string) => ({
  oid: "a".repeat(40),
  mode: "100644" as const,
  size: preview.length,
  preview,
  binary: false,
  truncated: false,
});

function conflictSnapshot(path = "src/a.ts") {
  return {
    conflicts: [
      {
        path,
        base: side("one\nbase\nthree\n"),
        ours: side("one\nours\nthree\n"),
        theirs: side("one\ntheirs\nthree\n"),
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  useMergeStore.getState().close();
});

beforeEach(() => {
  gitRepositoryIntegration.mockReset().mockResolvedValue(conflictSnapshot());
  readFile.mockReset().mockResolvedValue({
    content: "one\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\nthree\n",
    sha256: "f".repeat(64),
    bom: false,
  });
  writeFile.mockReset().mockResolvedValue({ sha256: "e".repeat(64), size: 1 });
  gitMarkResolved.mockReset().mockResolvedValue({ resolved: ["src/a.ts"] });
});

describe("hasConflictMarkers", () => {
  it("finds Git's markers and does not fire on ordinary text", () => {
    expect(hasConflictMarkers("a\n<<<<<<< HEAD\nb\n")).toBe(true);
    expect(hasConflictMarkers("a\n>>>>>>> other\n")).toBe(true);
    expect(hasConflictMarkers("a\n=======\n")).toBe(true);
    // 一行 `====` 的分隔线不是冲突标记，正好七个才是。
    expect(hasConflictMarkers("a\n====\nb\n")).toBe(false);
    expect(hasConflictMarkers("<<<<<<<<\n")).toBe(false);
  });
});

describe("MergeDialog", () => {
  it("takes the three sides from the index and lets one hunk pick a side", async () => {
    render(<MergeDialog />);
    await openMergeView("w1", "src/a.ts");
    // 三份原文来自 Git 索引，不是工作区文件里的冲突标记——标记里没有祖先。
    expect(await screen.findByText("第 1 处")).toBeTruthy();
    expect(screen.getByText("base")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取他们的" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并标记已解决" }));

    await waitFor(() => expect(writeFile).toHaveBeenCalled());
    const [, path, content, , expectedSha] = writeFile.mock.calls[0]!;
    expect(path).toBe("src/a.ts");
    expect(content).toBe("one\ntheirs\nthree\n");
    // 写盘带的是打开合并视图时读到的那一版，不是「不管现在是什么都覆盖」。
    expect(expectedSha).toBe("f".repeat(64));
    // 保存不等于解决：仍然由现有的 `git/resolve` 重读文件后才入索引。
    expect(gitMarkResolved).toHaveBeenCalledWith("w1", ["src/a.ts"]);
    expect(await screen.findByText("已写入并标记已解决")).toBeTruthy();
  });

  it("writes the file without staging it when only saving", async () => {
    render(<MergeDialog />);
    await openMergeView("w1", "src/a.ts");
    fireEvent.click(await screen.findByRole("button", { name: "只写入文件" }));
    await waitFor(() => expect(writeFile).toHaveBeenCalled());
    expect(gitMarkResolved).not.toHaveBeenCalled();
  });

  it("shows the refusal from mark-resolved, which carries the line numbers", async () => {
    gitMarkResolved.mockRejectedValue(
      new Error("src/a.ts still contains conflict markers on line(s) 2"),
    );
    render(<MergeDialog />);
    await openMergeView("w1", "src/a.ts");
    fireEvent.click(
      await screen.findByRole("button", { name: "保存并标记已解决" }),
    );
    expect(
      await screen.findByText(
        "src/a.ts still contains conflict markers on line(s) 2",
      ),
    ).toBeTruthy();
  });

  it("says why a file cannot be merged rather than opening an empty view", async () => {
    gitRepositoryIntegration.mockResolvedValue({ conflicts: [] });
    render(<MergeDialog />);
    await openMergeView("w1", "src/a.ts");
    expect(
      await screen.findByText("这个文件不在当前的冲突列表里"),
    ).toBeTruthy();
  });

  it("refuses a binary conflict instead of merging bytes line by line", async () => {
    const snapshot = conflictSnapshot();
    snapshot.conflicts[0]!.ours = { ...side("x"), binary: true };
    gitRepositoryIntegration.mockResolvedValue(snapshot);
    render(<MergeDialog />);
    await openMergeView("w1", "src/a.ts");
    expect(await screen.findByText("二进制文件不能按行合并")).toBeTruthy();
  });
});
