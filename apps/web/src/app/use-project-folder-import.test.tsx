import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FileDropHandler } from "../platform";

const openDirectory = vi.fn();
const importWorkspace = vi.fn();
const openWorkspace = vi.fn();
const errorToast = vi.fn();
const successToast = vi.fn();
let nativeDrop: FileDropHandler = () => {};
vi.mock("../api/client", () => ({ runtimeApi: {
  openDirectory: (...args: unknown[]) => openDirectory(...args),
  importWorkspace: (...args: unknown[]) => importWorkspace(...args),
} }));
vi.mock("./workspace-actions", () => ({ useOpenWorkspace: () => openWorkspace }));
vi.mock("../platform", () => ({ isTauri: () => false, pickDirectory: vi.fn(), onFileDrop: (callback: FileDropHandler) => { nativeDrop = callback; return () => {}; } }));
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => errorToast(...args), success: (...args: unknown[]) => successToast(...args) } }));

import { useProjectFolderImport } from "./use-project-folder-import";
import { usePreferencesStore } from "./preferences-store";
import { TestProviders } from "./test-harness";

function Projects() {
  const state = useProjectFolderImport();
  return <div role="dialog"><section data-project-drop-zone="true" aria-label="Projects" {...state.events}><span>{state.busy ? "busy" : "idle"}</span></section></div>;
}
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); usePreferencesStore.setState({ locale: "zh-CN" }); });

describe("project folder imports", () => {
  it("routes desktop drops only to the project region, including a Sheet", async () => {
    render(<TestProviders><Projects /></TestProviders>);
    let target: Element | null = document.body;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    act(() => nativeDrop(["/projects/first"], { x: 10, y: 10 }));
    expect(openDirectory).not.toHaveBeenCalled();
    target = screen.getByLabelText("Projects");
    openDirectory.mockResolvedValueOnce({ id: "first", name: "first" }).mockRejectedValueOnce(new Error("not a directory")).mockResolvedValueOnce({ id: "third", name: "third" });
    act(() => nativeDrop(["/projects/first", "/projects/file.txt", "/projects/third"], { x: 10, y: 10 }));
    await waitFor(() => expect(openDirectory).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(openWorkspace).toHaveBeenCalledTimes(2));
    expect(errorToast).toHaveBeenCalledTimes(1);
    expect(openDirectory.mock.calls[0]?.[0]).toMatchObject({ rootPath: "/projects/first" });
    expect(openDirectory.mock.calls[0]?.[0].createDirectory).not.toBe(true);
    await screen.findByText("idle");
  });

  it("imports empty browser folders as copies and reports plain files separately", async () => {
    render(<TestProviders><Projects /></TestProviders>);
    importWorkspace.mockResolvedValue({ id: "copy", name: "empty" });
    const directory = { name: "empty", isDirectory: true, isFile: false, createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve([]) }) };
    const file = { name: "report.pdf", isDirectory: false, isFile: true };
    fireEvent.drop(screen.getByLabelText("Projects"), { dataTransfer: { types: ["Files"], files: [], items: [file, directory].map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry })) } });
    await waitFor(() => expect(importWorkspace).toHaveBeenCalledWith({ name: "empty", files: [], directories: [] }));
    await waitFor(() => expect(successToast).toHaveBeenCalledWith("已导入「empty」的副本，原文件夹保持不变"));
    expect(errorToast).toHaveBeenCalledTimes(1);
    expect(openDirectory).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
  });
});
