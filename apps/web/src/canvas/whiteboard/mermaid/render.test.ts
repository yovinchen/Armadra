import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEQUENCE } from "./fixtures";

/**
 * 图片回退的调用契约（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §3.2 / §7）。
 *
 * `mermaid.render` 在 jsdom 里跑不了——它要量 `getBBox`，而 jsdom 没有 SVG
 * 度量（2026-09-19 实测：`childNodeEl.node(...)?.getBBox is not a function`）。
 * 所以这里 mock 掉渲染，只钉**契约**：回退路径必须把 SVG 变成一个
 * `image/svg+xml` 的文件交给现成的资产导入路径，而不是自己另写一套上传。
 *
 * 真正的像素化（SVG → PNG）与 8 MiB 上限归 `dnd/external-content`，那一层
 * 自己有测试，这里不重复。
 */

vi.mock("./render", async () => {
  const actual = await vi.importActual<typeof import("./render")>("./render");
  return {
    ...actual,
    renderMermaidSvg: vi.fn(
      async () => "<svg xmlns='http://www.w3.org/2000/svg'/>",
    ),
  };
});

const { renderMermaidSvg, svgToFile } = await import("./render");

beforeEach(() => {
  vi.mocked(renderMermaidSvg).mockClear();
});

describe("svgToFile", () => {
  it("产出 image/svg+xml 的文件，文件名带图种", () => {
    const file = svgToFile("<svg/>", "sequence");
    expect(file.name).toBe("sequence.svg");
    expect(file.type).toBe("image/svg+xml");
    expect(file.size).toBeGreaterThan(0);
  });

  it("文件内容就是传进去的 SVG（后续由资产路径栅格化成 PNG）", async () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>";
    expect(await svgToFile(svg, "pie").text()).toBe(svg);
  });
});

describe("renderMermaidSvg 的调用契约", () => {
  it("接一段图文本，回一段 SVG 字符串", async () => {
    const svg = await renderMermaidSvg(SEQUENCE);
    expect(renderMermaidSvg).toHaveBeenCalledWith(SEQUENCE);
    expect(svg.startsWith("<svg")).toBe(true);
  });

  it("回来的 SVG 能直接接上 svgToFile", async () => {
    const file = svgToFile(await renderMermaidSvg(SEQUENCE), "sequence");
    expect(file.type).toBe("image/svg+xml");
  });
});
