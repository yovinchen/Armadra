# UI 风格参考索引

本目录保存外部 UI 参考的结构化分析，用于设计讨论、页面选型和实现前对比。这里的文档是研究材料，不会自动覆盖 `docs/interface-design.md` 或当前实施契约。

## 风格筛选矩阵

| 参考 | 信息密度 | 视觉强度 | 主要模式 | 最适合 | 采用建议 |
| --- | --- | --- | --- | --- | --- |
| [Skills 资产管理工作台](./skills-asset-management.md) | 高 | 低 | Sidebar + 技能包 + 表格 | Skills、MCP、Agent、Integrations | 推荐采用结构和组件语言 |
| [Analytics 高密度运营仪表盘](./analytics-operations-dashboard.md) | 高 | 中低 | Filters + KPI + Charts | Usage、Runtime、Cost、Observability | 推荐采用指标层级和网格 |
| [Glass Sidebar 玻璃侧栏仪表盘](./glass-sidebar-dashboard.md) | 中 | 高 | Backdrop + Glass Sidebar + Opaque Content | Launcher、Workspace Rail、欢迎页 | 仅选择性采用材质层次 |

## 按页面类型选择

```text
需要管理大量实体、绑定关系或安装状态？
└── 选择 Skills 资产管理工作台

需要回答“发生了什么、为什么、下一步去哪”？
└── 选择 Analytics 高密度运营仪表盘

需要加强启动页或工作空间入口的品牌氛围？
└── 选择 Glass Sidebar，但只用于一个主要区域

需要编辑代码、查看终端或操作无限画布？
└── 保持当前不透明工作台，不直接套用上述页面结构
```

## 当前项目的推荐组合

```text
结构基线：当前 Armadra Shell
    ├── Skills / MCP / Agent 管理：Skills 资产管理风格
    ├── Usage / Runtime / Cost：Analytics 仪表盘风格
    └── Workspace Rail / Launcher：轻度 Glass Sidebar 风格
```

组合时遵循：

- 克制的信息设计是主体，玻璃效果只作为一个视觉签名。
- 表格、终端、代码、图表和长文本区域保持不透明。
- 所有指标和管理操作必须能回到真实 Canvas、Agent、Skill 或 Diff 上下文。
- 状态同时使用图标、文字和颜色，不依靠颜色单独表达。
- 外部参考中的财务、销售和虚构业务数据必须替换为当前产品的真实内容。

## 元数据字段

每份风格文档都使用统一 YAML Front Matter，便于脚本或全文搜索筛选：

| 字段 | 含义 |
| --- | --- |
| `reference_id` | 稳定风格标识 |
| `visual_mode` | 浅色、暗色或双主题 |
| `density` | 信息密度 |
| `layout_patterns` | 主要布局模式 |
| `recommended_surfaces` | 推荐使用的产品页面 |
| `adoption` | `recommended` 或 `selective` |

示例：

```sh
rg -l "adoption: recommended" docs/research/ui-style-references
rg -l "  - skills" docs/research/ui-style-references
rg -l "density: high" docs/research/ui-style-references
```

## 从参考进入实施的流程

1. 根据页面任务从本索引选择一个主参考。
2. 从其他参考最多吸收一个辅助特征，避免拼贴感。
3. 使用文档中的采用检查清单完成自评。
4. 将确认后的 Token、组件和交互规则写入正式设计基线。
5. 再进入组件实现、真实数据接入和交互验证。

