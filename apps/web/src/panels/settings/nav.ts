import {
  Bell,
  Bot,
  Cpu,
  Database,
  Gauge,
  Info,
  Keyboard,
  Presentation,
  RefreshCw,
  Server,
  ServerCog,
  SlidersHorizontal,
  SquareTerminal,
  GitPullRequest,
  Globe,
  Webhook,
  LayoutGrid,
  Users,
  type LucideIcon,
} from "lucide-react";

import { RUNTIME_VIA_SERVER_SHELL } from "@/api/request";
import { isDesktop } from "@/platform";

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
  /**
   * 只在桌面壳里出现。
   *
   * 这一页上的每一项都只对壳里的 `<webview>` 有意义；浏览器标签页里既建不
   * 出浏览器节点，也就没有可配的东西，列一页永远无效的设置比不列更糟。
   */
  desktopOnly?: boolean;
  /**
   * 只在服务器壳托管的页面上出现。
   *
   * 账号与共享只对「一台服务器、好几个人」有意义；桌面单机只有一个 owner，
   * 列一页没有人可管的设置比不列更糟。
   */
  serverOnly?: boolean;
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
    // 接入归一之后只有一页：注入方式、Hook、技能、旧残留都在同一行里
    // （Agent 接入归一 §2「一处管理」）。
    id: "integration",
    groupKey: "settings.group.ai",
    labelKey: "integration.nav",
    icon: Webhook,
  },
  {
    id: "terminal",
    groupKey: "settings.group.connection",
    labelKey: "settings.section.terminal",
    icon: SquareTerminal,
  },
  {
    // 浏览器节点的内存配置；和终端一样，说的是「这台机器怎么跑它」。
    id: "browser",
    groupKey: "settings.group.connection",
    labelKey: "settings.section.browser",
    icon: Globe,
    desktopOnly: true,
  },
  {
    id: "workspace",
    groupKey: "settings.group.connection",
    labelKey: "settings.section.workspace",
    icon: LayoutGrid,
  },
  {
    id: "host",
    groupKey: "settings.group.connection",
    labelKey: "host.nav",
    icon: ServerCog,
  },
  {
    id: "accounts",
    groupKey: "settings.group.connection",
    labelKey: "sharing.nav",
    icon: Users,
    serverOnly: true,
  },
  {
    id: "github",
    groupKey: "settings.group.connection",
    labelKey: "github.nav",
    icon: GitPullRequest,
  },
  {
    id: "ssh",
    groupKey: "settings.group.connection",
    labelKey: "ssh.nav",
    icon: Server,
  },
  {
    // SSH 那一页编辑的是「怎么连」；这一页回答「有哪些机器、现在能不能用、
    // 当前工作区跑在哪一台」——两件不同的事，所以是两页。
    id: "executionHosts",
    groupKey: "settings.group.connection",
    labelKey: "executionHosts.nav",
    icon: Cpu,
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
    // 更新是「有没有新版本」，跟数据、账户一样属于高级设置（S03 / §3.12）。
    id: "updates",
    groupKey: "settings.group.advanced",
    labelKey: "updates.nav",
    icon: RefreshCw,
  },
  {
    id: "about",
    groupKey: "settings.group.advanced",
    labelKey: "settings.section.about",
    icon: Info,
  },
];

export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0]!.id;

/** 这台机器上真正能进的分区。壳不在时少几行，而不是几行点不动的。 */
export function visibleSettingsSections(
  server: boolean = RUNTIME_VIA_SERVER_SHELL,
): SettingsSection[] {
  const desktop = isDesktop();
  return SETTINGS_SECTIONS.filter(
    (section) =>
      (desktop || !section.desktopOnly) && (server || !section.serverOnly),
  );
}

export function isSettingsSectionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    visibleSettingsSections().some((section) => section.id === value)
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
  sections: readonly SettingsSection[] = visibleSettingsSections(),
): SettingsNavGroup[] {
  const groups: SettingsNavGroup[] = [];
  for (const section of sections) {
    const last = groups[groups.length - 1];
    if (last && last.groupKey === section.groupKey) last.sections.push(section);
    else groups.push({ groupKey: section.groupKey, sections: [section] });
  }
  return groups;
}
