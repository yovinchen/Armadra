import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Workspace } from "@armadra/shared";

import { useCanvasStore } from "../store/canvas-store";
import { ProjectSearchPanel } from "./ProjectSearchPanel";

const searchFiles = vi.fn();
const openFileInEditor = vi.fn();

vi.mock("@/api/client", () => ({
  RUNTIME_URL: "http://runtime",
  runtimeApi: { searchFiles: (...args: unknown[]) => searchFiles(...args) },
}));
vi.mock("@/files/open-editor", () => ({
  openFileInEditor: (...args: unknown[]) => openFileInEditor(...args),
}));

const timestamp = "2026-09-05T00:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function page(overrides: Record<string, unknown> = {}) {
  return {
    files: [
      {
        path: "src/a.ts",
        truncated: false,
        matches: [
          {
            line: 12,
            column: 7,
            length: 6,
            preview: "const needle = 1;",
            previewTruncated: false,
          },
        ],
      },
    ],
    totalMatches: 1,
    truncated: false,
    timedOut: false,
    skipped: 0,
    scanned: 10,
    nextOffset: null,
    ...overrides,
  };
}

afterEach(() => cleanup());

beforeEach(() => {
  searchFiles.mockReset().mockResolvedValue(page());
  openFileInEditor.mockReset();
  useCanvasStore.setState({ workspace });
});

async function search(term: string) {
  render(<ProjectSearchPanel />);
  fireEvent.change(screen.getByLabelText("在项目中查找"), {
    target: { value: term },
  });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
}

describe("ProjectSearchPanel", () => {
  it("sends the toggles the user set and opens a match at its line", async () => {
    await search("needle");
    await waitFor(() =>
      expect(searchFiles).toHaveBeenCalledWith(
        workspace.id,
        {
          query: "needle",
          regex: false,
          caseSensitive: false,
          wholeWord: false,
        },
        expect.any(AbortSignal),
      ),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "打开 src/a.ts 第 12 行" }),
    );
    expect(openFileInEditor).toHaveBeenCalledWith("src/a.ts", { line: 12 });
  });

  it("carries regex, case, whole word and both globs", async () => {
    render(<ProjectSearchPanel />);
    fireEvent.change(screen.getByLabelText("在项目中查找"), {
      target: { value: "need\\w+" },
    });
    fireEvent.click(screen.getByLabelText("正则表达式"));
    fireEvent.click(screen.getByLabelText("区分大小写"));
    fireEvent.click(screen.getByLabelText("全字匹配"));
    fireEvent.change(screen.getByLabelText("包含（glob）"), {
      target: { value: "*.ts" },
    });
    fireEvent.change(screen.getByLabelText("排除（glob）"), {
      target: { value: "**/*.d.ts" },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    await waitFor(() =>
      expect(searchFiles).toHaveBeenCalledWith(
        workspace.id,
        {
          query: "need\\w+",
          regex: true,
          caseSensitive: true,
          wholeWord: true,
          include: "*.ts",
          exclude: "**/*.d.ts",
        },
        expect.any(AbortSignal),
      ),
    );
  });

  // 一份被裁剪的结果不能画成完整答案。
  it("says when the answer is partial, timed out, or skipped files", async () => {
    searchFiles.mockResolvedValue(
      page({ truncated: true, timedOut: true, skipped: 3 }),
    );
    await search("needle");
    expect(await screen.findByText("已达时间上限")).toBeTruthy();
    expect(screen.getByText("跳过 3 个过大或二进制文件")).toBeTruthy();
  });

  it("appends the next page instead of re-running the first", async () => {
    searchFiles.mockResolvedValueOnce(page({ truncated: true, nextOffset: 1 }));
    await search("needle");
    const more = await screen.findByRole("button", { name: "加载更多" });

    searchFiles.mockResolvedValueOnce(
      page({
        files: [
          {
            path: "src/b.ts",
            truncated: false,
            matches: [
              {
                line: 2,
                column: 1,
                length: 6,
                preview: "needle",
                previewTruncated: false,
              },
            ],
          },
        ],
      }),
    );
    fireEvent.click(more);
    await waitFor(() =>
      expect(searchFiles).toHaveBeenLastCalledWith(
        workspace.id,
        expect.objectContaining({ offset: 1 }),
        expect.any(AbortSignal),
      ),
    );
    // Both pages are on screen; the first was not thrown away.
    expect(await screen.findByText("src/b.ts")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
  });

  it("reports a failure rather than an empty result", async () => {
    searchFiles.mockRejectedValue(new Error("Search pattern is invalid"));
    await search("(unclosed");
    expect(await screen.findByText("搜索失败")).toBeTruthy();
  });

  // 同一时刻只留一个请求：新查询、停止、离开这一页都要中止上一个。
  describe("cancellation", () => {
    function pending() {
      const signals: AbortSignal[] = [];
      searchFiles.mockImplementation(
        (_id: string, _input: unknown, signal: AbortSignal) => {
          signals.push(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        },
      );
      return signals;
    }

    it("aborts the running search when a new query is submitted", async () => {
      const signals = pending();
      await search("first");
      await waitFor(() => expect(signals).toHaveLength(1));
      fireEvent.change(screen.getByLabelText("在项目中查找"), {
        target: { value: "second" },
      });
      fireEvent.click(screen.getByRole("button", { name: "搜索" }));
      await waitFor(() => expect(signals).toHaveLength(2));
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
    });

    it("stops on 停止 without reporting a failure", async () => {
      const signals = pending();
      await search("needle");
      fireEvent.click(await screen.findByRole("button", { name: "停止" }));
      expect(signals[0]?.aborted).toBe(true);
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "停止" })).toBeNull(),
      );
      expect(screen.queryByText("正在搜索…")).toBeNull();
      expect(screen.queryByText("搜索失败")).toBeNull();
    });

    it("aborts when the panel goes away", async () => {
      const signals = pending();
      await search("needle");
      await waitFor(() => expect(signals).toHaveLength(1));
      cleanup();
      expect(signals[0]?.aborted).toBe(true);
    });
  });
});
