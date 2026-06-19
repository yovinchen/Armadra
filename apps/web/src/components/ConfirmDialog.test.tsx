import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";
import { PreferencesProvider } from "../preferences/Preferences";

describe("ConfirmDialog", () => {
  it("requires an explicit confirmation before destructive work", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <PreferencesProvider>
        <ConfirmDialog
          open
          title="删除节点？"
          description="节点和连线将被移除。"
          confirmLabel="确认删除"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </PreferencesProvider>,
    );

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
