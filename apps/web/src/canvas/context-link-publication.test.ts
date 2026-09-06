import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ContextLink } from "@armadra/shared";

/**
 * 链接文档的推送（§5.6 / §21，内容引用那一半是 §2.5 / F29）。
 *
 * `useContentLinks` 在这里换成一份可写的假值：它自己的导出 / 缓存 / 重试
 * 由 `content-links.test.ts` 覆盖，这个文件只关心「白板引用怎么并进节点
 * 文档、什么时候重推」。B5 之前它恒返回空表，所以引用那条路一项都没测到。
 */
const content: { current: Record<string, ContextLink[]> } = { current: {} };
vi.mock("./content-links", () => ({
  MAX_LINKS: 64,
  useContentLinks: () => content.current,
}));
import { toast } from "sonner";
import { runtimeApi } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";
import { usePublishContextLinks } from "./context-links";

function shapeLink(
  id: string,
  status: "pending" | "ready",
  extra: Record<string, unknown> = {},
): ContextLink {
  return {
    id,
    title: "Drawing",
    kind: "shape",
    content: {
      sourceShapeId: `wb:${id}`,
      shapeType: "ink",
      status,
      ...extra,
    },
  } as ContextLink;
}

function document(title = "Original") {
  return {
    board: { id: "board" },
    nodes: [
      { id: "agent", type: "terminal", title: "Agent" },
      { id: "note", type: "sticky", title },
    ],
    edges: [{ source: "agent", target: "note" }],
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  content.current = {};
  useCanvasStore.setState({
    workspace: { id: "workspace" } as never,
    document: document(),
  });
});
afterEach(() => {
  // `globals` 没开，RTL 不会自动卸载：上一个测试留下的 hook 会跟着这个
  // 测试再推一轮。
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("retries failed publication without waiting for a document edit", async () => {
  const put = vi
    .spyOn(runtimeApi, "putContextLinks")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({} as never);
  const { unmount } = renderHook(() => usePublishContextLinks());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
  expect(put).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2050);
  });
  expect(put).toHaveBeenCalledTimes(2);
  unmount();
});

it("serializes requests so a slow previous PUT cannot overwrite a newer reference", async () => {
  let finish!: (value: never) => void;
  const put = vi
    .spyOn(runtimeApi, "putContextLinks")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({} as never);
  const { unmount } = renderHook(() => usePublishContextLinks());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
  act(() => useCanvasStore.setState({ document: document("Newest") }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
  expect(put).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish({} as never);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
  expect(put).toHaveBeenCalledTimes(2);
  expect(put.mock.calls[1]?.[2]).toEqual([
    { id: "note", title: "Newest", kind: "sticky" },
  ]);
  unmount();
});

it("bounded retry can be explicitly restarted, and unmount stops further requests", async () => {
  const error = vi.spyOn(toast, "error");
  const dismiss = vi.spyOn(toast, "dismiss");
  const put = vi
    .spyOn(runtimeApi, "putContextLinks")
    .mockRejectedValue(new Error("offline"));
  const { unmount } = renderHook(() => usePublishContextLinks());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(put).toHaveBeenCalledTimes(4);
  expect(error).toHaveBeenCalledOnce();
  const options = error.mock.calls[0]?.[1];
  expect(options).toMatchObject({
    id: "reference-publish-workspace-board",
    action: { label: expect.any(String), onClick: expect.any(Function) },
  });
  put.mockResolvedValue({} as never);
  act(() =>
    window.dispatchEvent(new Event("armadra:refresh-content-references")),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
  expect(put).toHaveBeenCalledTimes(5);
  expect(dismiss).toHaveBeenCalledWith("reference-publish-workspace-board");
  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(put).toHaveBeenCalledTimes(5);
});

it("白板引用与节点对端并进同一份文档，准备中的也推", async () => {
  const put = vi
    .spyOn(runtimeApi, "putContextLinks")
    .mockResolvedValue({} as never);
  content.current = { agent: [shapeLink("r1", "pending")] };
  const { unmount } = renderHook(() => usePublishContextLinks());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
  expect(put).toHaveBeenCalledTimes(1);
  expect(put.mock.calls[0]?.[2]).toEqual([
    { id: "note", title: "Original", kind: "sticky" },
    shapeLink("r1", "pending"),
  ]);
  unmount();
});

it("同一个对象的两条引用去重，只推一条", async () => {
  const put = vi
    .spyOn(runtimeApi, "putContextLinks")
    .mockResolvedValue({} as never);
  // 两行引用，不同的引用 id 却指着同一个白板对象（远端合并可以造出这种
  // 局面）。文档里只该出现一条，否则 Agent 会把同一块内容读两遍。
  const first = shapeLink("r1", "ready");
  const second = shapeLink("r2", "ready");
  second.content!.sourceShapeId = first.content!.sourceShapeId;
  content.current = { agent: [first, second] };
  const { unmount } = renderHook(() => usePublishContextLinks());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
  const links = put.mock.calls[0]?.[2] as ContextLink[];
  expect(links.filter((link) => link.kind === "shape")).toHaveLength(1);
  unmount();
});

it("引用从 pending 变成 ready 会重推一次", async () => {
  const put = vi
    .spyOn(runtimeApi, "putContextLinks")
    .mockResolvedValue({} as never);
  content.current = { agent: [shapeLink("r1", "pending")] };
  const { rerender, unmount } = renderHook(() => usePublishContextLinks());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
  expect(put).toHaveBeenCalledTimes(1);

  content.current = {
    agent: [shapeLink("r1", "ready", { pngPath: ".armadra/exports/r1.png" })],
  };
  act(() => rerender());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
  expect(put).toHaveBeenCalledTimes(2);
  expect((put.mock.calls[1]?.[2] as ContextLink[])[1]?.content).toMatchObject({
    status: "ready",
    pngPath: ".armadra/exports/r1.png",
  });
  unmount();
});

it("引用整条消失时推一份不含它的文档", async () => {
  const put = vi
    .spyOn(runtimeApi, "putContextLinks")
    .mockResolvedValue({} as never);
  content.current = { agent: [shapeLink("r1", "ready")] };
  const { rerender, unmount } = renderHook(() => usePublishContextLinks());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
  content.current = { agent: [] };
  act(() => rerender());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
  expect(put).toHaveBeenCalledTimes(2);
  expect(put.mock.calls[1]?.[2]).toEqual([
    { id: "note", title: "Original", kind: "sticky" },
  ]);
  unmount();
});
