/** Tab identifiers of the settings dialog (SPEC §10). */
export const SETTINGS_TABS = [
  "models",
  "acp",
  "gateway",
  "theme",
  "keys",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/**
 * One-shot hand-off so a caller can deep-link into a tab — e.g. the Launcher's
 * 「快捷键」 link opens 设置 → 快捷键. Same rationale as
 * `new-workspace-state.ts`: transient, consumed on mount.
 */
let pendingSettingsTab: SettingsTab | null = null;

export function setPendingSettingsTab(tab: SettingsTab | null): void {
  pendingSettingsTab = tab;
}

export function takePendingSettingsTab(): SettingsTab | null {
  const tab = pendingSettingsTab;
  pendingSettingsTab = null;
  return tab;
}
