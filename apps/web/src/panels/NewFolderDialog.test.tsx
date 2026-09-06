import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const createWorkspace = vi.fn();

vi.mock("../api/client", async () => {
  const actual =
    await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    runtimeApi: {
      createWorkspace: (input: unknown) => createWorkspace(input),
    },
  };
});

import { RuntimeRequestError } from "../api/client";
import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { NewFolderDialog } from "./NewFolderDialog";

installDomPolyfills();
afterEach(cleanup);

function open(onCreated?: (workspace: unknown) => void) {
  render(
    <TestProviders>
      <NewFolderDialog
        open
        onOpenChange={() => undefined}
        onCreated={onCreated as never}
      />
    </TestProviders>,
  );
}

const created = {
  id: "w1",
  name: "demo",
  rootPath: "/tmp/projects/demo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  lastOpenedAt: "",
  createdAt: "",
  updatedAt: "",
};

describe("NewFolderDialog", () => {
  beforeEach(() => createWorkspace.mockReset());

  it("只剩一个路径字段：没有名称、颜色与权限", () => {
    open();
    expect(screen.getByLabelText("路径")).toBeTruthy();
    expect(screen.queryByLabelText("名称")).toBeNull();
    expect(screen.queryByLabelText("颜色")).toBeNull();
    expect(screen.queryByLabelText("读取")).toBeNull();
    expect(screen.queryByLabelText("写入")).toBeNull();
    expect(screen.queryByLabelText("执行")).toBeNull();
  });

  it("填了路径才能创建", () => {
    open();
    const create = screen.getByText("创建").closest("button");
    expect(create?.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("路径"), {
      target: { value: "/tmp/projects/demo" },
    });
    expect(create?.disabled).toBe(false);
  });

  it("名称取路径末段，权限全开，颜色不问用户", async () => {
    createWorkspace.mockResolvedValue(created);
    open();
    fireEvent.change(screen.getByLabelText("路径"), {
      target: { value: "/tmp/projects/demo/" },
    });
    fireEvent.click(screen.getByText("创建"));

    await waitFor(() => expect(createWorkspace).toHaveBeenCalled());
    expect(createWorkspace.mock.calls[0]?.[0]).toMatchObject({
      name: "demo",
      rootPath: "/tmp/projects/demo/",
      permissions: { read: true, write: true, execute: true },
      createDirectory: true,
    });
    expect(createWorkspace.mock.calls[0]?.[0].color).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it("目录已经存在（409）时改成直接打开", async () => {
    createWorkspace
      .mockRejectedValueOnce(new RuntimeRequestError(409, "already exists"))
      .mockResolvedValueOnce(created);
    const onCreated = vi.fn();
    open(onCreated);
    fireEvent.change(screen.getByLabelText("路径"), {
      target: { value: "/tmp/projects/demo" },
    });
    fireEvent.click(screen.getByText("创建"));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createWorkspace).toHaveBeenCalledTimes(2);
    expect(createWorkspace.mock.calls[1]?.[0]).toMatchObject({
      rootPath: "/tmp/projects/demo",
      createDirectory: false,
    });
  });
});
