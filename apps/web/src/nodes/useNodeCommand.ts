import { useEffect, useRef } from "react";
import type { NodeCommand } from "./actions";

/**
 * Subscribes a node body to an Inspector/shortcut command addressed to it.
 * The handler is kept in a ref so callers can pass an inline closure without
 * re-subscribing on every render.
 */
export function useNodeCommand(
  command: NodeCommand,
  nodeId: string,
  handler: () => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId?: string }>).detail;
      if (detail?.nodeId !== nodeId) return;
      handlerRef.current();
    };
    window.addEventListener(command, listener);
    return () => window.removeEventListener(command, listener);
  }, [command, nodeId]);
}
