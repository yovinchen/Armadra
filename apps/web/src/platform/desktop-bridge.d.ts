/**
 * `window.armadra` — the Electron shell's preload bridge
 * (`apps/desktop/src/preload/index.ts`, table in
 * docs/design/electron-migration.md §2.2).
 *
 * Only the two domains W1.2 needs are declared. The rest of the table
 * (dialog, shell, updates, shortcuts, window, app, browser) is W2.1's, and is
 * added there rather than guessed at here — a declaration for a method the
 * preload does not expose is worse than no declaration, because it typechecks.
 *
 * The bridge is absent in a browser and in the Tauri shell, so every field is
 * reached through an optional chain and every caller has a fallback.
 */

interface ArmadraTransportEndpoints {
  /** The Runtime's HTTP base, no trailing slash. */
  readonly httpBase: string;
  /** The Runtime's WebSocket base, no trailing slash. */
  readonly wsBase: string;
  /** The Host's loopback base, no trailing slash. */
  readonly hostBase: string;
  /** The data directory the Runtime and the Host agreed on. */
  readonly dataDir: string;
}

/** A native session ticket, exactly as `armadra-host pair` prints it. */
interface ArmadraNativeTicket {
  readonly hostId: string;
  readonly hostInstanceId: string;
  readonly origin: string;
  readonly ticket: string;
  /** Milliseconds as a decimal string; compared as a bigint. */
  readonly expiresAtUnixMs: string;
}

/**
 * A refusal is a result, not a rejection: Electron serializes a rejected
 * `ipcMain.handle` down to its message, and "the Host is not up yet" is
 * something the page acts on rather than a broken channel.
 */
type ArmadraTicketAnswer =
  | { readonly ok: true; readonly ticket: ArmadraNativeTicket }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

interface ArmadraDesktopBridge {
  readonly transport: {
    endpoints(): Promise<ArmadraTransportEndpoints>;
    /**
     * The same answer before the page's first `await`. The Runtime base is
     * decided while `apps/web/src/api/request.ts` is still evaluating, which
     * is the one case a promise cannot serve; the shell publishes the value
     * before the window loads, so this reads rather than waits.
     */
    endpointsSync(): ArmadraTransportEndpoints;
  };
  readonly identity: {
    /** One one-time ticket. Pairing itself never crosses the bridge. */
    ticket(): Promise<ArmadraTicketAnswer>;
  };
}

interface Window {
  readonly armadra?: ArmadraDesktopBridge;
}
