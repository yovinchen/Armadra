import { TerminalSurface } from "../terminal/TerminalSurface";
import type { NodeContentProps, OfKind } from "./types";

/** Terminal body — the xterm surface owns the header, screen and footer. */
export function TerminalNode({ id, data, focused }: NodeContentProps) {
  return (
    <TerminalSurface
      id={id}
      data={data as OfKind<"terminal">}
      focused={focused}
    />
  );
}
