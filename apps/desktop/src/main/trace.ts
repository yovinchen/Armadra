/**
 * One line on stderr when `ARMADRA_DESKTOP_LIFECYCLE_TRACE=1`. Lifecycle bugs
 * are timing bugs, and a trace that is off by default costs nothing
 * (`src-tauri/src/lib.rs:18-24`).
 *
 * The event names below are the Tauri shell's, word for word, so a trace from
 * either shell can be compared against the other during the migration.
 */
export function traceLifecycle(event: string): void {
  if (process.env.ARMADRA_DESKTOP_LIFECYCLE_TRACE === "1") {
    process.stderr.write(`Desktop lifecycle ${process.pid}: ${event}\n`);
  }
}

/** Every event the shell traces, in the order a clean run emits them. */
export const LIFECYCLE_EVENTS = [
  "setup",
  "ready",
  "enter event loop",
  "foreground close requested",
  "reopen",
  "exit requested; stopping services",
  "exit",
  "event loop returned",
] as const;
