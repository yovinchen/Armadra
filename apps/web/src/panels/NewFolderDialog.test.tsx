import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const createWorkspace = vi.fn();

vi.mock("../api/client", () => ({
  runtimeApi: {
    createWorkspace: (input: unknown) => createWorkspace(input),
  },
}));

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { NewFolderDialog } from "./NewFolderDialog";

installDomPolyfills();
afterEach(cleanup);

function open() {
  render(
    <TestProviders>
      <NewFolderDialog open onOpenChange={() => undefined} />
    </TestProviders>,
  );
}

describe("NewFolderDialog", () => {
  beforeEach(() => createWorkspace.mockReset());

  it("父目录与名称都填了才能创建", () => {
    open();
    const create = screen.getByText("创建").closest("button");
    expect(create?.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("父目录"), {
      target: { value: "/tmp/projects" },
    });
    expect(create?.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "demo" },
    });
    expect(create?.disabled).toBe(false);
  });

  it("拼出 父目录/名称 并要求 Runtime 建目录", async () => {
    createWorkspace.mockResolvedValue({
      id: "w1",
      name: "demo",
      rootPath: "/tmp/projects/demo",
      color: "#5B5BD6",
      permissions: { read: true, write: true, execute: true },
      lastOpenedAt: "",
      createdAt: "",
      updatedAt: "",
    });
    open();
    fireEvent.change(screen.getByLabelText("父目录"), {
      target: { value: "/tmp/projects/" },
    });
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "demo" },
    });
    fireEvent.click(screen.getByText("创建"));

    await waitFor(() => expect(createWorkspace).toHaveBeenCalled());
    expect(createWorkspace.mock.calls[0]?.[0]).toMatchObject({
      name: "demo",
      rootPath: "/tmp/projects/demo",
      createDirectory: true,
    });
  });
});
