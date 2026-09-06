/**
 * 生效中的键位表（三层合并之后的结果），以及按 id 取键的两个函数。
 */
import {
  COMMAND_BY_ID,
  type CommandId,
  type KeyChords,
  type PlatformKeys,
} from "./commands";
import { formatKeys, isMacPlatform, type MatchOptions } from "./chords";

/**
 * 生效中的用户键位（三层合并后的结果）。
 *
 * 命令面板、Dock、右键菜单、提示都是同步调用 `commandKeysLabel(id)` 的，
 * 各自去拿 react-query 只会让「显示的键」和「真正生效的键」各说各话——
 * 用户改完键位，菜单右边还写着默认值。所以由 `useAppKeybindings`（全应用
 * 唯一装监听器的那处）在合并出结果时推一份进来，显示与派发读同一份。
 * 设置页仍然显式传 `keymap`：它要预览另一个平台。
 */
let activeKeymap: Partial<Record<CommandId, PlatformKeys>> = {};

export function setActiveKeymap(
  keymap: Partial<Record<CommandId, PlatformKeys>>,
): void {
  activeKeymap = keymap;
}

/** 取某条命令在当前平台上的按键（可被用户自定义键位覆盖）。 */
export function commandKeys(
  id: CommandId,
  options: MatchOptions & {
    keymap?: Partial<Record<CommandId, PlatformKeys>>;
  } = {},
): KeyChords {
  const mac = options.mac ?? isMacPlatform();
  const platformKeys =
    (options.keymap ?? activeKeymap)[id] ?? COMMAND_BY_ID[id].defaultKeys;
  return mac ? platformKeys.mac : platformKeys.other;
}

/** 命令在当前平台上的显示串，命令面板与菜单右侧直接用。 */
export function commandKeysLabel(
  id: CommandId,
  options: MatchOptions & {
    keymap?: Partial<Record<CommandId, PlatformKeys>>;
  } = {},
): string {
  return formatKeys(commandKeys(id, options), options);
}
