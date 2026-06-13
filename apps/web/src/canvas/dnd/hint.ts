/**
 * One shared drop hint for the whole canvas (plan §1.4): the stage-level
 * `DropLayer` and the per-node `useNodeDropTarget` both write into it, so the
 * overlay never shows two competing messages. Deliberately a plain module
 * store — the hint is transient UI state that must not enter the board
 * document or trigger a save.
 */
import { useSyncExternalStore } from "react";

type Listener = () => void;

let hint: string | null = null;
const listeners = new Set<Listener>();

export function getDropHint(): string | null {
  return hint;
}

export function setDropHint(next: string | null): void {
  if (hint === next) return;
  hint = next;
  for (const listener of listeners) listener();
}

export function subscribeDropHint(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDropHint(): string | null {
  return useSyncExternalStore(subscribeDropHint, getDropHint, getDropHint);
}
