import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./content-links", () => ({
  MAX_LINKS: 64,
  useContentLinks: () => ({}),
}));
import { toast } from "sonner";
import { runtimeApi } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";
import { usePublishContextLinks } from "./context-links";

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
  useCanvasStore.setState({
    workspace: { id: "workspace" } as never,
    document: document(),
  });
});
afterEach(() => {
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
