import { useMemo } from "react";
import { create } from "zustand";
import {
  PERMISSION_MODES,
  type PermissionMode,
} from "@armadra/shared";
import {
  DEFAULT_LOCALE,
  LOCALES,
  translate,
  type Locale,
  type TranslateValues,
} from "../i18n";

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
/** 侧栏「置顶」组里的看板 id（§26）。 */
const PINNED_BOARDS_KEY = "armadra.pinnedBoards";
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
/** 节点颜色的表达方式（§24.3-3）：色点 + 1px 顶描边，或旧的 3px 色条。 */
const NODE_COLOR_STYLE_KEY = "armadra.nodeColorStyle";
/** 终端外观（§18.3 最后一行「设置项」）。全部只存本地，Runtime 不关心。 */
const TERM_FONT_FAMILY_KEY = "armadra.terminal.fontFamily";
const TERM_FONT_SIZE_KEY = "armadra.terminal.fontSize";
const TERM_LINE_HEIGHT_KEY = "armadra.terminal.lineHeight";
const TERM_LETTER_SPACING_KEY = "armadra.terminal.letterSpacing";
const TERM_CURSOR_STYLE_KEY = "armadra.terminal.cursorStyle";
const TERM_CURSOR_BLINK_KEY = "armadra.terminal.cursorBlink";
const TERM_OPTION_META_KEY = "armadra.terminal.macOptionIsMeta";
const TERM_COPY_ON_SELECT_KEY = "armadra.terminal.copyOnSelect";
const TERM_WEBGL_KEY = "armadra.terminal.webgl";
/** 白板（tldraw 原生配置）。全部只存本地，Runtime 不关心。 */
const WB_BACKGROUND_KEY = "armadra.whiteboard.background";
const WB_GRID_KEY = "armadra.whiteboard.grid";
const WB_GRID_SIZE_KEY = "armadra.whiteboard.gridSize";
const WB_SNAP_KEY = "armadra.whiteboard.snap";
const WB_DYNAMIC_SIZE_KEY = "armadra.whiteboard.dynamicSize";
const WB_ANIMATION_KEY = "armadra.whiteboard.animation";
const WB_STYLE_KEY = "armadra.whiteboard.style";
const WB_COLOR_KEY = "armadra.whiteboard.defaultColor";
const WB_SIZE_KEY = "armadra.whiteboard.defaultSize";
/** 设置页上次停在的分区（§24.1）；⌘, 直接回到那一页。 */
const LAST_SETTINGS_SECTION_KEY = "armadra.settingsSection";
/** 上次打开的工作空间 / 看板；启动时用来跳过启动页。 */
export const LAST_WORKSPACE_KEY = "armadra.workspace";
export const LAST_BOARD_KEY = "armadra.board";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式下写不进去；内存里的值仍然有效
  }
}

function storedEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = readStored(key) as T | null;
  return value && allowed.includes(value) ? value : fallback;
}

function storedBoolean(key: string, fallback: boolean): boolean {
  const raw = readStored(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function storedNumber(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readStored(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** `Record<string, string>` 形状的偏好；坏数据当作没存过。 */
function storedRecord(key: string): Record<string, string> {
  const raw = readStored(key);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const result: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "string") result[id] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function storedIds(key: string): string[] {
  const raw = readStored(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * 节点颜色风格（§24.3-3）。
 *
 * `dot`（默认）= 头部左上 8px 色点 + 1px 顶部描边，克制；
 * `bar` = 旧的 3px 顶部色条，颜色更抢眼。设置页在「界面」分区里暴露它。
 */
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

export const TERMINAL_CURSOR_STYLES = ["block", "bar", "underline"] as const;
export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number];

/**
 * 终端外观偏好（计划书 §18.3）。
 *
 * 单独成型是因为 `TerminalSurface` 要把整块当依赖：任何一项变化都要
 * 重设 xterm options 再 fit 一次，而不是每项各挂一个 effect。
 * `fontFamily` 为空表示「跟随 `--font-code`」。
 */
export interface TerminalPreferences {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  /** macOS 上 Option 当 Meta；默认关，否则 ⌥ 组合字符打不出来（§18.3 键盘行）。 */
  macOptionIsMeta: boolean;
  /** 选中即复制。默认关：选错一次就会把剪贴板冲掉。 */
  copyOnSelect: boolean;
  /** WebGL 渲染器；默认关，DOM 渲染器在画布缩放下更清晰（§18.2 规则 5）。 */
  webgl: boolean;
}

export const TERMINAL_FONT_SIZE_RANGE = [10, 20] as const;
export const TERMINAL_LINE_HEIGHT_RANGE = [1, 1.6] as const;

/* --------------------------------- 白板 ----------------------------------- */

/**
 * 白板背景（用户反馈 2026-09-04：把 tldraw 原生配置引进设置）。
 *
 * `theme` = 跟随应用主题（`tokens.css` 里的 `--canvas-bg`）；其余四档是固定
 * 底色，深浅色下都用同一个值——「纯黑」在浅色主题下也该是纯黑。
 * 色值与点阵色的换算在 `use-tldraw-preferences.ts`（纯函数，有单测）。
 */
export const WHITEBOARD_BACKGROUNDS = [
  "theme",
  "black",
  "white",
  "paper",
  "slate",
] as const;
export type WhiteboardBackground = (typeof WHITEBOARD_BACKGROUNDS)[number];

/** 点阵间距（px）。tldraw 的 `gridSize` 是这个值的 1/4，见 §「网格换算」。 */
export const WHITEBOARD_GRID_SIZES = [12, 24, 48] as const;
export type WhiteboardGridSize = (typeof WHITEBOARD_GRID_SIZES)[number];

/** 新形状的默认风格：手绘（`draw` 线型 + 手写体）/ 整洁（实线 + 无衬线）。 */
export const WHITEBOARD_STYLES = ["sketch", "clean"] as const;
export type WhiteboardStyle = (typeof WHITEBOARD_STYLES)[number];

/** tldraw 的 13 个颜色名（`TLDefaultColorStyle`），顺序即色板顺序。 */
export const WHITEBOARD_COLORS = [
  "black",
  "grey",
  "white",
  "blue",
  "light-blue",
  "green",
  "light-green",
  "yellow",
  "orange",
  "red",
  "light-red",
  "violet",
  "light-violet",
] as const;
export type WhiteboardColor = (typeof WHITEBOARD_COLORS)[number];

/** tldraw 的 `TLDefaultSizeStyle`。 */
export const WHITEBOARD_SIZES = ["s", "m", "l", "xl"] as const;
export type WhiteboardSize = (typeof WHITEBOARD_SIZES)[number];

/**
 * 白板偏好。
 *
 * 和终端外观一样整块存：`use-tldraw-preferences.ts` 挂载和变化时把它推给
 * tldraw（`updateUserPreferences` / `updateInstanceState` /
 * `updateDocumentSettings` / `setStyleForNextShapes`），这里是唯一真相。
 */
export interface WhiteboardPreferences {
  background: WhiteboardBackground;
  /** 点阵开关，映射 `isGridMode`。 */
  grid: boolean;
  gridSize: WhiteboardGridSize;
  /** 吸附，映射 `isSnapMode`。 */
  snap: boolean;
  /** 缩放时新形状字号跟随，映射 `isDynamicSizeMode`。 */
  dynamicSize: boolean;
  /** 动画，映射 `animationSpeed` 1 / 0。 */
  animation: boolean;
  style: WhiteboardStyle;
  defaultColor: WhiteboardColor;
  defaultSize: WhiteboardSize;
}

const WHITEBOARD_KEYS: Record<keyof WhiteboardPreferences, string> = {
  background: WB_BACKGROUND_KEY,
  grid: WB_GRID_KEY,
  gridSize: WB_GRID_SIZE_KEY,
  snap: WB_SNAP_KEY,
  dynamicSize: WB_DYNAMIC_SIZE_KEY,
  animation: WB_ANIMATION_KEY,
  style: WB_STYLE_KEY,
  defaultColor: WB_COLOR_KEY,
  defaultSize: WB_SIZE_KEY,
};

/** 数字枚举没法走 `storedEnum`（存进去是字符串），单独收一个。 */
function storedWhiteboardGridSize(): WhiteboardGridSize {
  const raw = readStored(WB_GRID_SIZE_KEY);
  const value = Number(raw);
  return (WHITEBOARD_GRID_SIZES as readonly number[]).includes(value)
    ? (value as WhiteboardGridSize)
    : 24;
}

function storedWhiteboardPreferences(): WhiteboardPreferences {
  return {
    background: storedEnum(WB_BACKGROUND_KEY, WHITEBOARD_BACKGROUNDS, "theme"),
    grid: storedBoolean(WB_GRID_KEY, true),
    gridSize: storedWhiteboardGridSize(),
    snap: storedBoolean(WB_SNAP_KEY, false),
    dynamicSize: storedBoolean(WB_DYNAMIC_SIZE_KEY, false),
    animation: storedBoolean(WB_ANIMATION_KEY, true),
    style: storedEnum(WB_STYLE_KEY, WHITEBOARD_STYLES, "sketch"),
    defaultColor: storedEnum(WB_COLOR_KEY, WHITEBOARD_COLORS, "black"),
    defaultSize: storedEnum(WB_SIZE_KEY, WHITEBOARD_SIZES, "m"),
  };
}

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

export interface PreferencesState {
  theme: ThemePreference;
  locale: Locale;
  systemTheme: ResolvedTheme;
  /** 侧栏工作空间树里的行，顺序即打开顺序（§22 第一栏）。 */
  openWorkspaceIds: string[];
  /** 「项目」组里收起来的工作空间 id（§26）。默认全部展开。 */
  collapsedWorkspaceIds: string[];
  /** 「置顶」组里的看板 id，顺序即置顶顺序（§26）。 */
  pinnedBoardIds: string[];
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
  /** 白板（tldraw 原生配置）；`use-tldraw-preferences.ts` 负责推给 editor。 */
  whiteboard: WhiteboardPreferences;
  setTheme: (theme: ThemePreference) => void;
  setLocale: (locale: Locale) => void;
  setSystemTheme: (theme: ResolvedTheme) => void;
  openWorkspaceTab: (workspaceId: string) => void;
  closeWorkspaceTab: (workspaceId: string) => void;
  setWorkspaceCollapsed: (workspaceId: string, collapsed: boolean) => void;
  setBoardPinned: (boardId: string, pinned: boolean) => void;
  setAgentMode: (agentId: string, mode: AgentMode) => void;
  setLaunchOverride: (agentId: string, program: string) => void;
  setDefaultAgentId: (agentId: string | null) => void;
  setDefaultPermissionMode: (mode: PermissionMode) => void;
  setNotifyDone: (enabled: boolean) => void;
  setNotifyNeedsYou: (enabled: boolean) => void;
  setSound: (enabled: boolean) => void;
  setSoundVolume: (volume: number) => void;
  setShowUsage: (enabled: boolean) => void;
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

const TERMINAL_KEYS: Record<keyof TerminalPreferences, string> = {
  fontFamily: TERM_FONT_FAMILY_KEY,
  fontSize: TERM_FONT_SIZE_KEY,
  lineHeight: TERM_LINE_HEIGHT_KEY,
  letterSpacing: TERM_LETTER_SPACING_KEY,
  cursorStyle: TERM_CURSOR_STYLE_KEY,
  cursorBlink: TERM_CURSOR_BLINK_KEY,
  macOptionIsMeta: TERM_OPTION_META_KEY,
  copyOnSelect: TERM_COPY_ON_SELECT_KEY,
  webgl: TERM_WEBGL_KEY,
};

function storedTerminalPreferences(): TerminalPreferences {
  return {
    fontFamily: readStored(TERM_FONT_FAMILY_KEY) ?? "",
    fontSize: storedNumber(
      TERM_FONT_SIZE_KEY,
      13,
      TERMINAL_FONT_SIZE_RANGE[0],
      TERMINAL_FONT_SIZE_RANGE[1],
    ),
    lineHeight: storedNumber(
      TERM_LINE_HEIGHT_KEY,
      1.2,
      TERMINAL_LINE_HEIGHT_RANGE[0],
      TERMINAL_LINE_HEIGHT_RANGE[1],
    ),
    letterSpacing: storedNumber(TERM_LETTER_SPACING_KEY, 0, -2, 4),
    cursorStyle: storedEnum(
      TERM_CURSOR_STYLE_KEY,
      TERMINAL_CURSOR_STYLES,
      "block",
    ),
    cursorBlink: storedBoolean(TERM_CURSOR_BLINK_KEY, true),
    macOptionIsMeta: storedBoolean(TERM_OPTION_META_KEY, false),
    copyOnSelect: storedBoolean(TERM_COPY_ON_SELECT_KEY, false),
    webgl: storedBoolean(TERM_WEBGL_KEY, false),
  };
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  theme: storedEnum(THEME_KEY, THEME_PREFERENCES, "system"),
  locale: storedEnum(LOCALE_KEY, LOCALES, DEFAULT_LOCALE),
  systemTheme: systemColorScheme(),
  openWorkspaceIds: storedIds(OPEN_WORKSPACES_KEY),
  collapsedWorkspaceIds: storedIds(COLLAPSED_WORKSPACES_KEY),
  pinnedBoardIds: storedIds(PINNED_BOARDS_KEY),
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
 */
export function syncDocumentPreferences(): () => void {
  const apply = () => {
    const state = usePreferencesStore.getState();
    const resolved = resolveTheme(state);
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
    root.lang = state.locale;
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
