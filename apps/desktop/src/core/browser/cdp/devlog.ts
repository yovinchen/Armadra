/**
 * The console and the network, as an Agent may see them.
 *
 * Two ring buffers per page, filled from events the session already receives
 * (`Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`,
 * and the four `Network.*` request events). Nothing here ASKS the page for
 * anything: the allowlist gives the Network domain two methods, both of them
 * subscriptions, and every method that would hand back a body or a Cookie is
 * named in its forbidden list.
 *
 * What a network entry keeps is metadata only — method, address, status,
 * resource type, size, duration, failure reason. Not a header: a request's
 * `Cookie` and `Authorization` and a response's `Set-Cookie` arrive on the
 * very events read here, and they are dropped at the door rather than kept and
 * filtered later. The address keeps its path and query KEYS; the value of any
 * query parameter whose name looks like a credential is blanked, because a
 * token in a query string is still a token.
 */

export type ConsoleLevel = "error" | "warning" | "info" | "log" | "debug";

export interface ConsoleEntry {
  readonly seq: number;
  readonly level: ConsoleLevel;
  readonly source: string;
  readonly text: string;
  readonly where: string;
  readonly frame: "page" | "iframe";
}

export interface NetworkEntry {
  readonly seq: number;
  readonly id: string;
  method: string;
  url: string;
  type: string;
  status: number;
  mimeType: string;
  bytes: number;
  startedAt: number;
  durationMs: number;
  failure: string;
  fromCache: boolean;
  done: boolean;
  /** Wall-clock time of the last event about it, for `wait --idle`. */
  touchedAt: number;
  readonly frame: "page" | "iframe";
}

const CONSOLE_KEEP = 500;
const NETWORK_KEEP = 500;
const TEXT_LIMIT = 1_000;
const URL_LIMIT = 300;

const LEVEL_RANK: Record<ConsoleLevel, number> = {
  error: 4,
  warning: 3,
  info: 2,
  log: 1,
  debug: 0,
};

/** Query parameter names whose values never leave this process. */
const SECRET_KEY =
  /(token|secret|password|passwd|pwd|auth|session|sig|signature|key|code|credential|jwt|sso)/i;

export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.slice(0, URL_LIMIT);
  }
  if (url.protocol === "data:" || url.protocol === "blob:") {
    return `${url.protocol}…`;
  }
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_KEY.test(key)) url.searchParams.set(key, "…");
  }
  // A fragment is the page's own state and is never sent anyway; dropping it
  // keeps an OAuth implicit-flow token out of the buffer.
  url.hash = "";
  const text = url.toString();
  return text.length > URL_LIMIT ? `${text.slice(0, URL_LIMIT)}…` : text;
}

function levelOf(type: string): ConsoleLevel {
  switch (type) {
    case "error":
    case "assert":
      return "error";
    case "warning":
    case "warn":
      return "warning";
    case "info":
      return "info";
    case "debug":
    case "verbose":
      return "debug";
    default:
      return "log";
  }
}

export function parseLevel(value: unknown): ConsoleLevel | undefined {
  if (typeof value !== "string") return undefined;
  const lowered = value.toLowerCase();
  if (lowered === "warn") return "warning";
  return lowered in LEVEL_RANK ? (lowered as ConsoleLevel) : undefined;
}

interface RemoteObject {
  type?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
}

function describe(argument: RemoteObject): string {
  if (argument.unserializableValue !== undefined)
    return argument.unserializableValue;
  const value = argument.value;
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  if (argument.type === "undefined") return "undefined";
  return argument.description ?? argument.type ?? "";
}

function bounded(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
}

function where(url: unknown, line: unknown): string {
  if (typeof url !== "string" || url === "") return "";
  const at = typeof line === "number" ? `:${line + 1}` : "";
  return `${redactUrl(url)}${at}`;
}

export class DevLog {
  private seq = 0;
  private console: ConsoleEntry[] = [];
  private network: NetworkEntry[] = [];
  private readonly open = new Map<string, NetworkEntry>();
  private lastNetworkAt = 0;

  /** One event, from the page or one of its iframes. */
  note(method: string, params: unknown, child: boolean): void {
    const frame = child ? "iframe" : "page";
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const args = Array.isArray(p.args) ? (p.args as RemoteObject[]) : [];
        const stack = p.stackTrace as
          | { callFrames?: Array<{ url?: string; lineNumber?: number }> }
          | undefined;
        const top = stack?.callFrames?.[0];
        this.pushConsole({
          level: levelOf(String(p.type ?? "log")),
          source: "console",
          text: bounded(args.map(describe).join(" ")),
          where: where(top?.url, top?.lineNumber),
          frame,
        });
        return;
      }
      case "Runtime.exceptionThrown": {
        const details = (p.exceptionDetails ?? {}) as {
          text?: string;
          exception?: RemoteObject;
          url?: string;
          lineNumber?: number;
        };
        const text =
          details.exception?.description ?? details.text ?? "Uncaught";
        this.pushConsole({
          level: "error",
          source: "exception",
          text: bounded(text),
          where: where(details.url, details.lineNumber),
          frame,
        });
        return;
      }
      case "Log.entryAdded": {
        const entry = (p.entry ?? {}) as {
          level?: string;
          source?: string;
          text?: string;
          url?: string;
          lineNumber?: number;
        };
        this.pushConsole({
          level: levelOf(entry.level ?? "info"),
          source: entry.source ?? "other",
          text: bounded(entry.text ?? ""),
          where: where(entry.url, entry.lineNumber),
          frame,
        });
        return;
      }
      case "Network.requestWillBeSent": {
        const id = String(p.requestId ?? "");
        const request = (p.request ?? {}) as { method?: string; url?: string };
        const at = typeof p.timestamp === "number" ? p.timestamp : 0;
        // A redirect reuses the request id: the hop that just ended is closed
        // with the redirect's status, and the new hop starts fresh.
        const previous = this.open.get(id);
        if (previous !== undefined) {
          const redirect = p.redirectResponse as
            | { status?: number }
            | undefined;
          previous.status = redirect?.status ?? previous.status;
          this.finish(previous, at);
        }
        const entry: NetworkEntry = {
          seq: ++this.seq,
          id,
          method: request.method ?? "GET",
          url: redactUrl(request.url ?? ""),
          type: String(p.type ?? "Other"),
          status: 0,
          mimeType: "",
          bytes: 0,
          startedAt: at,
          durationMs: 0,
          failure: "",
          fromCache: false,
          done: false,
          touchedAt: Date.now(),
          frame,
        };
        this.open.set(id, entry);
        this.network.push(entry);
        if (this.network.length > NETWORK_KEEP) this.network.shift();
        this.touch();
        return;
      }
      case "Network.responseReceived": {
        const entry = this.open.get(String(p.requestId ?? ""));
        if (entry === undefined) return;
        const response = (p.response ?? {}) as {
          status?: number;
          mimeType?: string;
          fromDiskCache?: boolean;
          fromServiceWorker?: boolean;
        };
        entry.status = response.status ?? 0;
        entry.touchedAt = Date.now();
        entry.mimeType = (response.mimeType ?? "").slice(0, 80);
        entry.fromCache =
          response.fromDiskCache === true ||
          response.fromServiceWorker === true;
        if (typeof p.type === "string") entry.type = p.type;
        this.touch();
        return;
      }
      case "Network.loadingFinished": {
        const entry = this.open.get(String(p.requestId ?? ""));
        if (entry === undefined) return;
        entry.bytes = Math.round(Number(p.encodedDataLength ?? 0));
        this.finish(entry, typeof p.timestamp === "number" ? p.timestamp : 0);
        return;
      }
      case "Network.loadingFailed": {
        const entry = this.open.get(String(p.requestId ?? ""));
        if (entry === undefined) return;
        entry.failure =
          p.canceled === true
            ? "canceled"
            : typeof p.blockedReason === "string"
              ? `blocked:${p.blockedReason}`
              : String(p.errorText ?? "failed").slice(0, 120);
        this.finish(entry, typeof p.timestamp === "number" ? p.timestamp : 0);
        return;
      }
      default:
    }
  }

  private pushConsole(entry: Omit<ConsoleEntry, "seq">): void {
    this.console.push({ seq: ++this.seq, ...entry });
    if (this.console.length > CONSOLE_KEEP) this.console.shift();
  }

  private finish(entry: NetworkEntry, at: number): void {
    entry.done = true;
    if (at > 0 && entry.startedAt > 0)
      entry.durationMs = Math.max(0, Math.round((at - entry.startedAt) * 1000));
    this.open.delete(entry.id);
    this.touch();
  }

  private touch(): void {
    this.lastNetworkAt = Date.now();
  }

  /**
   * A cross-origin iframe's document is requested from the page but finished
   * in the iframe's own process, whose session reports the end. When that
   * iframe attaches, its document request is over as far as the page goes.
   */
  documentMoved(url: string): void {
    const redacted = redactUrl(url);
    for (const entry of this.open.values()) {
      if (entry.type === "Document" && entry.url === redacted) {
        this.finish(entry, 0);
        return;
      }
    }
  }

  /** Requests still in flight. A request that never finishes (a long poll, an
   * event stream) is counted too, which is why `wait --idle` has a timeout. */
  inFlight(): number {
    const now = Date.now();
    let busy = 0;
    for (const entry of this.open.values()) {
      // A request that got its answer and then went quiet is a document that
      // moved into its own iframe process (its end is reported there) or a
      // stream; one that never answered in ten seconds is a long poll. Neither
      // is the page still loading.
      const limit = entry.status > 0 ? 5_000 : 10_000;
      if (now - entry.touchedAt < limit) busy += 1;
    }
    return busy;
  }

  /** Milliseconds since anything happened on the network. */
  quietFor(now = Date.now()): number {
    return this.lastNetworkAt === 0
      ? Number.POSITIVE_INFINITY
      : now - this.lastNetworkAt;
  }

  consoleEntries(options: {
    level?: ConsoleLevel;
    filter?: string;
    limit: number;
  }): { entries: ConsoleEntry[]; total: number } {
    const floor = options.level === undefined ? 0 : LEVEL_RANK[options.level];
    const matching = this.console.filter(
      (entry) =>
        LEVEL_RANK[entry.level] >= floor &&
        (options.filter === undefined || entry.text.includes(options.filter)),
    );
    return {
      entries: matching.slice(-Math.max(1, options.limit)),
      total: matching.length,
    };
  }

  networkEntries(options: {
    filter?: string;
    type?: string;
    failed?: boolean;
    limit: number;
  }): { entries: NetworkEntry[]; total: number; inFlight: number } {
    const type = options.type?.toLowerCase();
    const matching = this.network.filter(
      (entry) =>
        (options.filter === undefined || entry.url.includes(options.filter)) &&
        (type === undefined || entry.type.toLowerCase() === type) &&
        (options.failed !== true ||
          entry.failure !== "" ||
          entry.status >= 400),
    );
    return {
      entries: matching.slice(-Math.max(1, options.limit)),
      total: matching.length,
      inFlight: this.open.size,
    };
  }

  clearConsole(): void {
    this.console = [];
  }

  clearNetwork(): void {
    this.network = this.network.filter((entry) => !entry.done);
  }
}
