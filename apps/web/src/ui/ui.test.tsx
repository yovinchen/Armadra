import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ColorDot, NODE_COLORS, isNodeColor } from "@/ui/color-dot";
import { ColorPicker, ColorSwatches } from "@/ui/color-picker";
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

describe("ColorDot / ColorPicker", () => {
  it("调色板就是 §3.4 的 7 色", () => {
    expect(NODE_COLORS).toEqual([
      "#0a84ff",
      "#32d74b",
      "#ffd60a",
      "#ff453a",
      "#bf5af2",
      "#6ac4dc",
      "#ff9f0a",
    ]);
    expect(isNodeColor("#0a84ff")).toBe(true);
    expect(isNodeColor("#123456")).toBe(false);
  });

  it("ColorDot 按 size 出直径", () => {
    const { container } = render(<ColorDot color="#0a84ff" size={8} />);
    const dot = container.querySelector(
      "[data-slot='color-dot']",
    ) as HTMLElement;
    expect(dot.style.width).toBe("8px");
    expect(dot.style.backgroundColor).toBe("rgb(10, 132, 255)");
  });

  it("色板是一个 radiogroup，选中项 aria-checked", () => {
    render(<ColorSwatches value="#32d74b" onChange={() => {}} />);
    const group = screen.getByRole("radiogroup", { name: "节点颜色" });
    const radios = screen.getAllByRole("radio");
    expect(group).toBeTruthy();
    expect(radios).toHaveLength(7);
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    // 组内只有选中项进 Tab 序
    expect(
      radios.filter((node) => node.getAttribute("tabindex") === "0"),
    ).toHaveLength(1);
  });

  it("点击色块回调具体颜色", () => {
    const onChange = vi.fn();
    render(<ColorSwatches onChange={onChange} />);
    fireEvent.click(screen.getAllByRole("radio")[3]!);
    expect(onChange).toHaveBeenCalledWith("#ff453a");
  });

  it("左右方向键在色块之间移动焦点并首尾相接", () => {
    render(<ColorSwatches value="#0a84ff" onChange={() => {}} />);
    const radios = screen.getAllByRole("radio");
    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios[1]);
    fireEvent.keyDown(radios[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radios[6]);
  });

  it("ColorPicker 点击触发器后弹出色板", () => {
    render(
      <ColorPicker value="#0a84ff" onChange={() => {}}>
        <button type="button">颜色</button>
      </ColorPicker>,
    );
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "颜色" }));
    expect(screen.getByRole("radiogroup", { name: "节点颜色" })).toBeTruthy();
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
