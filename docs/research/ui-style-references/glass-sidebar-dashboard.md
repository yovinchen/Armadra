---
reference_id: glass-sidebar-dashboard
title: Glass Sidebar 玻璃侧栏仪表盘
source_url: https://x.com/HeyDetya/status/2095168656875597871
source_type: x-post
observed_at: 2026-09-04
status: reference
visual_mode: light
density: medium
layout_patterns:
  - photographic-backdrop
  - glass-sidebar
  - opaque-content-panel
  - rounded-dashboard
recommended_surfaces:
  - launcher
  - workspace-rail
  - overview
adoption: selective
---

# Glass Sidebar 玻璃侧栏仪表盘

> 外部 UI 风格参考，不是当前产品的实现契约。建议只提取玻璃层次和窗口结构，不直接复制照片背景、财务内容或整套大圆角卡片。

## 快速筛选

| 维度 | 判断 |
| --- | --- |
| 风格关键词 | 玻璃拟态、照片背景、大圆角、柔和、强品牌感 |
| 最适合 | 启动页、工作空间 Rail、欢迎页、轻量概览 |
| 不适合 | 终端、代码、超宽表格、高密度无限画布 |
| 信息密度 | 中 |
| 视觉强度 | 高 |
| 性能与可访问性风险 | 高 |
| 当前项目采用建议 | 只在最左侧 Rail 或启动页使用轻度玻璃，其余区域保持不透明 |

## 一句话定义

让摄影背景通过半透明 Sidebar 和窗口边缘显露，同时用不透明主面板保护业务内容的可读性。

## 来源与观察边界

- 来源：[Hey Detya — joining the trend](https://x.com/HeyDetya/status/2095168656875597871)
- 三张纵向图片从左到右组成一个超宽的 Ledger 财务仪表盘。
- 推文讨论的是玻璃透明 Sidebar 趋势；截图没有展示暗色主题、窄屏、Reduce Transparency 或低性能降级状态。

## 页面内容

### 玻璃 Sidebar

- Ledger 品牌和主导航。
- 股票行情列表，使用国旗、涨跌数值和红绿状态。
- Integrations 宣传卡片。
- Logout。

### 不透明业务面板

- 搜索、通知、主题和用户入口。
- Add Transaction 主操作。
- Balance、Income、Expenses、Savings rate。
- Spending Overview 柱状图。
- Recent Transactions、Top Categories 和 Savings goals。

## 层次结构

```text
┌──────────────── 摄影背景 / 氛围层 ────────────────┐
│ ┌──── 半透明玻璃 Sidebar ────┐ ┌── 不透明主面板 ─┐ │
│ │ Brand                     │ │ Header           │ │
│ │ Navigation                │ │ KPI cards        │ │
│ │ Market status             │ │ Charts           │ │
│ │ Integration promo         │ │ Transactions     │ │
│ │ Logout                    │ │ Goals            │ │
│ └───────────────────────────┘ └──────────────────┘ │
└────────────────────────────────────────────────────┘
```

真正有效的不是“所有区域都透明”，而是三层透明度分工：

1. 背景负责品牌氛围。
2. Sidebar 保留背景联系，但维持导航可读性。
3. 主内容保持不透明，保护图表、数字和长列表。

## 视觉 DNA

### 色彩

| Token | 建议值 | 用途 |
| --- | --- | --- |
| `backdrop-fallback` | `#D8D2C5` | 图片不可用时的暖灰背景 |
| `glass-surface` | `rgba(255,255,255,.68)` | Sidebar 玻璃层 |
| `content-surface` | `#FFFFFF` | 主内容面板 |
| `border-glass` | `rgba(255,255,255,.72)` | 玻璃高光边界 |
| `text-primary` | `#202124` | 主文字 |
| `accent-warm` | `#FF7A00` | 品牌和图表高亮 |

当前项目不应直接使用橙色作为全局品牌色；如采用该结构，应继续使用现有靛蓝，只借用透明度和层次。

### 字体

- 品牌与主要数字：SF Pro Display / 系统字体，600–700。
- 导航和正文：SF Pro Text / PingFang SC，400–500。
- 路径、端口、Token 和日志计数：SF Mono / Menlo。

### 形状与空间

- 应用外框圆角：28–32px。
- Sidebar 与主面板圆角：20–24px。
- 卡片圆角：18–22px。
- 阴影使用大扩散和低透明度，不使用硬边黑影。
- Sidebar 比普通工作台更宽松，不适合直接承载密集文件树。

## 玻璃效果实现原则

```css
.workspace-rail-glass {
  background: rgb(255 255 255 / 72%);
  border-right: 1px solid rgb(255 255 255 / 64%);
  backdrop-filter: blur(20px) saturate(1.08);
  -webkit-backdrop-filter: blur(20px) saturate(1.08);
}

@supports not (backdrop-filter: blur(1px)) {
  .workspace-rail-glass {
    background: var(--panel);
    border-right-color: var(--border);
  }
}
```

实现时注意：

- 模糊只能作用于玻璃后方真实存在的 DOM 内容；不要把它误认为系统级 macOS 材质。
- Tauri 透明窗口和系统级背景模糊涉及平台差异，不应作为第一阶段前提。
- 模糊层数量必须受控，避免每张卡片都使用 `backdrop-filter`。
- 图片加载失败时提供稳定的纯色或渐变降级。
- 高对比模式和减少透明度偏好下切换为不透明面板。

## 在 AI Coding Canvas 中的选择性使用

推荐只保留一个视觉签名：最左侧 52px 工作空间 Rail 使用轻度玻璃，其余界面继续保持当前不透明面板。

```text
背景不使用常驻照片
        ↓
玻璃 Rail 轻微透出画布点阵与节点颜色
        ↓
Sidebar、Canvas、Inspector 仍为稳定不透明表面
```

适合的具体位置：

- Launcher 的最近工作空间区域。
- 工作空间 Rail。
- 空画布欢迎状态。
- 非关键的产品介绍或连接引导。

不适合的位置：

- Terminal、Diff、File Preview 和代码内容。
- Skills 表格和 Analytics 主图表。
- Inspector 的属性编辑区。
- 需要长时间阅读的 Agent Transcript。

## 风险与修正

### 可读性

背景亮度变化会影响文字。玻璃层应叠加稳定的白色底，而不是只使用模糊；文字与背景对比度需要在多种画布状态下验证。

### 性能

多个实时模糊层会增加合成成本。只允许一个主要玻璃区域，滚动容器和节点卡片不要继续叠加模糊。

### 产品错位

财务面板依赖大圆角和大留白，直接复制会降低代码工具的信息效率。当前项目只借用 Rail 的材质感，不借用财务 Dashboard 的尺寸体系。

### 背景干扰

不使用随机壁纸作为默认背景。可以让 Rail 透出当前 Canvas 的点阵、工作空间颜色或节点状态，从产品内容本身获得氛围。

## 采用检查清单

- [ ] 全应用最多只有一个主要玻璃区域。
- [ ] 无 `backdrop-filter` 时仍有完整的纯色降级。
- [ ] 高对比和减少透明度条件下切换为不透明面板。
- [ ] 不在终端、代码、表格和长文本区域使用玻璃。
- [ ] 使用真实画布内容形成氛围，不依赖随机照片。
- [ ] 在 macOS、Windows 和 Linux WebView 上检查渲染与性能。
- [ ] 玻璃是品牌签名，不承担关键状态表达。

