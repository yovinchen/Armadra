/**
 * 键位配置档：一整套键位，命名，可以随时换。
 *
 * 三层合并没有变——**内置默认 → 全局 → 本设备**。配置档决定的是中间那一层
 * 装的是什么：切到「VS Code 风格」，全局层就换成那一套；切回「默认」，
 * 全局层就换回你在默认档里改过的那些。两个档各自记各自的修改，切来切去
 * 不会互相覆盖，这正是「配置档」和「一次性把默认键改掉」的区别。
 *
 * 全局层内部还分两半，只是它们仍然同属一层：
 *
 * ```
 * 内置默认（commands.ts 的 defaultKeys）
 *   ↑ 全局 ┬ 配置档预设（内置配置档自带的那张表，只读）
 *          └ 用户在这个档里的修改（Runtime settings，跟着账号跨设备）
 *     ↑ 本设备（localStorage，按设备 id，不同步）
 * ```
 *
 * 预设放在代码里而不是切换时写进设置：那样一来「VS Code 风格」就会被冻成
 * 用户自己的一堆覆盖，以后版本更新了预设也传不到已经切过的人身上，而且
 * 「重置这一条」也说不清该回到哪儿。
 *
 * 存储形状（`settings.keymap`）：
 *
 * ```jsonc
 * {
 *   "profile": "vscode",              // 当前用哪个档，缺省 "default"
 *   "mac": { … }, "other": { … },     // 默认档的用户修改——就是旧的那两格
 *   "when": { … },                    // 默认档里改过的条件（不分平台）
 *   "profiles": { "vscode": { "mac": { … }, "other": { … } } }
 * }
 * ```
 *
 * 默认档仍然直接放在顶层的 `mac` / `other` 里，所以从没听说过配置档的旧数据
 * 读出来就是「默认档，改过这些键」——不需要迁移，也不会丢任何一条覆盖。
 */
import type { CommandId } from "../../keybindings";

import {
  KEYMAP_SECTIONS,
  emptyKeymap,
  parseStoredKeymap,
  type KeymapLayer,
  type KeymapSection,
  type StoredKeymap,
} from "./keymap";

/** 内置配置档。用户建的档 id 不能和这两个重名。 */
export const BUILTIN_PROFILE_IDS = ["default", "vscode"] as const;

export type BuiltinProfileId = (typeof BUILTIN_PROFILE_IDS)[number];

export const DEFAULT_PROFILE_ID: BuiltinProfileId = "default";

/** 自建档的 id：小写、短、能当对象键，不至于在设置文件里刺眼。 */
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

function layer(entries: Partial<Record<CommandId, string>>): KeymapLayer {
  return entries;
}

/**
 * 「VS Code 风格」的预设。
 *
 * 只改真的和 VS Code 不一样、而且肌肉记忆很硬的那些；其余保持默认，
 * 换一个档不该把一整张表都变得陌生。
 *
 * 三条被腾开的键各自有去处：⌘⇧P 让给命令面板，画布的 ⌘⇧F 让给项目搜索，
 * 侧栏改成 ⌘B。腾出来的 ⌘K 与 ⌘⇧H 不再绑任何东西——把它们塞给别的命令
 * 只是在制造新的意外。
 */
export const PROFILE_PRESETS: Record<BuiltinProfileId, StoredKeymap> = {
  default: emptyKeymap(),
  vscode: {
    mac: layer({
      "app.commandPalette": "Mod+Shift+P",
      "app.sidebar": "Mod+B",
      "app.projectSearch": "Mod+Shift+F",
      "app.problems": "Mod+Shift+M",
      // ⌘⇧F 归了项目搜索，专注模式换成 VS Code 的 Zen Mode 那一档的空位。
      "canvas.focusMode": "Mod+Shift+Backslash",
      "canvas.newTerminal": "Ctrl+Backquote",
    }),
    other: layer({
      "app.commandPalette": "Mod+Shift+P",
      "app.sidebar": "Mod+B",
      "app.projectSearch": "Mod+Shift+F",
      "app.problems": "Mod+Shift+M",
      "canvas.focusMode": "Mod+Shift+Backslash",
      "canvas.newTerminal": "Ctrl+Backquote",
    }),
    when: {},
  },
};

export function isBuiltinProfile(id: string): id is BuiltinProfileId {
  return (BUILTIN_PROFILE_IDS as readonly string[]).includes(id);
}

/** 这个档自带的预设；自建档没有预设，从内置默认起步。 */
export function profilePreset(id: string): StoredKeymap {
  return isBuiltinProfile(id) ? PROFILE_PRESETS[id] : emptyKeymap();
}

/**
 * 设置文档里存着的每个档的**用户修改**（不含预设）。
 *
 * 默认档读顶层的 `mac` / `other`，其余读 `profiles.<id>`。
 */
export function storedProfiles(raw: unknown): Record<string, StoredKeymap> {
  const profiles: Record<string, StoredKeymap> = {
    [DEFAULT_PROFILE_ID]: parseStoredKeymap(raw),
  };
  const section =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).profiles
      : undefined;
  if (section && typeof section === "object" && !Array.isArray(section))
    for (const [id, value] of Object.entries(
      section as Record<string, unknown>,
    )) {
      // 顶层已经是默认档；`profiles.default` 里再写一份只会让两处打架。
      if (id === DEFAULT_PROFILE_ID || !PROFILE_ID_PATTERN.test(id)) continue;
      profiles[id] = parseStoredKeymap(value);
    }
  // 内置档即使一条修改都没有也要出现在列表里，不然切不过去。
  for (const id of BUILTIN_PROFILE_IDS) profiles[id] ??= emptyKeymap();
  return profiles;
}

/** 当前选中的档。指向一个不存在的档时回到默认，而不是让键盘失灵。 */
export function activeProfileId(raw: unknown): string {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).profile
      : undefined;
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value))
    return DEFAULT_PROFILE_ID;
  return value in storedProfiles(raw) ? value : DEFAULT_PROFILE_ID;
}

/** 一个档的用户修改盖在它的预设上——这就是「全局」那一层。 */
export function mergeLayers(
  preset: StoredKeymap,
  user: StoredKeymap,
): StoredKeymap {
  const merged = emptyKeymap();
  for (const section of KEYMAP_SECTIONS)
    merged[section] = { ...preset[section], ...user[section] };
  return merged;
}

/** 当前档最终交给 `resolveKeymap` 的那一层。 */
export function activeGlobalLayer(raw: unknown): StoredKeymap {
  const id = activeProfileId(raw);
  return mergeLayers(
    profilePreset(id),
    storedProfiles(raw)[id] ?? emptyKeymap(),
  );
}

/**
 * 往这个档写东西时，PATCH 该套在哪一层。
 *
 * 默认档就是顶层的 `mac` / `other`（与从前完全一样的形状），其余的档套进
 * `profiles.<id>`。所有写入都走这里，写默认档和写别的档才不会分叉出两套代码。
 */
export function profileLayersPatch(
  id: string,
  layers: Record<string, unknown>,
): Record<string, unknown> {
  return id === DEFAULT_PROFILE_ID ? layers : { profiles: { [id]: layers } };
}

/**
 * 往这个档的一格写若干条覆盖（`null` 表示删回上一层，空串是「清空」或
 * 「不设条件」）。格是一个平台，或者不分平台的 `when`。
 */
export function profilePatch(
  id: string,
  platform: KeymapSection,
  entries: Record<string, string | null>,
): Record<string, unknown> {
  return profileLayersPatch(id, { [platform]: entries });
}

/** 切换当前档的 PATCH。 */
export function selectProfilePatch(id: string): Record<string, unknown> {
  return { profile: id };
}

/**
 * 新建一个档的 PATCH：只记下它被选中了，外加一格空的存储。
 *
 * 空对象是必要的——没有它，`storedProfiles` 读不到这个 id，
 * `activeProfileId` 就会认为选中的档不存在并弹回默认。
 */
export function createProfilePatch(id: string): Record<string, unknown> {
  return { profile: id, profiles: { [id]: emptyKeymap() } };
}

/** 删掉一个自建档；内置档删不掉，删掉当前档就回到默认。 */
export function deleteProfilePatch(
  id: string,
  active: string,
): Record<string, unknown> | null {
  if (isBuiltinProfile(id)) return null;
  const patch: Record<string, unknown> = { profiles: { [id]: null } };
  if (active === id) patch.profile = DEFAULT_PROFILE_ID;
  return patch;
}
