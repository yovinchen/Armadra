/**
 * The `updates` half of `window.armadra`, the bridge the Electron shell's
 * preload exposes (`apps/desktop/src/preload/index.ts`).
 *
 * `ArmadraBridge` is declared, not defined: each domain of the bridge adds its
 * own member from its own `.d.ts` through interface declaration merging, so no
 * two batches have to edit one file. This one contributes `updates`, and
 * mirrors `IPC.updates*` of `apps/desktop/src/shared/ipc.ts` one for one.
 *
 * Only the seven commands and the one event appear here. The payloads stay
 * `unknown` on the way in — the preload hands over whatever the main process
 * answered, and `shell-updater.ts` is where it is given a type, exactly as it
 * did with the previous shell's `invoke`.
 */

declare global {
  interface ArmadraUpdatesBridge {
    /** The state as the shell holds it. Reads nothing off the network. */
    state(): Promise<unknown>;
    /** Hands the Host's answer over and returns the state it reached. */
    check(verdict: unknown): Promise<unknown>;
    dismiss(): Promise<unknown>;
    cancel(): Promise<unknown>;
    download(): Promise<unknown>;
    /** On success this never resolves: the process is replaced. */
    install(): Promise<unknown>;
    /** `null` when no update was pending, which is the ordinary case. */
    restartReport(): Promise<unknown>;
    /** Transfer progress. Returns the unsubscribe. */
    onProgress(listener: (progress: unknown) => void): () => void;
  }

  interface ArmadraBridge {
    readonly updates: ArmadraUpdatesBridge;
  }

  interface Window {
    readonly armadra?: ArmadraBridge;
  }
}

export {};
