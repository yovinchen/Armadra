import { usePreferencesStore } from "../../app/preferences-store";

/**
 * 右栏内的子页（§24.1「子页在同一右栏内推入」）。
 *
 * 子页 id 编码成 `<kind>:<ref>`，`ref` 为 `new` 时是新建、否则是那一条的 id。
 * 把「是哪一类、编辑的是谁」放进这一个字符串里，页头的标题就能由 id 推出来，
 * 不必让页面把文案回传给对话框。
 */
export type SubpageKind = "ssh" | "agent";

export function subpageId(kind: SubpageKind, ref: string): string {
  return `${kind}:${ref}`;
}

export function parseSubpage(
  subpage: string | null,
): { kind: SubpageKind; ref: string } | null {
  if (!subpage) return null;
  const separator = subpage.indexOf(":");
  if (separator <= 0) return null;
  const kind = subpage.slice(0, separator);
  const ref = subpage.slice(separator + 1);
  if (kind !== "ssh" && kind !== "agent") return null;
  return { kind, ref };
}

/** 子页标题的 i18n 键；新建与编辑各一句。 */
export function subpageTitleKey(subpage: string): string {
  const parsed = parseSubpage(subpage);
  if (!parsed) return "settings.title";
  const isNew = parsed.ref === "new";
  if (parsed.kind === "ssh") {
    return isNew ? "ssh.dialog.add" : "ssh.dialog.edit";
  }
  return isNew ? "settings.customAgent.new" : "settings.customAgent.edit";
}

export interface SubpageApi {
  /** 当前子页 id，`null` = 停在分区页。 */
  current: string | null;
  open: (kind: SubpageKind, ref: string) => void;
  close: () => void;
}

export function useSubpage(): SubpageApi {
  const current = usePreferencesStore((state) => state.settingsSubpage);
  const set = usePreferencesStore((state) => state.setSettingsSubpage);
  return {
    current,
    open: (kind, ref) => set(subpageId(kind, ref)),
    close: () => set(null),
  };
}
