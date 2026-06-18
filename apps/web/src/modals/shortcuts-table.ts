/**
 * The 12 bindings of plan §1.4 / SPEC §11, in the order the design lists them.
 * Read-only: the settings tab renders them and the ⌘K palette reuses the
 * `keys` strings as hints, so a hint can never advertise a key that is not in
 * this table.
 */
export interface ShortcutEntry {
  /** i18n suffix: `shortcut.<id>`. */
  id: string;
  keys: string;
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { id: "command", keys: "⌘ K" },
  { id: "newWorkspace", keys: "⌘ N" },
  { id: "openProject", keys: "⌘ O" },
  { id: "newBoard", keys: "⌘ ⇧ N" },
  { id: "focus", keys: "⏎" },
  { id: "escape", keys: "Esc" },
  { id: "fitView", keys: "⇧ 1" },
  { id: "zoomReset", keys: "⇧ 0" },
  { id: "delete", keys: "⌫" },
  { id: "runAgent", keys: "⌘ ⏎" },
  { id: "arrange", keys: "⌘ ⇧ L" },
  { id: "toggleTheme", keys: "⌘ ⇧ T" },
];

export const SHORTCUT_KEYS: Record<string, string> = Object.fromEntries(
  SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.keys]),
);
