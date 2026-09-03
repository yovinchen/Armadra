import {
  Bell,
  Bot,
  Database,
  Gauge,
  Info,
  Keyboard,
  Presentation,
  Server,
  SlidersHorizontal,
  SquareTerminal,
  Webhook,
  LayoutGrid,
  type LucideIcon,
} from "lucide-react";

/**
 * 设置页的分区注册表（计划书 §24.1）。
 *
 * ChatGPT 式：左栏一列导航，右栏是**当前分区独立的一页**，切换时整页替换。
 * 这张表决定导航顺序、分组切分与页面标题；加一页只要在这里加一行，
 * 再在 `SettingsDialog` 的 `SECTION_PAGES` 里挂上组件。
 *
 * 分组由**相邻同 `groupKey` 的行**切出来，所以行的顺序就是视觉顺序：
 * 通用 / AI / 连接 / 高级。
 */
export interface SettingsSection {
  /** 存进偏好、也是 `SECTION_PAGES` 的键。 */
  id: string;
  /** 导航里的分组标题（i18n 键）。 */
  groupKey: string;
  /** 分区标题（i18n 键），同时是右栏页头。 */
  labelKey: string;
  /** 导航项左侧的 16px 线性图标（§24.2「源列表侧栏」）。 */
  icon: LucideIcon;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "general",
    groupKey: "settings.group.general",
    labelKey: "settings.section.general",
    icon: SlidersHorizontal,
  },
  {
    id: "notifications",
    groupKey: "settings.group.general",
    labelKey: "settings.section.notifications",
    icon: Bell,
  },
  {
    // 白板是外观类配置，跟主题/语言同属「通用」（2026-09-04 用户反馈）。
    id: "whiteboard",
    groupKey: "settings.group.general",
    labelKey: "settings.section.whiteboard",
    icon: Presentation,
  },
  {
    id: "agent",
    groupKey: "settings.group.ai",
    labelKey: "settings.section.agent",
    icon: Bot,
  },
  {
    id: "hooks",
    groupKey: "settings.group.ai",
    labelKey: "settings.section.hooks",
    icon: Webhook,
  },
  {
    id: "terminal",
    groupKey: "settings.group.connection",
    labelKey: "settings.section.terminal",
    icon: SquareTerminal,
  },
  {
    id: "workspace",
    groupKey: "settings.group.connection",
    labelKey: "settings.section.workspace",
    icon: LayoutGrid,
  },
  {
    id: "ssh",
    groupKey: "settings.group.connection",
    labelKey: "ssh.nav",
    icon: Server,
  },
  {
    id: "data",
    groupKey: "settings.group.advanced",
    labelKey: "settings.section.data",
    icon: Database,
  },
  {
    id: "account",
    groupKey: "settings.group.advanced",
    labelKey: "settings.section.account",
    icon: Gauge,
  },
  {
    id: "keybindings",
    groupKey: "settings.group.advanced",
    labelKey: "settings.section.keybindings",
    icon: Keyboard,
  },
  {
    id: "about",
    groupKey: "settings.group.advanced",
    labelKey: "settings.section.about",
    icon: Info,
  },
];

export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0]!.id;

export function isSettingsSectionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SETTINGS_SECTIONS.some((section) => section.id === value)
  );
}

export function settingsSection(id: string): SettingsSection {
  return (
    SETTINGS_SECTIONS.find((section) => section.id === id) ??
    SETTINGS_SECTIONS[0]!
  );
}

export interface SettingsNavGroup {
  groupKey: string;
  sections: SettingsSection[];
}

/** 按注册顺序切成连续的分组段——顺序即导航里的顺序。 */
export function groupSections(
  sections: readonly SettingsSection[] = SETTINGS_SECTIONS,
): SettingsNavGroup[] {
  const groups: SettingsNavGroup[] = [];
  for (const section of sections) {
    const last = groups[groups.length - 1];
    if (last && last.groupKey === section.groupKey) last.sections.push(section);
    else groups.push({ groupKey: section.groupKey, sections: [section] });
  }
  return groups;
}
