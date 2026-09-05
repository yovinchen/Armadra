import {
  COMMANDS,
  COMMAND_BY_ID,
  commandKeys,
  chordSignature,
  isReservedChord,
  isWindowShortcut,
  isMacPlatform,
  type CommandId,
  type PlatformKeys,
} from "../../keybindings";

/**
 * 用户自定义键位的三层存储（§24.1 快捷键页；终端宿主设计 §10）。
 *
 * ```
 * 平台默认（内置，mac / other 各一套）
 *   ↑ 用户全局覆盖（Runtime settings.keymap，跟着账号走，跨设备）
 *     ↑ 本设备覆盖（localStorage，按设备 id，不同步）
 * ```
 *
 * 每一层都**按平台分开存**：录制抓到的是这台机器上的物理组合，
 * 把它同时写进另一个平台是在替用户瞎猜——mac 上录的 ⌘⇧K 在 Windows 上
 * 未必是想要的键，而且他自己在那台机器上改过之后就会被这次录制覆盖掉。
 * 所以写入只落在当前平台那一格，另一个平台保持原样（可在设置页里预览）。
 *
 * 读取时按 `设备[平台] → 全局[平台] → 默认[平台]` 取第一个有值的。
 * 冲突检测跑在合并后的结果上：只看某一层是看不出撞车的。
 */

export type PlatformName = "mac" | "other";

export const KEYMAP_PLATFORMS: readonly PlatformName[] = ["mac", "other"];

/** 一个平台上的覆盖：命令 id → 和弦写法。 */
export type KeymapLayer = Partial<Record<CommandId, string>>;

/** 一层存储（两个平台各一份覆盖表）。 */
export type StoredKeymap = Record<PlatformName, KeymapLayer>;

/** 合并后的键位，`useKeybindings` / `commandKeys` 直接认这个形状。 */
export type Keymap = Partial<Record<CommandId, PlatformKeys>>;

/** 一条键位当前由哪一层决定。 */
export type KeymapSource = "default" | "global" | "device";

const COMMAND_IDS = new Set<string>(COMMANDS.map((command) => command.id));

export function currentPlatform(mac = isMacPlatform()): PlatformName {
  return mac ? "mac" : "other";
}

export function otherPlatform(platform: PlatformName): PlatformName {
  return platform === "mac" ? "other" : "mac";
}

export function emptyKeymap(): StoredKeymap {
  return { mac: {}, other: {} };
}

function readLayer(raw: unknown): KeymapLayer {
  const layer: KeymapLayer = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return layer;
  for (const [id, chords] of Object.entries(raw as Record<string, unknown>)) {
    // PATCH 用 `null` 表示「删回上一层」，乐观更新后的本地数据里会短暂出现它。
    if (
      !COMMAND_IDS.has(id) ||
      typeof chords !== "string" ||
      chords.trim() === ""
    )
      continue;
    layer[id as CommandId] = chords;
  }
  return layer;
}

/**
 * 设置文档里的 `keymap` → 分平台的一层存储。
 *
 * 认两种写法：
 *  - 新的 `{ mac: { … }, other: { … } }`；
 *  - 旧的扁平 `{ "canvas.tidy": "Mod+Shift+K" }`——那一版两个平台共用一条写法，
 *    所以铺进两个平台，行为与旧版本完全一致，一条覆盖都不会丢。
 *
 * 两种写法同时存在时（迁移写到一半、或手改文件）以分平台的那份为准。
 */
export function parseStoredKeymap(raw: unknown): StoredKeymap {
  const stored = emptyKeymap();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return stored;
  const entries = raw as Record<string, unknown>;
  for (const platform of KEYMAP_PLATFORMS)
    stored[platform] = readLayer(entries[platform]);
  const legacy = readLayer(entries);
  for (const [id, chords] of Object.entries(legacy) as [CommandId, string][])
    for (const platform of KEYMAP_PLATFORMS) stored[platform][id] ??= chords;
  return stored;
}

/** 旧格式里所有「值是字符串」的顶层键，迁移时要显式删掉。 */
export function legacyKeymapKeys(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, value]) => typeof value === "string")
    .map(([key]) => key);
}

/**
 * 一次性迁移的 PATCH 体；没有旧格式数据时返回 `null`（不发请求）。
 *
 * Runtime 的合并是递归的、`null` 删键，所以同一个 PATCH 里既能删掉旧的扁平键，
 * 又能写进新的分平台表。旧数据的语义是「两个平台共用」，因此两格都写：
 * 迁移不改变任何一台设备上的实际键位。
 */
export type KeymapPatch = Record<
  string,
  string | null | Record<string, string | null> | undefined
>;

export function keymapMigrationPatch(raw: unknown): KeymapPatch | null {
  const legacy = legacyKeymapKeys(raw);
  if (legacy.length === 0) return null;
  const stored = parseStoredKeymap(raw);
  const patch: KeymapPatch = {};
  for (const key of legacy) patch[key] = null;
  for (const platform of KEYMAP_PLATFORMS) patch[platform] = stored[platform];
  return patch;
}

/* ------------------------------ 本设备覆盖 -------------------------------- */

const DEVICE_ID_KEY = "armadra.device.id.v1";
const DEVICE_KEYMAP_PREFIX = "armadra.keymap.device.v1.";

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID)
      return crypto.randomUUID();
  } catch {
    /* 无 Web Crypto 的宿主：退回一个够用的本地标识。 */
  }
  return `device-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * 本设备标识。只用来给「这台机器上的覆盖」分格，不是身份凭据，
 * 不上行、不参与认证；存不下来（隐私模式等）就退回一个进程内的临时 id，
 * 覆盖只在本次会话里有效——总好过写进别的设备的格子。
 */
let fallbackDeviceId: string | null = null;
export function deviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY);
    if (stored) return stored;
    const created = randomId();
    localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  } catch {
    fallbackDeviceId ??= randomId();
    return fallbackDeviceId;
  }
}

export function deviceKeymapKey(id = deviceId()): string {
  return DEVICE_KEYMAP_PREFIX + id;
}

export function loadDeviceKeymap(id = deviceId()): StoredKeymap {
  try {
    const raw = localStorage.getItem(deviceKeymapKey(id));
    if (!raw) return emptyKeymap();
    return parseStoredKeymap(JSON.parse(raw));
  } catch {
    // 存坏了就当没有本设备覆盖：全局与默认仍然可用，不让整个键盘失灵。
    return emptyKeymap();
  }
}

export function saveDeviceKeymap(next: StoredKeymap, id = deviceId()): void {
  try {
    const empty = KEYMAP_PLATFORMS.every(
      (platform) => Object.keys(next[platform]).length === 0,
    );
    if (empty) localStorage.removeItem(deviceKeymapKey(id));
    else localStorage.setItem(deviceKeymapKey(id), JSON.stringify(next));
  } catch {
    /* 存不下就只在本次会话里生效。 */
  }
}

/* -------------------------------- 合并与来源 ------------------------------ */

/**
 * 三层合并成 `useKeybindings` 要的形状。
 *
 * 两个平台各自独立合并：设置页要预览另一个平台，就得让它也是真实结果，
 * 而不是把当前平台的答案抄过去。
 */
export function resolveKeymap(
  global: StoredKeymap,
  device: StoredKeymap = emptyKeymap(),
): Keymap {
  const keymap: Keymap = {};
  for (const command of COMMANDS) {
    const resolved = KEYMAP_PLATFORMS.map(
      (platform) =>
        device[platform][command.id] ?? global[platform][command.id] ?? null,
    );
    if (resolved.every((value) => value === null)) continue;
    keymap[command.id] = {
      mac: resolved[0] ?? command.defaultKeys.mac,
      other: resolved[1] ?? command.defaultKeys.other,
    };
  }
  return keymap;
}

/** 这条命令在这个平台上由哪一层决定。 */
export function keymapSource(
  id: CommandId,
  platform: PlatformName,
  global: StoredKeymap,
  device: StoredKeymap = emptyKeymap(),
): KeymapSource {
  if (device[platform][id] !== undefined) return "device";
  if (global[platform][id] !== undefined) return "global";
  return "default";
}

/**
 * 重置一层之后这条命令会落到哪个写法上——设置页用来告诉用户「重置到什么」。
 */
export function keysBelow(
  id: CommandId,
  platform: PlatformName,
  source: KeymapSource,
  global: StoredKeymap,
): string | null {
  if (source === "device") {
    const above = global[platform][id];
    if (above !== undefined) return above;
  }
  return COMMAND_BY_ID[id].defaultKeys[platform];
}

/* --------------------------------- 录制 ----------------------------------- */

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * 按下的这一下的主键 token。
 *
 * 字母与数字优先读 `event.code`：非拉丁布局与 ⌥ 组合下 `event.key` 拿到的是
 * 本地字符（⌥K 在 macOS 上是 `˚`），只有 `code` 是稳定的。
 */
function keyToken(event: KeyboardEvent): string | null {
  const letter = /^Key([A-Z])$/.exec(event.code ?? "");
  if (letter) return letter[1]!;
  // Punctuation must use tokens: a literal comma separates alternatives and
  // a literal plus separates modifiers in the stored chord grammar.
  if (
    [
      "Comma",
      "Period",
      "Slash",
      "Backslash",
      "Semicolon",
      "Quote",
      "Backquote",
      "Minus",
      "Equal",
      "BracketLeft",
      "BracketRight",
    ].includes(event.code ?? "")
  )
    return event.code;
  if (event.key === ",") return "Comma";
  const digit = /^Digit(\d)$/.exec(event.code ?? "");
  if (digit) return digit[1]!;
  if (event.key === " " || event.code === "Space") return "Space";
  if (!event.key || MODIFIER_KEYS.has(event.key)) return null;
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

/**
 * 键盘事件 → `Mod+Shift+K` 这样的写法；只按了修饰键时返回 `null`
 * （用户还在按下去的路上）。
 *
 * 至少要有一个修饰键：无修饰的单键会把「在画布上打字」全部截走。
 */
export function chordFromEvent(
  event: KeyboardEvent,
  mac = isMacPlatform(),
): string | null {
  if (isWindowShortcut(event, mac)) return null;
  const key = keyToken(event);
  if (!key) return null;
  const parts: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) parts.push("Mod");
  if (mac && event.ctrlKey) parts.push("Ctrl");
  if (!mac && event.metaKey) parts.push("Meta");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (parts.length === 0) return null;
  parts.push(key);
  return parts.join("+");
}

/* --------------------------------- 冲突 ----------------------------------- */

/**
 * 当前平台上撞车的命令 id。
 *
 * 传进来的是**三层合并之后**的键位：只比某一层是看不出撞车的——本设备覆盖把
 * ⌘Z 挪走之后，原本冲突的那两条可能已经不冲突了，反之亦然。
 *
 * 应用监听器同时启用所有 scope，跨 scope 的组合也会互相遮挡。
 * 原生窗口键单独标为冲突，修饰键别名按实际匹配规则归一。
 */
export function keymapConflicts(
  keymap: Keymap,
  mac = isMacPlatform(),
): Set<CommandId> {
  const seen = new Map<string, CommandId>();
  const conflicts = new Set<CommandId>();
  for (const command of COMMANDS) {
    const keys = commandKeys(command.id, { mac, keymap });
    if (!keys) continue;
    for (const chord of keys.split(",")) {
      if (isReservedChord(chord, mac)) conflicts.add(command.id);
      const token = chordSignature(chord, mac);
      if (!token) continue;
      const owner = seen.get(token);
      if (owner === undefined) {
        seen.set(token, command.id);
        continue;
      }
      if (owner === command.id) continue;
      conflicts.add(owner);
      conflicts.add(command.id);
    }
  }
  return conflicts;
}

/* ------------------------------ 导入 / 导出 ------------------------------- */

export const KEYMAP_EXPORT_VERSION = 1;

export interface KeymapExport {
  version: number;
  global: StoredKeymap;
  device: StoredKeymap;
}

/** 导出的是覆盖，不是最终结果：默认键位跟着版本走，不该被冻进文件。 */
export function exportKeymap(
  global: StoredKeymap,
  device: StoredKeymap,
): string {
  return `${JSON.stringify({ version: KEYMAP_EXPORT_VERSION, global, device }, null, 2)}\n`;
}

/**
 * 解析导入文本。未知命令、非字符串写法、多余字段一律丢掉——导入一份别人的
 * 配置不该让本机的设置解析失败，也不该把一个不认识的 id 写进 Runtime。
 * 完全不是这个格式时抛错，由调用方显示「无法识别」。
 */
export function importKeymap(text: string): KeymapExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("keymap import is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("keymap import is not an object");
  const document = parsed as Record<string, unknown>;
  if (
    document.version !== undefined &&
    document.version !== KEYMAP_EXPORT_VERSION
  )
    throw new Error("keymap import version is not supported");
  // 旧格式（扁平表）也接受：那就是一份全局覆盖。
  const global = parseStoredKeymap(document.global ?? document);
  const device = parseStoredKeymap(document.device);
  return { version: KEYMAP_EXPORT_VERSION, global, device };
}
