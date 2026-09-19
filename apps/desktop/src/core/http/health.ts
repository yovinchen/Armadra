import { BUILD, instanceId } from "../instance";

/**
 * `/health` and `/api/health` — the liveness document the shell and the hook
 * clients probe.
 *
 * `instanceId` is the field that makes this answer "*which* core is this?"
 * rather than only "is something alive?". The shell compares it with the id its
 * own child announced; two builds of the same version are otherwise
 * indistinguishable, which is how a core from a previous session was once
 * adopted as the current one.
 *
 * The field list and their order are the Rust Runtime's, byte for byte
 * (`apps/runtime/src/api/health.rs`): the shell parses one document whichever
 * implementation wrote it, and `/api/health` is the older spelling the
 * launcher script still uses.
 */
export interface HookHealth {
  /** Absent when the hook service listens on no socket. */
  readonly sock?: string;
  /** Absent when it listens on no port. */
  readonly port?: number;
  /** The endpoint file exists and names this core. */
  readonly ok: boolean;
}

export interface HealthDocument {
  readonly status: "ok";
  readonly version: string;
  readonly instanceId: string;
  readonly build: string;
  readonly hook: HookHealth;
}

export interface HealthSource {
  readonly version: string;
  hookHealth(): HookHealth;
}

/**
 * R0 has no hook service, so the section reports `ok: false` with neither
 * transport — which is exactly what it would report for a core whose endpoint
 * file does not name it. R3 replaces this with the real reconciliation.
 */
export const NO_HOOK_SERVICE: HookHealth = { ok: false };

export function healthDocument(source: HealthSource): HealthDocument {
  return {
    status: "ok",
    version: source.version,
    instanceId: instanceId(),
    build: BUILD,
    hook: source.hookHealth(),
  };
}
