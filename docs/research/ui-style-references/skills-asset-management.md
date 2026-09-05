---
reference_id: skills-asset-management
title: Skills 资产管理工作台
source_url: https://x.com/arknow91/status/2095396647652008090
source_type: x-post
observed_at: 2026-09-04
status: reference
visual_mode: light
density: high
layout_patterns:
  - persistent-sidebar
  - starter-pack-shelf
  - searchable-table
recommended_surfaces:
  - skills
  - mcp
  - agents
  - integrations
adoption: recommended
---

# Skills 资产管理工作台

> 外部 UI 风格参考，不是当前产品的实现契约。截图中的尺寸与颜色均为目测近似值；真正落地前仍需通过当前设计基线、数据模型和安全边界评审。

## 快速筛选

| 维度 | 判断 |
| --- | --- |
| 风格关键词 | 克制、桌面工具、高密度、低对比、资产管理 |
| 最适合 | Skills、MCP、Agent、插件和集成管理 |
| 不适合 | 无限画布主体、终端、沉浸式内容编辑 |
| 信息密度 | 高 |
| 视觉强度 | 低 |
| 响应式难度 | 中高，表格依赖宽屏 |
| 当前项目采用建议 | 结构和组件语言可直接吸收，安装流程必须补安全审查 |

## 一句话定义

把技能发现、批量安装、已安装技能检索和 Agent 绑定集中在一个可快速扫描的管理页面中。

## 来源与观察边界

- 来源：[Arek — skills view](https://x.com/arknow91/status/2095396647652008090)
- 推文由三张纵向截图组成；从连续的卡片和表格列判断，它们是同一张超宽桌面页面的横向切片，而不是三个独立页面。
- 页面展示的是视觉与内容概念，没有公开安装状态、错误态、权限模型或后端实现。

## 页面内容

### 左侧工作空间

- 工作空间名称和切换入口。
- 全局搜索。
- Chat、Inbox、Templates、Integrations、Skills 等一级导航。
- Agent 列表，例如产品发现、研究综合、设计审查、设计系统和可用性测试。
- Usage、Settings 和连接更多应用。

### Skills 主区域

- 页面标题和 `Create skill` 主操作。
- `Browse library` 次操作。
- Starter pack 横向卡片：产品设计、前端工程、后端与基础设施。
- 已安装技能区，包含搜索、排序和表格。
- 表格字段为 Name、Description、Type、Agents、Author、Updated。

## 信息架构

```text
┌──── 工作空间侧栏 ────┬──────────────── Skills ────────────────┐
│ Workspace / Search   │ 标题                     Create skill │
│ Chat / Inbox         ├───────────────────────────────────────┤
│ Templates            │ Starter packs                        │
│ Integrations         │ [Product] [Frontend] [Backend]       │
│ Skills               ├───────────────────────────────────────┤
│                      │ Installed skills       Search/Filter │
│ Agents               │ Name │ Desc │ Type │ Agents │ Meta   │
│ Usage / Settings     │                                       │
└──────────────────────┴───────────────────────────────────────┘
```

核心关系不是单纯的“技能列表”，而是：

```text
技能包发现 → 安装技能 → 分类与维护 → 绑定给 Agent
```

## 视觉 DNA

### 色彩

| Token | 建议值 | 用途 |
| --- | --- | --- |
| `surface-app` | `#F3F4F8` | 应用外围和窗口背景 |
| `surface-panel` | `#FFFFFF` | 主面板、卡片、表格 |
| `surface-sidebar` | `#FCFCFB` | 左侧导航 |
| `border-subtle` | `#E7E8EA` | 分区、卡片和表格线 |
| `text-primary` | `#202124` | 标题和主要数据 |
| `action-primary` | `#2E7CF6` | 链接和主要操作 |

类型标签可以使用低饱和蓝、橙、紫和灰，但标签必须保留文字，不能只靠颜色表达类别。

### 字体

- 页面标题：SF Pro Display / 系统字体，16–18px，600。
- 正文与表格：SF Pro Text / PingFang SC，13–14px，400–500。
- 快捷键、版本号和技术标识：SF Mono / Menlo，11–12px。
- 不依赖在线字体，保持桌面应用的原生感和离线能力。

### 尺寸与节奏

- Sidebar：约 248–260px。
- 页面 Header：52–56px。
- 表格 Header：40–44px；数据行：52–56px。
- 卡片圆角：10–12px；按钮圆角：7–9px。
- 主区块间距：24–32px；组件内部以 4/8px 网格组织。
- 阴影只用于悬浮层；普通卡片优先使用边框。

## 关键组件

```text
SkillsPage
├── SkillsSidebar
├── SkillsHeader
├── StarterPackShelf
│   └── StarterPackCard
├── SkillsToolbar
├── SkillsTable
│   ├── SkillTypeBadge
│   ├── AgentBindingLinks
│   └── AuthorCell
├── SkillDetailDrawer
└── InstallReviewDialog
```

### Starter pack 卡片

- 只展示包名、用途、技能数量和安装量。
- `Add all` 必须明确将要安装多少项。
- 已部分安装时显示 `3 / 8 已安装`，而不是继续显示模糊的 `Add all`。

### Skills 表格

- Name 列固定在左侧，Description 提供最大宽度。
- Type 使用文字标签；Agents 使用可点击文本或 Chip。
- Author、Updated 在窄屏下可折叠到详情抽屉。
- 截断内容必须能通过聚焦、悬停或详情视图完整读取。

## 交互与状态

- 搜索支持名称、描述、类型、作者和 Agent。
- 排序至少覆盖名称、更新时间和作者。
- 点击技能打开详情抽屉，不跳离当前列表位置。
- 悬停或聚焦 Agent 时，同时高亮 Sidebar 中的对应 Agent。
- 批量安装提供进行中、成功、部分失败和可重试状态。
- 空状态应说明如何创建、导入或浏览技能，而不是只显示“暂无数据”。

## 生产环境必须补齐的安全内容

`Create skill` 和 `Add all` 可能引入指令、脚本或工具权限，不能按普通素材安装处理。安装审查层至少展示：

- 来源、作者、版本和校验信息。
- 将写入的目录和文件。
- 是否包含脚本、可执行文件或外部依赖。
- 请求访问的工具、目录和网络能力。
- 与已安装技能的覆盖、升级和冲突情况。
- 可回滚方案。

## 在 AI Coding Canvas 中的使用方式

- 作为工作空间级 `Skills` 主视图，而不是 React Flow 节点内部的小面板。
- Skills 主区域应跨越当前 Canvas 与 Inspector 两列，确保表格宽度。
- 继续复用当前面板、边框、文字和信息色 Token，不全局替换品牌色。
- 文件系统中的 Skill 内容与 SQLite 中的安装、版本和 Agent 绑定记录要有清晰的真值边界。
- 点击某个 Agent 绑定后，可以切回 Canvas 并聚焦对应 Agent 节点，形成管理页面与执行现场的连接。

## 采用检查清单

- [ ] 页面同时覆盖发现、安装、检索和 Agent 绑定。
- [ ] 批量安装前有明确的安全审查和影响说明。
- [ ] 1024px 宽度下仍可完成核心任务。
- [ ] 表格支持键盘浏览、可见焦点和完整文本读取。
- [ ] 类型和状态不只依靠颜色表达。
- [ ] 加载、空、失败、冲突和更新状态均有设计。
- [ ] 与 Canvas 中的真实 Agent 节点能够互相定位。

