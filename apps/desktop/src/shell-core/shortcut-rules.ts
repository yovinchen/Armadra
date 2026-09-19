/**
 * 系统级全局热键（快捷键页的 `global` 作用域），ported from
 * `src-tauri/src/shortcuts.rs`.
 *
 * A global hotkey is the only kind of shortcut that fires while another
 * application is in front, which makes it the only kind that can take a
 * combination away from software this shell knows nothing about. Three rules
 * follow from that, and they are the whole of this module's design:
 *
 *   1. **Nothing is registered by default.** The command table ships both of
 *      these unbound; a hotkey only exists because somebody typed it into the
 *      settings page.
 *   2. **Only the ids in `KNOWN_IDS` can be bound.** The page hands over a
 *      list, and a list from a page is input — an id this build does not
 *      recognize is refused rather than registered against nothing.
 *   3. **A refusal is reported, not swallowed.** The operating system, or
 *      another application, may already hold a combination. Saying so is the
 *      only way a person can pick a different one; silently failing would leave
 *      them pressing a key that does nothing, with the settings page claiming
 *      it is bound.
 *
 * Applying a list always starts by unregistering everything this shell holds,
 * so the set of live hotkeys is exactly the last list that was applied — there
 * is no incremental state to drift out of sync with the settings document.
 * `main/shortcuts.ts` is where that sequence talks to Electron.
 */

import { toElectronAccelerator } from "./accelerator";

/** The command ids this shell will register a system hotkey for. */
export const KNOWN_IDS: readonly string[] = [
  "global.toggleWindow",
  "global.newTerminal",
];

/** One requested hotkey, as the settings page sends it. */
export interface Binding {
  readonly id: string;
  /** Tauri accelerator syntax (`CmdOrCtrl+Shift+K`); the page converts from
   * the chord syntax the rest of the keymap uses, and `accelerator.ts`
   * converts the rest of the way. */
  readonly accelerator?: string;
}

/** What became of one requested hotkey. */
export type BindingState =
  /** Registered with the operating system; it will fire. */
  | "bound"
  /** No accelerator was asked for. The ordinary case. */
  | "unbound"
  /** This build does not know the id, or the accelerator did not parse. */
  | "invalid"
  /** The operating system refused it — something else already holds it. */
  | "taken";

export interface BindingOutcome {
  readonly id: string;
  readonly state: BindingState;
}

/** Whether this build knows what to do with an id. */
export function isKnownId(id: unknown): boolean {
  return typeof id === "string" && KNOWN_IDS.includes(id);
}

/**
 * The outcome of a request before the operating system is consulted, or the
 * Electron accelerator to try.
 *
 * Pure, because it is where the input from the page is judged, and that
 * judgement is worth a test that does not need a window.
 */
export type Precheck =
  | { readonly ok: true; readonly accelerator: string }
  | { readonly ok: false; readonly state: BindingState };

export function precheck(binding: Binding): Precheck {
  if (!isKnownId(binding.id)) return { ok: false, state: "invalid" };
  const requested = (binding.accelerator ?? "").trim();
  if (requested === "") return { ok: false, state: "unbound" };
  const accelerator = toElectronAccelerator(requested);
  if (!accelerator) return { ok: false, state: "invalid" };
  return { ok: true, accelerator };
}

/** A list from the page is input: anything that is not an object with a string
 * id is dropped before it can reach `precheck`. */
export function readBindings(value: unknown): Binding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const binding = entry as Record<string, unknown>;
    if (typeof binding.id !== "string") return [];
    return [
      {
        id: binding.id,
        accelerator:
          typeof binding.accelerator === "string" ? binding.accelerator : "",
      },
    ];
  });
}
