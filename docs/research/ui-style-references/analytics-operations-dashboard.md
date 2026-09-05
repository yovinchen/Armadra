---
reference_id: analytics-operations-dashboard
title: Analytics 高密度运营仪表盘
source_url: https://x.com/_heyrico/status/2095187516257366407
source_type: x-post
observed_at: 2026-09-04
status: reference
visual_mode:
  - light
  - dark
density: high
layout_patterns:
  - persistent-sidebar
  - filter-toolbar
  - metric-grid
  - analytical-charts
recommended_surfaces:
  - usage
  - runtime
  - costs
  - observability
adoption: recommended
---

# Analytics 高密度运营仪表盘

> 外部 UI 风格参考，不是当前产品的实现契约。截图中的数据为设计示例，不能作为真实指标定义；尺寸和颜色均为目测近似值。

## 快速筛选

| 维度 | 判断 |
| --- | --- |
| 风格关键词 | 克制、分析型、卡片网格、高信息密度、双主题 |
| 最适合 | Usage、Runtime、成本、模型与 Agent 观测 |
| 不适合 | 复杂表单、技能安装、长文本编辑、终端主体 |
| 信息密度 | 高 |
| 视觉强度 | 中低 |
| 响应式难度 | 中，依赖稳定的卡片重排规则 |
| 当前项目采用建议 | 采用网格、过滤栏和指标层级；所有卡片必须连接真实行动 |

## 一句话定义

用低对比卡片和统一图表语言，在单屏内呈现概览、趋势、构成和异常入口。

## 来源与观察边界

- 来源：[rico — light mode](https://x.com/_heyrico/status/2095187516257366407)
- 当前推文展示浅色 Analytics 页面，并引用了同一设计方向的早期暗色版本。
- 浅色和暗色版本不仅是颜色互换，Sidebar 的导航和业务内容也有变化，应视为同一视觉系统的两个产品迭代样例。

## 页面内容

### 左侧导航

- 工作空间和 Quick actions。
- Home、Analytics、Plan、Apps 等一级入口。
- Campaign、Creatives、Briefs、Workflows 等工具。
- Pinned、最近对话、Getting started 和套餐状态。

### 顶部控制区

- 页面标题。
- 时间范围、对比周期、货币和渠道过滤器。
- Accounts、Refresh、Save as report、Manage metrics。

### 数据区

- 四个 KPI 卡片。
- 一个主趋势图。
- 一个指标构成列表。
- 产品排行和两个次级趋势图。
- 底部悬浮 AI 助手入口。

## 信息架构

```text
┌──── Sidebar ────┬──────────────── Analytics ────────────────┐
│ Workspace       │ 标题        Filters           Actions    │
│ Navigation      ├───────────────────────────────────────────┤
│ Tools           │ KPI │ KPI │ KPI │ KPI                     │
│ Pinned          ├───────────────────────┬───────────────────┤
│ Recents         │ 主趋势图              │ 指标构成          │
│ Onboarding      ├─────────────┬─────────┴─────────┬─────────┤
│ Plan status     │ 排行        │ 次级趋势          │ 次级趋势│
└─────────────────┴─────────────┴───────────────────┴─────────┘
```

信息顺序遵循：

```text
当前结果 → 与过去比较 → 变化趋势 → 构成原因 → 可执行入口
```

## 视觉 DNA

### 色彩

| Token | 浅色建议 | 暗色建议 | 用途 |
| --- | --- | --- | --- |
| `surface-app` | `#F3F4F8` | `#272727` | 应用外围 |
| `surface-panel` | `#FFFFFF` | `#171717` | 主面板 |
| `surface-card` | `#FFFFFF` | `#1B1B1B` | 数据卡片 |
| `border-subtle` | `#E7E8EA` | `#2A2A2A` | 卡片与分区 |
| `data-primary` | `#2E8CF0` | `#3296FF` | 主图表和链接 |
| `text-primary` | `#202124` | `#F0F0F0` | 主要文字 |

涨跌使用绿色和红色，但颜色必须与箭头、正负号和文字同时出现。

### 字体

- 页面标题和卡片数字：SF Pro Display / 系统字体，600。
- 导航、标签和说明：SF Pro Text / PingFang SC，400–500。
- 时间、Token、金额和技术指标：SF Mono / Menlo，可选用于局部数据，不要覆盖全部图表。

### 网格与尺寸

- 桌面端使用 12 列 Grid，间距约 16–20px。
- 首行 KPI 每项占 3 列。
- 主趋势图占 8 列，构成列表占 4 列。
- 底部三张卡片各占 4 列。
- 卡片圆角 12–14px；边框 1px；普通卡片不使用明显投影。
- KPI 标题 12–13px，数字 22–28px，变化量 11–12px。

## 关键组件

```text
AnalyticsPage
├── AnalyticsSidebar
├── AnalyticsHeader
├── AnalyticsFilterBar
├── MetricCardGrid
│   └── MetricCard
├── PrimaryTrendCard
├── BreakdownCard
├── RankedUsageCard
├── SecondaryTrendCard
└── ContextAssistantButton
```

## 图表规则

- 每张图只承担一个主要问题，避免在一张卡片里混合过多指标。
- 主趋势可以包含当前周期与对比周期；对比线降低饱和度或使用虚线。
- 默认显示单位、时间范围和数据来源。
- Hover tooltip 同时支持键盘聚焦，不只监听鼠标移动。
- 图表旁提供文本摘要，例如“过去 7 天失败率上升 3.1%”。
- 空数据、部分数据和采样延迟必须明确显示，不能绘制伪造的平滑曲线。

## 在 AI Coding Canvas 中的内容映射

| 原参考内容 | 当前项目替换内容 |
| --- | --- |
| Gross sales | Token / Cost |
| Returning customer rate | Agent 重试率 |
| Order fulfilled | 已完成任务 |
| Orders | Agent 会话数 |
| Total sales over time | 调用量、成本或执行时长趋势 |
| Sales breakdown | 模型、Agent、工作空间使用构成 |
| Top products | 使用最多的 Agent 或 Skills |
| Ask Victor | 询问当前工作空间状态 |

建议优先呈现：

- 正在运行的 Agent。
- 待审批操作。
- 成功率、失败率与重试率。
- 平均执行时间。
- Token 和成本趋势。
- 模型与 Agent 使用构成。
- Git 变更和未完成任务。
- Runtime 与 ACP 适配器健康状态。

## 产品化要求

仪表盘不能是只读装饰。指标卡应能回到真实工作现场：

```text
点击“3 个待审批”
        ↓
切换到 Canvas
        ↓
聚焦并高亮对应 Agent 节点
```

同样地：

- 点击失败率，过滤并聚焦失败节点。
- 点击 Token 峰值，打开对应时段和 Agent 列表。
- 点击未提交变更，聚焦 Diff 节点。
- 点击 Skill 使用量，进入 Skill 详情和绑定关系。

## 响应式策略

- `>= 1280px`：4 KPI + 8/4 主区 + 3 个底部卡片。
- `900–1279px`：2×2 KPI；所有分析卡片按单列或 2 列排列。
- `< 900px`：Sidebar 进入抽屉；过滤器允许横向滚动；图表保持最小高度。
- 不通过无限缩小字号维持桌面布局。

## 采用检查清单

- [ ] 每项指标都有业务定义、单位、来源和更新时间。
- [ ] KPI 能进入相应的 Canvas、Agent、Diff 或 Skill 上下文。
- [ ] 图表提供键盘可达 tooltip 和文本摘要。
- [ ] 颜色之外还有符号、文字或线型表达涨跌与状态。
- [ ] 浅色、暗色、空数据和延迟数据均已验证。
- [ ] 1024px 与窄屏布局通过真实内容测试。
- [ ] 不使用虚构运行数据掩盖尚未实现的 Runtime 能力。

