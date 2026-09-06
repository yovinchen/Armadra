import { useMemo } from "react";
import { create } from "zustand";
import {
  DEFAULT_CONTEXT_THRESHOLDS,
  normalizeContextThresholds,
  PERMISSION_MODES,
  type ContextThresholds,
  type PermissionMode,
} from "@armadra/shared";
import {
  DEFAULT_LOCALE,
  LOCALES,
  translate,
  type Locale,
  type TranslateValues,
} from "../i18n";
import {
  clampRenderBudget,
  DEFAULT_RENDER_BUDGET,
  RENDER_BUDGET_RANGE,
  setRenderBudget as applyRenderBudget,
} from "../terminal/render-budget";
import {
  readStored,
  storedBoolean,
  storedEnum,
  storedIds,
  storedNumber,
  storedRecord,
  writeStored,
} from "./preferences/storage";
import {
  storedTerminalPreferences,
  TERMINAL_KEYS,
  type TerminalPreferences,
} from "./preferences/terminal";
import {
  storedWhiteboardPreferences,
  WHITEBOARD_KEYS,
  type WhiteboardPreferences,
} from "./preferences/whiteboard";

export * from "./preferences/terminal";
export * from "./preferences/whiteboard";

/**
 * 应用级偏好（主题 / 语言 / 已打开的工作空间）。
 *
 * 旧的 `preferences/Preferences.tsx` Context 被这个 zustand store 取代：
 * 快捷键处理器、TabBar 菜单这类非组件代码也要读写它，Context 拿不到。
 * 所有值都镜像进 localStorage，启动时同步读回（没有异步窗口期，
 * 避免主题闪一下）。
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "dark",
  "light",
  "system",
];

const THEME_KEY = "armadra.theme";
const LOCALE_KEY = "armadra.locale";
const OPEN_WORKSPACES_KEY = "armadra.openWorkspaces";
/** 侧栏「项目」组里收起来的工作空间（§26；默认展开，所以存的是收起的那些）。 */
const COLLAPSED_WORKSPACES_KEY = "armadra.collapsedWorkspaces";
/** 侧栏「置顶」组里的画布 id（§26）。 */
const PINNED_BOARDS_KEY = "armadra.pinnedBoards";
const PINNED_WORKSPACES_KEY = "armadra.pinnedWorkspaces";
const DISABLED_AGENTS_KEY = "armadra.disabledAgents";
/** 每个 Agent 的三态（默认 / 启用 / 禁用），§24.1 Agent 页。 */
const AGENT_MODES_KEY = "armadra.agentModes";
/** 内置 Agent 的自定义启动命令：`agentId → 程序路径`（§24.1 Agent 页）。 */
const LAUNCH_OVERRIDES_KEY = "armadra.launchOverrides";
const DEFAULT_AGENT_KEY = "armadra.defaultAgent";
const PERMISSION_KEY = "armadra.permissionMode";
/** v3 之前只有一个总开关；两个新键缺省时从它迁移。 */
const NOTIFICATIONS_KEY = "armadra.notifications";
const NOTIFY_DONE_KEY = "armadra.notifyDone";
const NOTIFY_NEEDS_YOU_KEY = "armadra.notifyNeedsYou";
const SIDEBAR_OPEN_KEY = "armadra.sidebarOpen";
const SOUND_KEY = "armadra.sound";
const SOUND_VOLUME_KEY = "armadra.soundVolume";
/** 打开时恢复上次的工作空间（§24.1 通用页）。 */
const RESTORE_WORKSPACE_KEY = "armadra.restoreLastWorkspace";
/** 右下角用量胶囊（§19）。默认开；关掉后连轮询都不发。 */
const SHOW_USAGE_KEY = "armadra.showUsage";
/** 开屏动画（§24.1 通用页）。默认开；关掉后每次打开都直接进壳。 */
const SPLASH_KEY = "armadra.splashAnimation";
/**
 * 单会话上下文的提醒阈值（Agent 自动化设计 §2.2「80%/95% 为初始提醒阈值，
 * 可设置」）。只改徽标与 Popover 的措辞，不会自动压缩、清空或打断 CLI。
 */
const CONTEXT_WARN_KEY = "armadra.context.warnPercent";
const CONTEXT_DANGER_KEY = "armadra.context.dangerPercent";
/**
 * 会话内存徽标变色的阈值（路线图 §4.3「默认 2 GB，可设」）。
 *
 * 只改颜色和提醒一次，不会终止、不会休眠、也不会替用户做任何处置——面板
 * 里的「结束会话」始终是用户自己点的。
 */
const SESSION_MEMORY_WARN_KEY = "armadra.resources.sessionMemoryWarnBytes";
/**
 * 同时全速渲染的终端数量（终端宿主设计 §7.1）。
 *
 * 是设备属性而不是账号偏好——WebGL 上下文的数量由这台机器的浏览器和显卡说了
 * 算，所以和终端外观一样只存本地。
 */
const RENDER_BUDGET_KEY = "armadra.terminal.renderBudget";
/** 终端 / Agent 节点的自动命名（Agent 自动化设计 §8）。默认开。 */
const AUTO_TITLE_KEY = "armadra.autoTitle";
/** 节点颜色的表达方式（§24.3-3）：色点 + 1px 顶描边，或旧的 3px 色条。 */
const NODE_COLOR_STYLE_KEY = "armadra.nodeColorStyle";
/** 终端外观（§18.3 最后一行「设置项」）。全部只存本地，Runtime 不关心。 */
/** 白板配置。全部只存本地，Runtime 不关心。 */
/** 设置页上次停在的分区（§24.1）；⌘, 直接回到那一页。 */
const LAST_SETTINGS_SECTION_KEY = "armadra.settingsSection";
/** 上次打开的工作空间 / 画布；启动时用来跳过启动页。 */
export const LAST_WORKSPACE_KEY = "armadra.workspace";
export const LAST_BOARD_KEY = "armadra.board";

export const NODE_COLOR_STYLES = ["dot", "bar"] as const;
export type NodeColorStyle = (typeof NODE_COLOR_STYLES)[number];

export function systemColorScheme(): ResolvedTheme {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/* ------------------------------- 终端外观 --------------------------------- */

/* --------------------------------- 白板 ----------------------------------- */
/* --------------------------------- Agent 三态 ------------------------------ */

/**
 * 设置 → Agent 里每个 CLI 的三态（§24.1）。
 *
 * `default` 跟随本机检测：装了就出现在新建菜单里。`enabled` 是「我知道它在，
 * 只是没在 PATH 上」——配合「自定义启动命令」把没检测到的 CLI 也留在菜单里。
 * `disabled` 永远不出现。
 */
export const AGENT_MODES = ["default", "enabled", "disabled"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export function agentIsEnabled(
  mode: AgentMode | undefined,
  installed: boolean,
): boolean {
  if (mode === "disabled") return false;
  if (mode === "enabled") return true;
  return installed;
}

/** v2 只存「关掉了哪些」；第一次读到时把它翻成三态。 */
function storedAgentModes(): Record<string, AgentMode> {
  const raw = readStored(AGENT_MODES_KEY);
  if (raw !== null) {
    const parsed = storedRecord(AGENT_MODES_KEY);
    const modes: Record<string, AgentMode> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if ((AGENT_MODES as readonly string[]).includes(value)) {
        modes[id] = value as AgentMode;
      }
    }
    return modes;
  }
  const modes: Record<string, AgentMode> = {};
  for (const id of storedIds(DISABLED_AGENTS_KEY)) modes[id] = "disabled";
  return modes;
}

export const SOUND_VOLUME_RANGE = [0, 100] as const;

/**
 * 会话内存徽标的默认阈值：2 GiB（路线图 §4.3）。
 *
 * 这是一个「值得看一眼」的线，不是「出问题了」的线——一个跑着构建的 Agent
 * 越过它完全正常。所以越过之后只有变色和一条提醒，没有任何自动处置。
 */
export const DEFAULT_SESSION_MEMORY_WARN_BYTES = 2 * 1024 * 1024 * 1024;
/** 128 MiB – 128 GiB。低于下限的阈值会让每个 shell 都在报警。 */
export const SESSION_MEMORY_WARN_RANGE = [
  128 * 1024 * 1024,
  128 * 1024 * 1024 * 1024,
] as const;

export interface PreferencesState {
  theme: ThemePreference;
  locale: Locale;
  systemTheme: ResolvedTheme;
  /** 侧栏工作空间树里的行，顺序即打开顺序（§22 第一栏）。 */
  openWorkspaceIds: string[];
  /** 「项目」组里收起来的工作空间 id（§26）。默认全部展开。 */
  collapsedWorkspaceIds: string[];
  /** 「置顶」组里的画布 id，顺序即置顶顺序（§26）。 */
  pinnedBoardIds: string[];
  /** 置顶的项目（工作空间）id：在「项目」组里排到最前面。 */
  pinnedWorkspaceIds: string[];
  /**
   * 每个 Agent 的三态（§24.1）。没有条目就是 `default`。
   * Runtime 侧还没有对应的持久化端点，先存在本地。
   */
  agentModes: Record<string, AgentMode>;
  /** 内置 Agent 的自定义启动程序；空串 / 缺席 = 用注册表里的。 */
  launchOverrides: Record<string, string>;
  /** 新建 Agent 节点时的默认 CLI；`null` = 用列表里第一个可用的。 */
  defaultAgentId: string | null;
  defaultPermissionMode: PermissionMode;
  /** 后台完成时发系统通知（§5.4）。 */
  notifyDone: boolean;
  /** 需要你（等授权 / 等回答）时发系统通知。 */
  notifyNeedsYou: boolean;
  /** 同一时刻的提示音（每节点 5s 节流）。 */
  sound: boolean;
  /** 提示音音量，0–100；WebAudio 的 gain 直接乘它。 */
  soundVolume: number;
  /** 右下角用量胶囊（§19）。 */
  showUsage: boolean;
  /** 打开时播放开屏动画（§24.1 通用页）。 */
  splashAnimation: boolean;
  /** 上下文提醒阈值（设计 §2.2）；`dangerPercent` 不会低于 `warnPercent`。 */
  contextThresholds: ContextThresholds;
  /** 会话内存徽标的变色阈值，字节（路线图 §4.3）。默认 2 GiB。 */
  sessionMemoryWarnBytes: number;
  /** 同时全速渲染的终端数量（终端宿主设计 §7.1）。默认 4。 */
  renderBudget: number;
  /** 占位标题的自动命名（设计 §8）；人工改过名的节点始终不受影响。 */
  autoTitle: boolean;
  /** 节点颜色风格（§24.3-3）：`dot` 色点 + 顶描边 / `bar` 顶部色条。 */
  nodeColorStyle: NodeColorStyle;
  /** 左侧 docked 侧栏是否展开（§20「左侧栏」，⌘⇧L）。 */
  sidebarOpen: boolean;
  /** 打开时恢复上次的工作空间（§24.1 通用页）；关掉就停在启动页。 */
  restoreLastWorkspace: boolean;
  /** 设置页上次停在的分区 id（§24.1）；`null` = 还没打开过。 */
  lastSettingsSection: string | null;
  /**
   * 右栏里推进去的子页（`ssh:new` / `ssh:<id>` / `agent:new` / `agent:<id>`）。
   * 不落 localStorage：关掉设置就该回到分区页，而不是重开时停在一张表单上。
   */
  settingsSubpage: string | null;
  terminal: TerminalPreferences;
  /** 白板配置；`use-canvas-preferences.ts` 与 `flow-options.ts` 负责消费。 */
  whiteboard: WhiteboardPreferences;
  setTheme: (theme: ThemePreference) => void;
  setLocale: (locale: Locale) => void;
  setSystemTheme: (theme: ResolvedTheme) => void;
  openWorkspaceTab: (workspaceId: string) => void;
  closeWorkspaceTab: (workspaceId: string) => void;
  setWorkspaceCollapsed: (workspaceId: string, collapsed: boolean) => void;
  setBoardPinned: (boardId: string, pinned: boolean) => void;
  setWorkspacePinned: (workspaceId: string, pinned: boolean) => void;
  setAgentMode: (agentId: string, mode: AgentMode) => void;
  setLaunchOverride: (agentId: string, program: string) => void;
  setDefaultAgentId: (agentId: string | null) => void;
  setDefaultPermissionMode: (mode: PermissionMode) => void;
  setNotifyDone: (enabled: boolean) => void;
  setNotifyNeedsYou: (enabled: boolean) => void;
  setSound: (enabled: boolean) => void;
  setSoundVolume: (volume: number) => void;
  setShowUsage: (enabled: boolean) => void;
  setSplashAnimation: (enabled: boolean) => void;
  setContextThresholds: (thresholds: Partial<ContextThresholds>) => void;
  setSessionMemoryWarnBytes: (bytes: number) => void;
  setRenderBudget: (limit: number) => void;
  setAutoTitle: (enabled: boolean) => void;
  setNodeColorStyle: (style: NodeColorStyle) => void;
  setSidebarOpen: (open: boolean) => void;
  setRestoreLastWorkspace: (restore: boolean) => void;
  setLastSettingsSection: (sectionId: string) => void;
  setSettingsSubpage: (subpage: string | null) => void;
  setTerminalPreference: <K extends keyof TerminalPreferences>(
    key: K,
    value: TerminalPreferences[K],
  ) => void;
  setWhiteboardPreference: <K extends keyof WhiteboardPreferences>(
    key: K,
    value: WhiteboardPreferences[K],
  ) => void;
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  theme: storedEnum(THEME_KEY, THEME_PREFERENCES, "system"),
  locale: storedEnum(LOCALE_KEY, LOCALES, DEFAULT_LOCALE),
  systemTheme: systemColorScheme(),
  openWorkspaceIds: storedIds(OPEN_WORKSPACES_KEY),
  collapsedWorkspaceIds: storedIds(COLLAPSED_WORKSPACES_KEY),
  pinnedBoardIds: storedIds(PINNED_BOARDS_KEY),
  pinnedWorkspaceIds: storedIds(PINNED_WORKSPACES_KEY),
  agentModes: storedAgentModes(),
  launchOverrides: storedRecord(LAUNCH_OVERRIDES_KEY),
  defaultAgentId: readStored(DEFAULT_AGENT_KEY),
  defaultPermissionMode: storedEnum(
    PERMISSION_KEY,
    PERMISSION_MODES,
    "default",
  ),
  notifyDone: storedBoolean(
    NOTIFY_DONE_KEY,
    storedBoolean(NOTIFICATIONS_KEY, true),
  ),
  notifyNeedsYou: storedBoolean(
    NOTIFY_NEEDS_YOU_KEY,
    storedBoolean(NOTIFICATIONS_KEY, true),
  ),
  sound: storedBoolean(SOUND_KEY, true),
  soundVolume: storedNumber(SOUND_VOLUME_KEY, 60, ...SOUND_VOLUME_RANGE),
  showUsage: storedBoolean(SHOW_USAGE_KEY, true),
  splashAnimation: storedBoolean(SPLASH_KEY, true),
  contextThresholds: normalizeContextThresholds({
    warnPercent: storedNumber(
      CONTEXT_WARN_KEY,
      DEFAULT_CONTEXT_THRESHOLDS.warnPercent,
      1,
      100,
    ),
    dangerPercent: storedNumber(
      CONTEXT_DANGER_KEY,
      DEFAULT_CONTEXT_THRESHOLDS.dangerPercent,
      1,
      100,
    ),
  }),
  sessionMemoryWarnBytes: storedNumber(
    SESSION_MEMORY_WARN_KEY,
    DEFAULT_SESSION_MEMORY_WARN_BYTES,
    SESSION_MEMORY_WARN_RANGE[0],
    SESSION_MEMORY_WARN_RANGE[1],
  ),
  renderBudget: clampRenderBudget(
    storedNumber(
      RENDER_BUDGET_KEY,
      DEFAULT_RENDER_BUDGET,
      RENDER_BUDGET_RANGE[0],
      RENDER_BUDGET_RANGE[1],
    ),
  ),
  autoTitle: storedBoolean(AUTO_TITLE_KEY, true),
  nodeColorStyle: storedEnum(NODE_COLOR_STYLE_KEY, NODE_COLOR_STYLES, "dot"),
  sidebarOpen: storedBoolean(SIDEBAR_OPEN_KEY, true),
  restoreLastWorkspace: storedBoolean(RESTORE_WORKSPACE_KEY, true),
  lastSettingsSection: readStored(LAST_SETTINGS_SECTION_KEY),
  settingsSubpage: null,
  terminal: storedTerminalPreferences(),
  whiteboard: storedWhiteboardPreferences(),

  setTheme(theme) {
    writeStored(THEME_KEY, theme);
    set({ theme });
  },
  setLocale(locale) {
    writeStored(LOCALE_KEY, locale);
    set({ locale });
  },
  setSystemTheme(systemTheme) {
    set({ systemTheme });
  },
  openWorkspaceTab(workspaceId) {
    set((state) => {
      if (state.openWorkspaceIds.includes(workspaceId)) return state;
      const openWorkspaceIds = [...state.openWorkspaceIds, workspaceId];
      writeStored(OPEN_WORKSPACES_KEY, JSON.stringify(openWorkspaceIds));
      return { openWorkspaceIds };
    });
  },
  closeWorkspaceTab(workspaceId) {
    set((state) => {
      const openWorkspaceIds = state.openWorkspaceIds.filter(
        (id) => id !== workspaceId,
      );
      if (openWorkspaceIds.length === state.openWorkspaceIds.length) {
        return state;
      }
      writeStored(OPEN_WORKSPACES_KEY, JSON.stringify(openWorkspaceIds));
      return { openWorkspaceIds };
    });
  },
  setWorkspaceCollapsed(workspaceId, collapsed) {
    set((state) => {
      const has = state.collapsedWorkspaceIds.includes(workspaceId);
      if (has === collapsed) return state;
      const collapsedWorkspaceIds = collapsed
        ? [...state.collapsedWorkspaceIds, workspaceId]
        : state.collapsedWorkspaceIds.filter((id) => id !== workspaceId);
      writeStored(
        COLLAPSED_WORKSPACES_KEY,
        JSON.stringify(collapsedWorkspaceIds),
      );
      return { collapsedWorkspaceIds };
    });
  },
  setWorkspacePinned(workspaceId, pinned) {
    set((state) => {
      const has = state.pinnedWorkspaceIds.includes(workspaceId);
      if (has === pinned) return state;
      const pinnedWorkspaceIds = pinned
        ? [...state.pinnedWorkspaceIds, workspaceId]
        : state.pinnedWorkspaceIds.filter((id) => id !== workspaceId);
      writeStored(PINNED_WORKSPACES_KEY, JSON.stringify(pinnedWorkspaceIds));
      return { pinnedWorkspaceIds };
    });
  },
  setBoardPinned(boardId, pinned) {
    set((state) => {
      const has = state.pinnedBoardIds.includes(boardId);
      if (has === pinned) return state;
      // 新置顶的排在最后：置顶组的顺序就是用户按下的顺序，不重排。
      const pinnedBoardIds = pinned
        ? [...state.pinnedBoardIds, boardId]
        : state.pinnedBoardIds.filter((id) => id !== boardId);
      writeStored(PINNED_BOARDS_KEY, JSON.stringify(pinnedBoardIds));
      return { pinnedBoardIds };
    });
  },
  setAgentMode(agentId, mode) {
    set((state) => {
      // `default` 不落键：这样将来改默认策略时老配置会跟着走。
      const agentModes = { ...state.agentModes };
      if (mode === "default") delete agentModes[agentId];
      else agentModes[agentId] = mode;
      writeStored(AGENT_MODES_KEY, JSON.stringify(agentModes));
      return { agentModes };
    });
  },
  setLaunchOverride(agentId, program) {
    set((state) => {
      const launchOverrides = { ...state.launchOverrides };
      const trimmed = program.trim();
      if (trimmed === "") delete launchOverrides[agentId];
      else launchOverrides[agentId] = trimmed;
      writeStored(LAUNCH_OVERRIDES_KEY, JSON.stringify(launchOverrides));
      return { launchOverrides };
    });
  },
  setDefaultAgentId(defaultAgentId) {
    if (defaultAgentId) writeStored(DEFAULT_AGENT_KEY, defaultAgentId);
    set({ defaultAgentId });
  },
  setDefaultPermissionMode(defaultPermissionMode) {
    writeStored(PERMISSION_KEY, defaultPermissionMode);
    set({ defaultPermissionMode });
  },
  setNotifyDone(notifyDone) {
    writeStored(NOTIFY_DONE_KEY, String(notifyDone));
    set({ notifyDone });
  },
  setNotifyNeedsYou(notifyNeedsYou) {
    writeStored(NOTIFY_NEEDS_YOU_KEY, String(notifyNeedsYou));
    set({ notifyNeedsYou });
  },
  setSound(sound) {
    writeStored(SOUND_KEY, String(sound));
    set({ sound });
  },
  setSoundVolume(volume) {
    const soundVolume = Math.min(
      SOUND_VOLUME_RANGE[1],
      Math.max(SOUND_VOLUME_RANGE[0], Math.round(volume)),
    );
    writeStored(SOUND_VOLUME_KEY, String(soundVolume));
    set({ soundVolume });
  },
  setShowUsage(showUsage) {
    writeStored(SHOW_USAGE_KEY, String(showUsage));
    set({ showUsage });
  },
  setSplashAnimation(splashAnimation) {
    writeStored(SPLASH_KEY, String(splashAnimation));
    set({ splashAnimation });
  },
  setContextThresholds(patch) {
    set((state) => {
      // Normalising on write is what keeps "danger below warn" from ever
      // reaching storage: the badge must not have to defend against it.
      const contextThresholds = normalizeContextThresholds({
        ...state.contextThresholds,
        ...patch,
      });
      writeStored(CONTEXT_WARN_KEY, String(contextThresholds.warnPercent));
      writeStored(CONTEXT_DANGER_KEY, String(contextThresholds.dangerPercent));
      return { contextThresholds };
    });
  },
  setSessionMemoryWarnBytes(bytes) {
    const sessionMemoryWarnBytes = Math.min(
      SESSION_MEMORY_WARN_RANGE[1],
      Math.max(SESSION_MEMORY_WARN_RANGE[0], Math.round(bytes)),
    );
    writeStored(SESSION_MEMORY_WARN_KEY, String(sessionMemoryWarnBytes));
    set({ sessionMemoryWarnBytes });
  },
  setRenderBudget(limit) {
    const renderBudget = clampRenderBudget(limit);
    writeStored(RENDER_BUDGET_KEY, String(renderBudget));
    set({ renderBudget });
  },
  setAutoTitle(autoTitle) {
    writeStored(AUTO_TITLE_KEY, String(autoTitle));
    set({ autoTitle });
  },
  setNodeColorStyle(nodeColorStyle) {
    writeStored(NODE_COLOR_STYLE_KEY, nodeColorStyle);
    set({ nodeColorStyle });
  },
  setSidebarOpen(sidebarOpen) {
    writeStored(SIDEBAR_OPEN_KEY, String(sidebarOpen));
    set({ sidebarOpen });
  },
  setRestoreLastWorkspace(restoreLastWorkspace) {
    writeStored(RESTORE_WORKSPACE_KEY, String(restoreLastWorkspace));
    set({ restoreLastWorkspace });
  },
  setLastSettingsSection(lastSettingsSection) {
    writeStored(LAST_SETTINGS_SECTION_KEY, lastSettingsSection);
    // 换分区一定退出子页：子页属于它上面那一页。
    set({ lastSettingsSection, settingsSubpage: null });
  },
  setSettingsSubpage(settingsSubpage) {
    set({ settingsSubpage });
  },
  setTerminalPreference(key, value) {
    writeStored(TERMINAL_KEYS[key], String(value));
    set((state) => ({ terminal: { ...state.terminal, [key]: value } }));
  },
  setWhiteboardPreference(key, value) {
    // 值没变就整块不动：偏好菜单与设置页可能连着写同一个值，
    // 换一个新的 `whiteboard` 对象会让所有订阅者白重渲染一遍。
    if (get().whiteboard[key] === value) return;
    writeStored(WHITEBOARD_KEYS[key], String(value));
    set((state) => ({ whiteboard: { ...state.whiteboard, [key]: value } }));
  },
}));

/** 组件里用；只有终端外观那一块变化才重渲染。 */
export function useTerminalPreferences(): TerminalPreferences {
  return usePreferencesStore((state) => state.terminal);
}

/** 同上，白板那一块。 */
export function useWhiteboardPreferences(): WhiteboardPreferences {
  return usePreferencesStore((state) => state.whiteboard);
}

export function resolveTheme(state: PreferencesState): ResolvedTheme {
  return state.theme === "system" ? state.systemTheme : state.theme;
}

export function useResolvedTheme(): ResolvedTheme {
  return usePreferencesStore(resolveTheme);
}

/**
 * 把主题与语言写到 `<html>` 上，并跟随系统主题变化。
 * App 挂一次；`sonner` 与 tokens.css 都盯着 `data-theme`。
 *
 * 渲染名额也在这里推给登记处（终端宿主设计 §7.1）：那是个模块级的单例，
 * 没有 React 状态，只能由这条「偏好 → 世界」的通路把当前值送过去。
 */
export function syncDocumentPreferences(): () => void {
  const apply = () => {
    const state = usePreferencesStore.getState();
    const resolved = resolveTheme(state);
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
    root.lang = state.locale;
    applyRenderBudget(state.renderBudget);
  };
  apply();
  const unsubscribe = usePreferencesStore.subscribe(apply);

  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return unsubscribe;
  }
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () =>
    usePreferencesStore
      .getState()
      .setSystemTheme(media.matches ? "dark" : "light");
  media.addEventListener("change", onChange);
  return () => {
    media.removeEventListener("change", onChange);
    unsubscribe();
  };
}

/* ------------------------------------ i18n -------------------------------- */

export type Translate = (key: string, values?: TranslateValues) => string;

/**
 * 组件里用：语言变化会触发重渲染。
 *
 * 返回值按 locale 记忆化——菜单/命令面板会把 `t` 放进 `useMemo` 的依赖里，
 * 每次渲染都换一个新函数会让那些 memo 白做，而按 locale 记忆化既保证
 * 「切语言立刻重算」，又不会每帧失效。
 */
export function useT(): Translate {
  const locale = usePreferencesStore((state) => state.locale);
  return useMemo<Translate>(
    () => (key, values) => translate(locale, key, values),
    [locale],
  );
}

/** 非组件代码（快捷键处理器、toast 文案）用；不订阅变化。 */
export const t: Translate = (key, values) =>
  translate(usePreferencesStore.getState().locale, key, values);

/* --------------------------------- 最近使用 -------------------------------- */

export function rememberWorkspace(workspaceId: string | null) {
  if (workspaceId) writeStored(LAST_WORKSPACE_KEY, workspaceId);
  else
    try {
      localStorage.removeItem(LAST_WORKSPACE_KEY);
    } catch {
      /* 同上 */
    }
}

export function rememberBoard(boardId: string | null) {
  if (boardId) writeStored(LAST_BOARD_KEY, boardId);
  else
    try {
      localStorage.removeItem(LAST_BOARD_KEY);
    } catch {
      /* 同上 */
    }
}

export function lastWorkspaceId(): string | null {
  return readStored(LAST_WORKSPACE_KEY);
}

export function lastBoardId(): string | null {
  return readStored(LAST_BOARD_KEY);
}
