import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { runtimeApi } from "../../api/client";
import { usePreferencesStore } from "../../app/preferences-store";
import { LegacyArchives } from "./LegacyArchives";

const raw =
  ' { "columns": [{"title":"原始列"}], "cards": {"deleted-node":{"order":1.2500}} }\n';
const summary = {
  canvasId: "canvas-old",
  workspaceId: "workspace-deleted",
  workspaceName: "Deleted workspace",
  canvasName: "Original canvas",
  archivedAt: "2026-09-05T00:00:00Z",
  kanbanBytes: raw.length,
  labelCount: 1,
};
const archive = {
  ...summary,
  kanbanJson: raw,
  kanbanSha256: "a".repeat(64),
  canvasCreatedAt: "original-created",
  canvasUpdatedAt: "original-updated",
  labels: [
    {
      nodeId: "node-deleted",
      canvasId: summary.canvasId,
      workspaceId: summary.workspaceId,
      nodeTitle: "Original node",
      nodeType: "sticky",
      labelsJson: '[ "旧标签" ]',
      note: "original note\n  spacing",
      nodeCreatedAt: "original-created",
      nodeUpdatedAt: "original-updated",
      archivedAt: summary.archivedAt,
    },
  ],
};
const clients: QueryClient[] = [];
beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  vi.spyOn(runtimeApi, "legacyKanbanArchives").mockResolvedValue({
    archives: [summary],
    nextCursor: null,
  });
  vi.spyOn(runtimeApi, "legacyKanbanArchive").mockResolvedValue(archive);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function view() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <LegacyArchives />
    </QueryClientProvider>,
  );
}
it("shows original deleted-workspace identities and opaque JSON without restoring an editable board", async () => {
  view();
  fireEvent.click(
    await screen.findByRole("button", { name: "View original record" }),
  );
  await screen.findByText(summary.canvasId);
  expect(screen.getByText(raw.trim(), { exact: false })).toBeTruthy();
  expect(screen.getByText(summary.workspaceId)).toBeTruthy();
  fireEvent.click(screen.getByText("Original node"));
  expect(screen.getByText("node-deleted", { exact: false })).toBeTruthy();
  expect(screen.getByText("原始列", { exact: false })).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Restore|Delete|Move/ }),
  ).toBeNull();
});
it("exports a valid wrapper while preserving the inner JSON and label/note strings", async () => {
  const exportApi = vi
    .spyOn(runtimeApi, "exportLegacyKanbanArchive")
    .mockResolvedValue({ formatVersion: 1, archive });
  let captured: Blob | undefined;
  const create = vi.fn((blob: Blob) => {
    captured = blob;
    return "blob:archive";
  });
  const revoke = vi.fn();
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  view();
  fireEvent.click(
    await screen.findByRole("button", { name: "View original record" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Export archive JSON" }),
  );
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(captured!);
  });
  const value = JSON.parse(text);
  expect(value.archive.kanbanJson).toBe(raw);
  expect(value.archive.labels[0].labelsJson).toBe(
    archive.labels[0]!.labelsJson,
  );
  expect(value.archive.labels[0].note).toBe(archive.labels[0]!.note);
  expect(exportApi).toHaveBeenCalledWith(summary.canvasId);
  expect(click).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:archive"), {
    timeout: 1500,
  });
});
it("paginates with the returned cursor and distinguishes failures from an empty history", async () => {
  vi.mocked(runtimeApi.legacyKanbanArchives)
    .mockResolvedValueOnce({ archives: [summary], nextCursor: "canvas-old" })
    .mockRejectedValueOnce(new Error("Archive read failed"));
  view();
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more archives" }),
  );
  await screen.findByRole("alert");
  expect(runtimeApi.legacyKanbanArchives).toHaveBeenCalledWith(
    "canvas-old",
    expect.any(AbortSignal),
  );
  expect(screen.queryByText("No historical archives.")).toBeNull();
});
