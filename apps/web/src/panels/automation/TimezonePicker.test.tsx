import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";
import { LIMIT, TimezonePicker, visibleZones } from "./TimezonePicker";

beforeAll(installDomPolyfills);
afterEach(cleanup);

describe("时区列表", () => {
  const zones = [
    "Africa/Abidjan",
    "America/New_York",
    "Asia/Ho_Chi_Minh",
    "Asia/Shanghai",
    "UTC",
  ];

  it("按关键字过滤，下划线当空格，不分大小写", () => {
    expect(visibleZones(zones, "ho chi", "UTC")).toEqual(["Asia/Ho_Chi_Minh"]);
    expect(visibleZones(zones, "ASIA/", "UTC")).toEqual([
      "Asia/Ho_Chi_Minh",
      "Asia/Shanghai",
    ]);
  });

  it("没有关键字时当前值排第一，并且限量", () => {
    const many = Array.from({ length: 400 }, (_, index) => `Zone/${index}`);
    const shown = visibleZones(many, "", "Zone/399");
    expect(shown).toHaveLength(LIMIT);
    expect(shown[0]).toBe("Zone/399");
  });
});

describe("时区选择", () => {
  it("关着的时候一个选项都不渲染", () => {
    render(<TimezonePicker value="Asia/Shanghai" onChange={() => {}} />);
    expect(screen.getByRole("combobox").textContent).toContain("Asia/Shanghai");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("打开后可搜索，选中即回写并收起", () => {
    const onChange = vi.fn();
    render(<TimezonePicker value="UTC" onChange={onChange} />);
    fireEvent.click(screen.getByRole("combobox"));
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(options.length).toBeLessThanOrEqual(LIMIT);
    fireEvent.change(screen.getByPlaceholderText("搜索时区"), {
      target: { value: "shanghai" },
    });
    fireEvent.click(screen.getByRole("option", { name: "Asia/Shanghai" }));
    expect(onChange).toHaveBeenCalledWith("Asia/Shanghai");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("没有匹配时给出空状态", () => {
    render(<TimezonePicker value="UTC" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.change(screen.getByPlaceholderText("搜索时区"), {
      target: { value: "nowhere-at-all" },
    });
    expect(screen.getByText("没有匹配的时区")).toBeTruthy();
  });
});
