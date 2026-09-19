import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import {
  DRIVE_CODES,
  DRIVE_PATH,
  HELLO_TIMEOUT_MS,
  VERB_TIMEOUT_MS,
  driveAddress,
  driveError,
  parseDriveRequest,
  tokenMatches,
  type DriveEvent,
  type DriveResponse,
} from "../../shell-core/browser/drive";
import {
  MessageReader,
  encodeClose,
  encodeFrame,
  encodeText,
  handshakeResponse,
} from "../../shell-core/browser/websocket";

/**
 * The loopback socket the Runtime dials to hand this shell a verb.
 *
 * Bound to 127.0.0.1 on a kernel-assigned port, reachable only by something
 * that already knows the token, and the token is only ever written into the
 * environment of the Runtime this shell itself spawned. A shell that did not
 * start the Runtime therefore has no drive channel at all, which is the
 * correct answer: it has no claim on somebody else's Runtime either.
 *
 * ONE peer at a time. A second connection that authenticates replaces the
 * first, because the Runtime reconnecting after a socket died is the ordinary
 * case and refusing it would leave the channel dead until a restart.
 */

export type VerbRunner = (request: {
  id: string;
  nodeId: string;
  verb: string;
  args: Record<string, unknown>;
}) => Promise<unknown>;

/**
 * Something the Runtime tells the shell without asking for an answer.
 *
 * There is exactly one today, and it is the important one: `revoke`. The lease
 * ended — a person clicked into the page, or pressed Stop — and every debugger
 * attached to that node must go NOW. It is a notice rather than a verb because
 * the Runtime is not asking permission and must not wait: a revocation that can
 * be delayed by a busy page is a revocation that has not happened.
 */
export type NoticeHandler = (
  notice: string,
  nodeId: string,
  detail: unknown,
) => void;

export interface DriveServer {
  readonly address: string;
  readonly token: string;
  /** Pushes an event to the Runtime, if one is connected. */
  publish(event: DriveEvent): void;
  connected(): boolean;
  close(): void;
}

interface Peer {
  socket: Duplex;
  authenticated: boolean;
}

export function startDriveServer(
  run: VerbRunner,
  notice: NoticeHandler = () => {},
): Promise<DriveServer> {
  const token = randomBytes(32).toString("hex");
  let peer: Peer | null = null;

  const http: Server = createServer((_request, response) => {
    // Nothing but the upgrade answers here. A plain GET is not a mistake worth
    // describing.
    response.writeHead(426);
    response.end();
  });

  http.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const key = request.headers["sec-websocket-key"];
      if (request.url !== DRIVE_PATH || typeof key !== "string") {
        socket.destroy();
        return;
      }
      socket.write(handshakeResponse(key));
      // `head` is whatever arrived in the same packet as the request line. A
      // client that writes its hello immediately after the GET puts it there,
      // and an upgrade handler that ignores it loses the first message — which
      // looks exactly like a client that never authenticated.
      attach(socket, head);
    },
  );

  function attach(socket: Duplex, head: Buffer): void {
    const reader = new MessageReader();
    const self: Peer = { socket, authenticated: false };
    const deadline = setTimeout(() => {
      if (!self.authenticated) socket.destroy();
    }, HELLO_TIMEOUT_MS);

    const feed = (chunk: Buffer): void => {
      let messages;
      try {
        messages = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const message of messages) {
        if (message.kind === "close") {
          socket.end(encodeClose());
          return;
        }
        if (message.kind === "ping") {
          socket.write(encodeFrame(0xa, message.data));
          continue;
        }
        if (message.kind !== "text") continue;
        handle(self, message.data.toString("utf8"));
      }
    };
    if (head && head.length > 0) feed(head);
    socket.on("data", feed);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(deadline);
      if (peer === self) peer = null;
    });
  }

  function handle(self: Peer, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      self.socket.destroy();
      return;
    }
    const envelope = parsed as Record<string, unknown>;
    if (!self.authenticated) {
      // The FIRST message must be the hello. Anything else on an
      // unauthenticated socket is dropped without an answer, so the channel
      // cannot be used to probe for which verbs exist.
      if (envelope.type !== "hello" || !tokenMatches(token, envelope.token)) {
        self.socket.destroy();
        return;
      }
      self.authenticated = true;
      peer?.socket.destroy();
      peer = self;
      send(self, { type: "ready" });
      return;
    }
    if (envelope.type === "notice") {
      // No answer, and no chance for a page to hold it up.
      if (
        typeof envelope.notice === "string" &&
        typeof envelope.nodeId === "string"
      ) {
        notice(envelope.notice, envelope.nodeId, envelope.detail);
      }
      return;
    }
    const request = parseDriveRequest(parsed);
    if (!request.ok) {
      const id = typeof envelope.id === "string" ? envelope.id : "";
      send(self, {
        id,
        ok: false,
        error: request.error,
      } satisfies DriveResponse);
      return;
    }
    void dispatch(self, request.request);
  }

  async function dispatch(
    self: Peer,
    request: {
      id: string;
      nodeId: string;
      verb: string;
      args: Record<string, unknown>;
    },
  ): Promise<void> {
    // A verb is bounded. A page that never settles must not hold the channel,
    // because the channel is one deep by design and the next verb behind it
    // would look like a hang rather than a slow page.
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("that page did not answer in time")),
        VERB_TIMEOUT_MS,
      );
    });
    try {
      const result = await Promise.race([run(request), bound]);
      send(self, { id: request.id, ok: true, result } satisfies DriveResponse);
    } catch (thrown) {
      const code =
        thrown && typeof thrown === "object" && "code" in thrown
          ? String((thrown as { code: unknown }).code)
          : DRIVE_CODES.failed;
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      send(self, {
        id: request.id,
        ok: false,
        error: driveError(code, message),
      } satisfies DriveResponse);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function send(self: Peer, payload: unknown): void {
    if (self.socket.destroyed) return;
    self.socket.write(encodeText(JSON.stringify(payload)));
  }

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      const bound = http.address();
      if (bound === null || typeof bound === "string") {
        reject(new Error("the drive channel could not bind a loopback port"));
        return;
      }
      resolve({
        address: driveAddress(bound.port),
        token,
        connected: () => peer !== null,
        publish: (event) => {
          if (peer) send(peer, event);
        },
        close: () => {
          peer?.socket.destroy();
          peer = null;
          http.close();
        },
      });
    });
  });
}
