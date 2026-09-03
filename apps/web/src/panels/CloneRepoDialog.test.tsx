import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const cloneRepository = vi.fn();
const gitCloneStatus = vi.fn();
const cancelClone = vi.fn();

vi.mock("../api/client", () => ({
  runtimeApi: {
    cloneRepository: (input: unknown) => cloneRepository(input),
    gitCloneStatus: (jobId: string) => gitCloneStatus(jobId),
    cancelClone: (jobId: string) => cancelClone(jobId),
  },
}));

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { CloneRepoDialog, cloneProgress } from "./CloneRepoDialog";

installDomPolyfills();
afterEach(cleanup);

describe("cloneProgress", () => {
  it("取最近一行的百分比", () => {
    expect(cloneProgress([])).toBe(null);
    expect(cloneProgress(["remote: Enumerating objects: 12, done."])).toBe(
      null,
    );
    expect(cloneProgress(["Receiving objects:  45% (9/20)"])).toBe(45);
    expect(
      cloneProgress([
        "Receiving objects: 100% (20/20), 4.00 KiB | 4.00 MiB/s, done.",
        "Resolving deltas:  60% (3/5)",
      ]),
    ).toBe(60);
  });
});

describe("CloneRepoDialog", () => {
  beforeEach(() => {
    cloneRepository.mockReset();
    gitCloneStatus.mockReset();
    cancelClone.mockReset().mockResolvedValue(undefined);
  });

  function open(onCloned?: (workspace: unknown) => void) {
    render(
      <TestProviders>
        <CloneRepoDialog
          open
          onOpenChange={() => undefined}
          onCloned={onCloned as never}
        />
      </TestProviders>,
    );
  }

  it("地址与父目录都填了才能克隆", () => {
    open();
    const clone = screen.getByText("克隆").closest("button");
    expect(clone?.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("仓库地址"), {
      target: { value: "https://example.test/demo.git" },
    });
    expect(clone?.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("父目录"), {
      target: { value: "/tmp" },
    });
    expect(clone?.disabled).toBe(false);
  });

  it("完成后把新建的工作空间交出去", async () => {
    const cloned = vi.fn();
    const workspace = {
      id: "w1",
      name: "demo",
      rootPath: "/tmp/demo",
      color: "#5B5BD6",
      permissions: { read: true, write: true, execute: true },
      lastOpenedAt: "",
      createdAt: "",
      updatedAt: "",
    };
    cloneRepository.mockResolvedValue({ jobId: "job-1" });
    gitCloneStatus.mockResolvedValue({
      state: "done",
      lines: ["Receiving objects: 100% (20/20)"],
      workspace,
    });
    open(cloned);
    fireEvent.change(screen.getByLabelText("仓库地址"), {
      target: { value: "https://example.test/demo.git" },
    });
    fireEvent.change(screen.getByLabelText("父目录"), {
      target: { value: "/tmp" },
    });
    fireEvent.click(screen.getByText("克隆"));

    await waitFor(() => expect(cloned).toHaveBeenCalled());
    expect(cloneRepository.mock.calls[0]?.[0]).toMatchObject({
      url: "https://example.test/demo.git",
      parent: "/tmp",
    });
    expect(cloned.mock.calls[0]?.[0]).toMatchObject({ id: "w1", boards: [] });
  });

  it("失败时把最后一行显示出来", async () => {
    cloneRepository.mockResolvedValue({ jobId: "job-2" });
    gitCloneStatus.mockResolvedValue({
      state: "error",
      lines: ["fatal: repository not found"],
      error: "fatal: repository not found",
    });
    open();
    fireEvent.change(screen.getByLabelText("仓库地址"), {
      target: { value: "https://example.test/missing.git" },
    });
    fireEvent.change(screen.getByLabelText("父目录"), {
      target: { value: "/tmp" },
    });
    fireEvent.click(screen.getByText("克隆"));

    expect(await screen.findByText("fatal: repository not found")).toBeTruthy();
  });
});
