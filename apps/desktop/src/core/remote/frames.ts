/**
 * The frames a controller and a remote Worker exchange over `ssh` stdio.
 *
 * ## Why stdio frames rather than an SSH tunnel to a remote core's HTTP
 *
 * Two designs were available for the TypeScript port, and this file is the one
 * that was chosen. The comparison, so the next person does not have to redo
 * it:
 *
 * | | stdio frames (`ssh … node main.js worker --stdio`) | `ssh -L` tunnel to a remote core's HTTP |
 * | --- | --- | --- |
 * | Authentication | the SSH channel *is* the authentication; nothing else exists to get wrong | the remote HTTP surface needs its own credential — R1's whole identity story, minted and rotated across machines |
 * | Reachability | nothing listens on the far side | a listener exists; a unix socket keeps it to one user, a port does not |
 * | Lifetime | the Worker's stdin closes when the connection drops, so it exits with it | an orphaned remote core outlives the tunnel and has to be reaped |
 * | Failure classification | a write that never left is distinguishable from an answer that never came — which is what `UNKNOWN_OUTCOME` is | HTTP gives a client the same timeout for both, and a retried non-idempotent request is a second mutation |
 * | Port of the existing semantics | the pre-merge implementation translates line for line | every call site's error mapping is rewritten |
 *
 * The deciding one is the fourth. The remote contract's rule is that a request
 * which was written and then lost its answer is reported as `UNKNOWN_OUTCOME`
 * and **never re-sent**; only a read is replayed. A frame writer knows which
 * of the two happened. An HTTP client does not.
 *
 * The encoding changes from Protobuf to JSON, which costs nothing: the
 * envelope was typed by `proto/`, and `proto/` plus both generated copies are
 * deleted in R7 (design §7). The framing — a four-byte big-endian length then
 * that many bytes — is unchanged, so the two implementations' *transports* are
 * byte-compatible even though their payloads are not, and a mismatch is caught
 * by the handshake rather than by a decoder.
 */

/**
 * The ceiling on one frame, matching the Rust `worker::MAX_FRAME`. A request
 * over it is refused **before anything is written**, which is the only reason
 * `tooLarge` can be classified as "never ran".
 */
export const MAX_FRAME = 16 * 1024 * 1024;

/** One request to a Worker. */
export interface WorkerRequest {
  readonly requestId: string;
  readonly hostId: string;
  /**
   * Which Worker session this is aimed at. Empty until the handshake learns
   * it; from then on every answer has to carry the same value, so a
   * reconnected child cannot be mistaken for the one the request was for.
   */
  readonly expectedInstanceId: string;
  readonly deadlineUnixMs: number;
  readonly action: string;
  readonly payload?: unknown;
}

export interface WorkerResponse {
  /** Empty means the frame was not asked for — today only a watch event. */
  readonly requestId: string;
  readonly instanceId: string;
  readonly status?: number;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/** `<4-byte big-endian length><bytes>`. */
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([prefix, body]);
}

/**
 * Incremental decoder.
 *
 * A stdio read can end anywhere, including inside the length prefix, so the
 * buffer is kept across chunks. A zero length or one over {@link MAX_FRAME} is
 * a stream that cannot be trusted to resynchronise: the decoder says so and
 * the caller drops the connection, rather than skipping ahead to whatever byte
 * happens to look like a prefix next.
 */
export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);
  private poisoned = false;

  /** Feeds a chunk and returns every complete frame it completed. */
  push(chunk: Buffer): unknown[] {
    if (this.poisoned) return [];
    this.buffered =
      this.buffered.byteLength === 0
        ? chunk
        : Buffer.concat([this.buffered, chunk]);
    const frames: unknown[] = [];
    for (;;) {
      if (this.buffered.byteLength < 4) break;
      const length = this.buffered.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME) {
        this.poisoned = true;
        break;
      }
      if (this.buffered.byteLength < 4 + length) break;
      const body = this.buffered.subarray(4, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      try {
        frames.push(JSON.parse(body.toString("utf8")));
      } catch {
        // A frame that is the right length and not JSON is the same kind of
        // failure as a bad length: the far side is not speaking this protocol.
        this.poisoned = true;
        break;
      }
    }
    return frames;
  }

  /** Whether the stream has to be abandoned rather than read further. */
  get broken(): boolean {
    return this.poisoned;
  }
}

/**
 * Why a connection stopped being usable.
 *
 * Only `write` and `tooLarge` prove the request never reached the execution
 * host; `lost` is the one that becomes `UNKNOWN_OUTCOME` at the call site,
 * because the mutation may well have happened.
 */
export type TransportFailure = "write" | "lost" | "tooLarge";
