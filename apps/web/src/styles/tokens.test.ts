// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// vitest 默认把 CSS 模块 stub 成空串（`test.css: false`），连 `?raw` 也一样，
// 所以这里直接按文件读——本来要断言的也就是源文件的文本。
const tokensCss = readFileSync(
  fileURLToPath(new URL("./tokens.css", import.meta.url)),
  "utf8",
);

/**
 * tokens.css 是 `src/ui/*` 与 Phase 1 全部界面 agent 的共享契约。
 * 这里不校验具体色值（那属于设计决定，会变），只校验“契约里的名字都在，
 * 并且深浅两套主题都各自声明了一遍”——这才是会被悄悄改坏的部分。
 */

/** docs/contracts/v3-agent-terminal-plan.md §4.3 里点名的 shadcn 别名。 */
const SHADCN_ALIASES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
] as const;

/** §3.1 的布局常量。 */
const LAYOUT_CONSTANTS: Record<string, string> = {
  "--tabbar-h": "44px",
  "--sidebar-w": "240px",
  "--dock-h": "44px",
  "--drawer-w": "360px",
  "--scm-w": "460px",
};

/** §3.1 的 z 轴栈，顺序不能乱。 */
const Z_SCALE: Array<[string, number]> = [
  ["--z-pills", 5],
  ["--z-sessions", 12],
  ["--z-dock", 20],
  ["--z-cluster", 26],
  ["--z-banners", 27],
  ["--z-tabbar", 30],
  ["--z-focus", 40],
  ["--z-menu", 46],
  ["--z-dialog", 55],
];

/** §3.4 的 Agent 品牌色。 */
const AGENT_COLORS: Record<string, string> = {
  "--agent-claude": "#d97757",
  "--agent-codex": "#10a37f",
  "--agent-gemini": "#4285f4",
  "--agent-opencode": "#a78bfa",
  "--agent-pi": "#e8b86d",
  "--agent-omp": "#d4a373",
  "--agent-copilot": "#a371f7",
};

/** §3.4 的节点调色板 7 色。 */
const NODE_PALETTE = [
  "#0a84ff",
  "#32d74b",
  "#ffd60a",
  "#ff453a",
  "#bf5af2",
  "#6ac4dc",
  "#ff9f0a",
];

/**
 * 取出某个选择器后面第一层 `{...}` 的内容。用大括号计数而不是正则，
 * 因为 token 值里出现 `rgb(... / 10%)` 这类嵌套括号很常见。
 */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`未找到选择器：${selector}`);
  // 从 `start` 而不是 `start + selector.length` 开始找，这样选择器串里
  // 带不带那个 `{` 都能正确定位。
  const open = css.indexOf("{", start);
  if (open === -1) throw new Error(`选择器缺少规则体：${selector}`);

  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const char = css[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`规则体没有闭合：${selector}`);
}

/** 把规则体解析成 `自定义属性名 → 值`。注释里的伪声明会被先剥掉。 */
function customProperties(body: string): Map<string, string> {
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1]!, match[2]!.trim().replace(/\s+/g, " "));
  }
  return out;
}

const dark = customProperties(ruleBody(tokensCss, ":root {"));
const light = customProperties(
  ruleBody(tokensCss, ':root[data-theme="light"]'),
);

describe("tokens.css", () => {
  it("深色是默认主题（无属性选择器的 :root 就是深色）", () => {
    expect(dark.get("--tint-rgb")).toBe("255 255 255");
    expect(tokensCss).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*dark/);
  });

  it.each(SHADCN_ALIASES)("深色主题定义了 %s", (alias) => {
    expect(dark.has(alias)).toBe(true);
    expect(dark.get(alias)).toBeTruthy();
  });

  it.each(SHADCN_ALIASES)("浅色主题定义了 %s", (alias) => {
    expect(light.has(alias)).toBe(true);
    expect(light.get(alias)).toBeTruthy();
  });

  it("没有悬空的 var() 引用", () => {
    const missing: string[] = [];
    for (const [theme, table] of [
      ["dark", dark],
      ["light", light],
    ] as const) {
      for (const [name, value] of table) {
        for (const match of value.matchAll(/var\((--[\w-]+)/g)) {
          const referenced = match[1]!;
          if (!dark.has(referenced))
            missing.push(`${theme} ${name} → ${referenced}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("shadcn 组件直接读的圆角变量都在 :root 上", () => {
    // button/badge 里有 `rounded-[min(var(--radius-md),10px)]` 这种写法，
    // `@theme inline` 不会把变量写进 :root，所以必须由 tokens.css 提供。
    for (const name of [
      "--radius",
      "--radius-sm",
      "--radius-md",
      "--radius-lg",
    ]) {
      expect(dark.has(name)).toBe(true);
    }
  });

  it("品牌色与 shadcn 的 --accent 是两个不同的东西", () => {
    // shadcn 的 --accent 是菜单高亮底色；品牌蓝在 --brand / --primary
    expect(dark.get("--brand")).toBe("#0a84ff");
    expect(light.get("--brand")).toBe("#007aff");
    expect(dark.get("--primary")).toBe("var(--brand)");
    expect(dark.get("--accent")).not.toContain("--brand");
  });

  it("表面高度阶梯完整", () => {
    for (const name of [
      "--surface-sunken",
      "--surface-deep",
      "--surface-base",
      "--surface-raised",
      "--surface-overlay",
    ]) {
      expect(dark.has(name)).toBe(true);
      expect(light.has(name)).toBe(true);
    }
  });

  it("布局常量按 §3.1 取值", () => {
    for (const [name, value] of Object.entries(LAYOUT_CONSTANTS)) {
      expect(dark.get(name)).toBe(value);
    }
  });

  it("z 轴栈取值与顺序都符合 §3.1", () => {
    const values = Z_SCALE.map(([name, expected]) => {
      expect(dark.get(name)).toBe(String(expected));
      return expected;
    });
    const sorted = [...values].sort((a, b) => a - b);
    expect(values).toEqual(sorted);
  });

  it("Agent 品牌色与主题无关，只在深色块里声明一次", () => {
    for (const [name, value] of Object.entries(AGENT_COLORS)) {
      expect(dark.get(name)).toBe(value);
      expect(light.has(name)).toBe(false);
    }
  });

  it("节点调色板是 §3.4 的 7 色", () => {
    const palette = Array.from({ length: 7 }, (_, index) =>
      dark.get(`--node-color-${index + 1}`),
    );
    expect(palette).toEqual(NODE_PALETTE);
  });

  it("状态色齐全", () => {
    for (const name of [
      "--danger",
      "--warn",
      "--caution",
      "--success",
      "--agent-working",
      "--status-working",
      "--status-attention",
      "--status-failed",
      "--status-queued",
      "--status-paused",
      "--status-unread",
      "--status-idle",
    ]) {
      expect(dark.has(name)).toBe(true);
    }
  });

  it("表面阶梯多了卡片这一档，且 --card 指向它", () => {
    // §24.2：窗口底 → 面板（+4%）→ 卡片（+7%），三档灰度替代线框分层
    for (const table of [dark, light]) {
      expect(table.has("--surface-card")).toBe(true);
      expect(table.get("--card")).toBe("var(--surface-card)");
    }
  });

  it("四档语义圆角齐全（§24.2）", () => {
    const radii: Record<string, string> = {
      "--r-control": "6px",
      "--r-card": "10px",
      "--r-panel": "12px",
      "--r-dialog": "14px",
    };
    for (const [name, value] of Object.entries(radii)) {
      expect(dark.get(name)).toBe(value);
    }
  });

  it("字号阶梯是 17/15/13/11，没有 11px 以下的档位", () => {
    expect(dark.get("--text-title")).toBe("17px");
    expect(dark.get("--text-section")).toBe("15px");
    expect(dark.get("--text-body")).toBe("13px");
    expect(dark.get("--text-caption")).toBe("11px");
  });

  it("动效时长落在 120–180ms（§24.2）", () => {
    for (const name of ["--dur-fast", "--dur-base", "--dur-slow"]) {
      const value = Number((dark.get(name) ?? "").replace("ms", ""));
      expect(value).toBeGreaterThanOrEqual(120);
      expect(value).toBeLessThanOrEqual(180);
    }
  });

  it("侧栏材质两套主题都声明了", () => {
    expect(dark.has("--sidebar-material")).toBe(true);
    expect(light.has("--sidebar-material")).toBe(true);
  });

  it("有 prefers-reduced-motion 保护", () => {
    expect(tokensCss).toContain("prefers-reduced-motion: reduce");
    expect(tokensCss).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });

  it("不加载在线字体", () => {
    expect(tokensCss).not.toMatch(/@font-face|fonts\.googleapis|https?:/);
  });
});
