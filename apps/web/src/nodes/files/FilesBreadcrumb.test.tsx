import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { FilesBreadcrumb } from "./FilesBreadcrumb";
import { breadcrumbs, DEFAULT_TAIL } from "./breadcrumb";
import { usePreferencesStore } from "@/app/preferences-store";

/**
 * 用户实测：面包屑「从根目录逐级列出来，太长，箭头太多」。这里钉住画出来
 * 的那一行：根、`…`、最后两级，中间各级只在菜单里。
 */

const deep = breadcrumbs(
  "Users/yovinchen/Projects/Rust/Tauri/armadra/apps/web/src",
  "Armadra",
);

/** Radix 的下拉是 pointerdown 触发的，`click` 打不开。 */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(
    trigger,
    new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(() => cleanup());

describe("面包屑那一行", () => {
  it("只画根、`…` 和最后两级，中间各级不各占一格", () => {
    render(
      <FilesBreadcrumb
        crumbs={deep}
        tailSize={DEFAULT_TAIL}
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByText("Armadra")).toBeTruthy();
    expect(screen.getByText("web")).toBeTruthy();
    expect(screen.getByText("src")).toBeTruthy();
    // 中间各级只在菜单里，行上没有。
    expect(screen.queryByText("Projects")).toBeNull();
    expect(screen.queryByText("yovinchen")).toBeNull();
  });

  it("完整路径挂在整行上，悬停就能看见", () => {
    render(
      <FilesBreadcrumb
        crumbs={deep}
        tailSize={DEFAULT_TAIL}
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByRole("navigation").getAttribute("title")).toBe(
      "Armadra / Users / yovinchen / Projects / Rust / Tauri / armadra / apps / web / src",
    );
  });

  it("点开 `…` 是一份中间各级的菜单，选一项就跳过去", async () => {
    const onNavigate = vi.fn();
    render(
      <FilesBreadcrumb
        crumbs={deep}
        tailSize={DEFAULT_TAIL}
        onNavigate={onNavigate}
      />,
    );

    openMenu(screen.getByLabelText("展开中间目录"));
    const item = await screen.findByRole("menuitem", { name: "Projects" });
    fireEvent.click(item);
    expect(onNavigate).toHaveBeenCalledWith("Users/yovinchen/Projects");
  });

  it("根那一格跳回工作空间根", () => {
    const onNavigate = vi.fn();
    render(
      <FilesBreadcrumb
        crumbs={deep}
        tailSize={DEFAULT_TAIL}
        onNavigate={onNavigate}
      />,
    );
    fireEvent.click(screen.getByText("Armadra"));
    expect(onNavigate).toHaveBeenCalledWith(".");
  });

  it("当前目录不是按钮——点它没有去处", () => {
    render(
      <FilesBreadcrumb
        crumbs={deep}
        tailSize={DEFAULT_TAIL}
        onNavigate={() => {}}
      />,
    );
    const current = screen.getByText("src");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.closest("button")).toBeNull();
  });

  it("层级不多时不出现 `…`", () => {
    render(
      <FilesBreadcrumb
        crumbs={breadcrumbs("src/nodes", "Armadra")}
        tailSize={DEFAULT_TAIL}
        onNavigate={() => {}}
      />,
    );
    expect(screen.queryByLabelText("展开中间目录")).toBeNull();
  });

  it("窄节点收到最后一级", () => {
    render(
      <FilesBreadcrumb crumbs={deep} tailSize={1} onNavigate={() => {}} />,
    );
    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.queryByText("web")).toBeNull();
  });
});
