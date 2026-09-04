import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import { IconButton } from "@/ui/icon-button";
import { Kbd, KbdGroup } from "@/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { STATUS_PILL_LABELS, StatusPill } from "@/ui/status-pill";
import { Switch } from "@/ui/switch";

beforeAll(() => {
  // Radix 的定位层（floating-ui）在 jsdom 下需要这两个 API
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  const element = Element.prototype as unknown as Record<string, unknown>;
  if (!("hasPointerCapture" in element)) {
    element.hasPointerCapture = () => false;
    element.setPointerCapture = () => {};
    element.releasePointerCapture = () => {};
  }
});

afterEach(cleanup);

describe("Button（shadcn 生成）", () => {
  it("默认是 type=button 之外的原生按钮，variant/size 落到 data 属性上", () => {
    render(
      <Button variant="destructive" size="sm">
        删除
      </Button>,
    );
    const button = screen.getByRole("button", { name: "删除" });
    expect(button.dataset.slot).toBe("button");
    expect(button.dataset.variant).toBe("destructive");
    expect(button.dataset.size).toBe("sm");
  });

  it("className 通过 twMerge 覆盖内置尺寸而不是叠加", () => {
    render(<Button className="h-12">高</Button>);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("h-12");
    expect(cls).not.toMatch(/\bh-8\b/);
  });

  it("asChild 把样式套到子元素上", () => {
    render(
      <Button asChild>
        <a href="#a">链接</a>
      </Button>,
    );
    expect(screen.getByRole("link", { name: "链接" }).dataset.slot).toBe(
      "button",
    );
  });
});

describe("StatusPill", () => {
  it("按 tone 打标记并显示文案", () => {
    render(
      <StatusPill tone="attention" label={STATUS_PILL_LABELS.attention} />,
    );
    const pill = screen
      .getByText("Needs you")
      .closest("[data-slot='status-pill']");
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute("data-tone")).toBe("attention");
  });

  it("working / attention 默认脉冲，failed 不脉冲", () => {
    const { container, rerender } = render(
      <StatusPill tone="working" label="Running" />,
    );
    const dot = () => container.querySelector("[data-slot='status-pill-dot']")!;
    expect(dot().className).toContain("anim-dot-pulse");

    rerender(<StatusPill tone="failed" label="Turn failed" />);
    expect(dot().className).not.toContain("anim-dot-pulse");
  });

  it("pulse 可以显式关掉", () => {
    const { container } = render(
      <StatusPill tone="working" label="Running" pulse={false} />,
    );
    expect(
      container.querySelector("[data-slot='status-pill-dot']")!.className,
    ).not.toContain("anim-dot-pulse");
  });

  it("支持尾随内容（队列的 ▶）", () => {
    const { container } = render(
      <StatusPill tone="queued" label="Queued" trailing="▶" />,
    );
    expect(
      container.querySelector("[data-slot='status-pill']")!.textContent,
    ).toBe("Queued▶");
  });
});

describe("ColorDot", () => {
  it("supports semantic status indicators and whiteboard colour swatches", () => {
    const { container } = render(<ColorDot color="#0a84ff" size={8} />);
    const dot = container.querySelector(
      "[data-slot='color-dot']",
    ) as HTMLElement;
    expect(dot.style.width).toBe("8px");
    expect(dot.style.backgroundColor).toBe("rgb(10, 132, 255)");
  });
});

describe("IconButton", () => {
  it("label 变成无障碍名称", () => {
    render(<IconButton label="整理画布" />);
    expect(screen.getByRole("button", { name: "整理画布" })).toBeTruthy();
  });

  it("cluster 是 34×34，inline 是 26×26", () => {
    const { rerender } = render(<IconButton label="设置" size="cluster" />);
    expect(screen.getByRole("button").className).toContain("size-[28px]");
    rerender(<IconButton label="关闭" size="inline" />);
    expect(screen.getByRole("button").className).toContain("size-[26px]");
  });

  it("active 同时反映在 data-active 和 aria-pressed 上", () => {
    render(<IconButton label="固定侧栏" active />);
    const button = screen.getByRole("button", { name: "固定侧栏" });
    expect(button.dataset.active).toBe("true");
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("其余生成组件的冒烟测试", () => {
  it("Badge 渲染内容", () => {
    render(<Badge variant="secondary">Claude</Badge>);
    expect(screen.getByText("Claude").dataset.slot).toBe("badge");
  });

  it("Kbd 渲染成 <kbd>", () => {
    render(
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>,
    );
    expect(screen.getByText("⌘").tagName).toBe("KBD");
  });

  it("Switch 可以用键盘切换", () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="启用消息" onCheckedChange={onCheckedChange} />);
    const toggle = screen.getByRole("switch", { name: "启用消息" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("Popover 由触发器控制开合", () => {
    render(
      <Popover>
        <PopoverTrigger>打开</PopoverTrigger>
        <PopoverContent>内容</PopoverContent>
      </Popover>,
    );
    expect(screen.queryByText("内容")).toBeNull();
    fireEvent.click(screen.getByText("打开"));
    expect(screen.getByText("内容")).toBeTruthy();
  });
});
