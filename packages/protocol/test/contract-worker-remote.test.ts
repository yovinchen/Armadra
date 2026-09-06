import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import {
  WorkerRequestSchema,
  WorkerResponseSchema,
  WorkerServiceOperation,
} from "../src/index.js";

// Remote execution completion, batches 4 and 5 (remote completion design
// §3.8). The browser is one end of the upload and the watch stream, so its
// encoding has to match the shared fixtures byte for byte rather than merely
// round-trip against itself.

function fixture(name: string): Uint8Array {
  const hex = readFileSync(
    new URL(`../../../proto/fixtures/${name}.hex`, import.meta.url),
    "utf8",
  ).trim();
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function check<T extends DescMessage>(
  name: string,
  schema: T,
  init: MessageInitShape<T>,
) {
  const expected = create(schema, init);
  const wire = fixture(name);
  expect(fromBinary(schema, wire)).toEqual(expected);
  expect(toBinary(schema, expected)).toEqual(wire);
}

const encoder = new TextEncoder();

// Walks a frame the way a foreign parser would, so an assertion about what is
// on the wire does not depend on what this library chooses to hand back.
function topLevelFieldNumbers(frame: Uint8Array): number[] {
  const numbers: number[] = [];
  let offset = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (offset >= frame.length) throw new Error("truncated varint");
      const byte = frame[offset++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
  };
  while (offset < frame.length) {
    const tag = varint();
    numbers.push(Number(tag >> 3n));
    switch (Number(tag & 7n)) {
      case 0:
        varint();
        break;
      case 1:
        offset += 8;
        break;
      case 2: {
        // Read the length before advancing: `offset += varint()` would use the
        // position from before the length itself was consumed.
        const length = Number(varint());
        offset += length;
        break;
      }
      case 5:
        offset += 4;
        break;
      default:
        throw new Error("unexpected wire type");
    }
  }
  return numbers;
}

describe("remote execution requests", () => {
  // The controller resolved the grants, but the Worker re-checks them on the
  // execution host, so both flags have to travel rather than be implied by the
  // operation number.
  it("carries the grants the controller resolved on a repository read", () => {
    check("worker_service_branches", WorkerRequestSchema, {
      requestId: "branches-1",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1_788_557_900_000n,
      action: {
        case: "service",
        value: {
          rootId: "root-1",
          operation: WorkerServiceOperation.GIT_BRANCHES,
          requestJson: encoder.encode('{"path":"."}'),
          allowExecute: true,
        },
      },
    });
  });

  // Starting a queued Git operation is a write *and* an execution. A request
  // that carries only one of the two is refused on the host, so the pair has
  // to stay independently representable instead of collapsing into one grant.
  it("needs both grants to start a queued operation", () => {
    check("worker_service_operation_start", WorkerRequestSchema, {
      requestId: "queue-1",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1_788_557_900_000n,
      action: {
        case: "service",
        value: {
          rootId: "root-1",
          operation: WorkerServiceOperation.GIT_OPERATION_START,
          requestJson: encoder.encode(
            '{"path":".","action":{"kind":"fetch"},"expected":{"head":"HEAD"}}',
          ),
          allowWrite: true,
          allowExecute: true,
        },
      },
    });
  });

  // Deleting to the trash is a move under the execution host's own
  // `.armadra/trash/`, and the number that does it must not be confused with
  // the read that lists what is in there: the two have opposite replay rules.
  it("sends a trash delete as a write under its own number", () => {
    check("worker_service_trash", WorkerRequestSchema, {
      requestId: "trash-1",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1_788_557_900_000n,
      action: {
        case: "service",
        value: {
          rootId: "root-1",
          operation: WorkerServiceOperation.FILE_ENTRY_DELETE,
          requestJson: encoder.encode('{"path":"文档/草稿.md"}'),
          allowWrite: true,
        },
      },
    });
  });

  // Subscribing names the paths, and unsubscribing names them too, because one
  // root can have several editors open: closing one must not blind the others.
  it("names the watched paths on a subscribe", () => {
    check("worker_watch_subscribe", WorkerRequestSchema, {
      requestId: "watch-1",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1_788_557_900_000n,
      action: {
        case: "watch",
        value: {
          rootId: "root-1",
          operation: WorkerServiceOperation.WATCH_SUBSCRIBE,
          paths: ["README.md", "文档/草稿.md"],
        },
      },
    });
  });

  // Begin carries the whole-file digest so the Worker can refuse at the end
  // rather than publish bytes nobody vouched for.
  it("begins an upload with the digest it will be held to", () => {
    check("worker_upload_begin", WorkerRequestSchema, {
      requestId: "upload-1",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1_788_557_900_000n,
      action: {
        case: "upload",
        value: {
          step: {
            case: "begin",
            value: {
              rootId: "root-1",
              path: ".armadra/assets/图片.png",
              totalBytes: 3_145_728n,
              sha256:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              overwriteSha256:
                "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
              allowWrite: true,
            },
          },
        },
      },
    });
  });

  // A create-only begin leaves `overwrite_sha256` absent. Absent and
  // present-but-empty must not collapse into each other: one refuses an
  // existing file, the other would claim it had an empty version.
  it("leaves the overwrite digest absent on a create-only upload", () => {
    check("worker_upload_begin_new", WorkerRequestSchema, {
      requestId: "upload-2",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1_788_557_900_000n,
      action: {
        case: "upload",
        value: {
          step: {
            case: "begin",
            value: {
              rootId: "root-1",
              path: "new.bin",
              totalBytes: 0n,
              sha256:
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              allowWrite: true,
            },
          },
        },
      },
    });
    const decoded = fromBinary(
      WorkerRequestSchema,
      fixture("worker_upload_begin_new"),
    );
    expect(decoded.action.case).toBe("upload");
    const upload =
      decoded.action.case === "upload" ? decoded.action.value : undefined;
    expect(upload?.step.case).toBe("begin");
    const begin = upload?.step.case === "begin" ? upload.step.value : undefined;
    expect(begin?.overwriteSha256).toBeUndefined();
  });

  // Offsets are file positions, not chunk indices, so one past a 32-bit file
  // has to encode without wrapping. The payload keeps NUL and newline bytes to
  // prove the field is never treated as text on the way through.
  it("addresses upload bytes beyond a 32-bit file", () => {
    check("worker_upload_chunk", WorkerRequestSchema, {
      requestId: "upload-3",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1_788_557_900_000n,
      action: {
        case: "upload",
        value: {
          step: {
            case: "chunk",
            value: {
              uploadId: "u-0123456789abcdef",
              offset: 4_294_967_295n,
              data: new Uint8Array([0, 255, 27, 10]),
            },
          },
        },
      },
    });
  });

  // Commit and abort are the same shape and differ only by their oneof number.
  // Reading one as the other would either publish a half-written file or
  // discard a finished one, so the two must never share a tag.
  it("keeps commit and abort distinct steps of the same upload", () => {
    check("worker_upload_commit", WorkerRequestSchema, {
      requestId: "upload-4",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1_788_557_900_000n,
      action: {
        case: "upload",
        value: {
          step: { case: "commit", value: { uploadId: "u-0123456789abcdef" } },
        },
      },
    });
    check("worker_upload_abort", WorkerRequestSchema, {
      requestId: "upload-5",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1_788_557_900_000n,
      action: {
        case: "upload",
        value: {
          step: { case: "abort", value: { uploadId: "u-0123456789abcdef" } },
        },
      },
    });
  });
});

describe("remote execution responses", () => {
  // A remote failure keeps the status the same operation would have returned
  // over the Runtime's own HTTP surface. An operation this build has never
  // heard of has to come back as "unsupported" rather than as a generic 500,
  // which a controller would retry.
  it("answers an unsupported operation with its own status", () => {
    check("worker_service_unknown_operation", WorkerResponseSchema, {
      requestId: "unknown-1",
      hostId: "0123456789abcdef0123456789abcdef",
      instanceId: "abcdef0123456789abcdef0123456789",
      result: {
        case: "service",
        value: {
          httpStatus: 501,
          responseJson: encoder.encode(
            '{"code":"unsupported","message":"未知操作"}',
          ),
        },
      },
    });
  });

  // The contract version is what replaced the exact `runtime_version` match
  // (§3.5), so the two have to be separately representable: this Worker is a
  // different patch build that still speaks contract 1 and stays usable.
  it("separates the service contract from the build in the handshake", () => {
    check("worker_hello_contract", WorkerResponseSchema, {
      requestId: "hello-1",
      hostId: "0123456789abcdef0123456789abcdef",
      instanceId: "abcdef0123456789abcdef0123456789",
      result: {
        case: "hello",
        value: {
          protocol: { major: 1 },
          hostId: "0123456789abcdef0123456789abcdef",
          instanceId: "abcdef0123456789abcdef0123456789",
          platform: "linux",
          architecture: "aarch64",
          capabilities: [
            "remote.execution.v1",
            "remote.git.panel.v1",
            "remote.files.manage.v1",
            "remote.upload.v1",
            "remote.watch.v1",
          ],
          maxFrameBytes: 1 << 20,
          maxFileChunkBytes: 256 << 10,
          maxTextFileBytes: 1 << 20,
          runtimeVersion: "0.1.1",
          serviceContractVersion: 1,
        },
      },
    });
  });

  // The receipt answers with the cursor the next event will carry, so a
  // reconnect knows where the new stream starts instead of guessing from the
  // sequence the old connection ended on.
  it("answers a subscribe with the cursor the next event will carry", () => {
    check("worker_watch_receipt", WorkerResponseSchema, {
      requestId: "watch-1",
      hostId: "0123456789abcdef0123456789abcdef",
      instanceId: "abcdef0123456789abcdef0123456789",
      result: {
        case: "watch",
        value: { rootId: "root-1", watchedPaths: 2, sequence: 1n },
      },
    });
  });

  // The sequence has to survive past 2^53, which is exactly where a plain
  // JavaScript number would round two neighbouring events into one and hide a
  // gap the controller is supposed to reconcile.
  it("reports changes and removals on an unsolicited watch event", () => {
    check("worker_watch_event", WorkerResponseSchema, {
      hostId: "0123456789abcdef0123456789abcdef",
      instanceId: "abcdef0123456789abcdef0123456789",
      result: {
        case: "watchEvent",
        value: {
          rootId: "root-1",
          sequence: 9_007_199_254_740_993n,
          changes: [
            {
              path: "README.md",
              kind: "modified",
              sha256: "abc",
              size: 12n,
              mtime: "2026-09-06T00:00:00Z",
            },
            // A removal has no digest, size or mtime to report, and an empty
            // digest must not read as "hashed to nothing".
            { path: "文档/草稿.md", kind: "removed" },
          ],
        },
      },
    });
  });

  // The commit receipt reports the destination the file actually landed on,
  // not the one the caller asked for: the Worker resolves it against its own
  // root, and the caller has no other way to learn where the bytes went.
  it("reports the destination the Worker chose", () => {
    check("worker_upload_receipt", WorkerResponseSchema, {
      requestId: "upload-4",
      hostId: "0123456789abcdef0123456789abcdef",
      instanceId: "abcdef0123456789abcdef0123456789",
      result: {
        case: "upload",
        value: {
          uploadId: "u-0123456789abcdef",
          receivedBytes: 3_145_728n,
          sha256:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          path: ".armadra/assets/图片.png",
        },
      },
    });
  });

  // An unsolicited frame is exactly "a response with no request_id". If an
  // empty request_id ever started being serialized, a controller's
  // demultiplexer would see a reply to a request nobody made, so field 1 has
  // to be absent from the bytes rather than merely empty after decoding.
  it("sends a watch event with no request id at all", () => {
    const encoded = toBinary(
      WorkerResponseSchema,
      create(WorkerResponseSchema, {
        instanceId: "abcdef0123456789abcdef0123456789",
        result: {
          case: "watchEvent",
          value: { rootId: "root-1", sequence: 1n },
        },
      }),
    );
    expect(fromBinary(WorkerResponseSchema, encoded).requestId).toBe("");
    expect(topLevelFieldNumbers(encoded)).not.toContain(1);
  });
});

// The numbers are the contract; a renamed constant that moved would be a
// silently different operation on the other machine.
describe("service operation numbers", () => {
  it("are frozen", () => {
    expect({
      GIT_REPOSITORIES: WorkerServiceOperation.GIT_REPOSITORIES,
      GIT_BRANCHES: WorkerServiceOperation.GIT_BRANCHES,
      GIT_HISTORY: WorkerServiceOperation.GIT_HISTORY,
      GIT_COMMIT_DETAIL: WorkerServiceOperation.GIT_COMMIT_DETAIL,
      GIT_COMMIT_FILE_DIFF: WorkerServiceOperation.GIT_COMMIT_FILE_DIFF,
      GIT_WORKTREES: WorkerServiceOperation.GIT_WORKTREES,
      GIT_REBASE_TODO: WorkerServiceOperation.GIT_REBASE_TODO,
      GIT_TAGS: WorkerServiceOperation.GIT_TAGS,
      GIT_REMOTES: WorkerServiceOperation.GIT_REMOTES,
      GIT_STASHES: WorkerServiceOperation.GIT_STASHES,
      GIT_STASH_DETAIL: WorkerServiceOperation.GIT_STASH_DETAIL,
      GIT_INTEGRATION: WorkerServiceOperation.GIT_INTEGRATION,
      GIT_CHERRY_PICK_PREVIEW: WorkerServiceOperation.GIT_CHERRY_PICK_PREVIEW,
      GIT_HUNKS: WorkerServiceOperation.GIT_HUNKS,
      GIT_MESSAGE_SOURCE: WorkerServiceOperation.GIT_MESSAGE_SOURCE,
      GIT_OPERATIONS: WorkerServiceOperation.GIT_OPERATIONS,
      GIT_OPERATION_GET: WorkerServiceOperation.GIT_OPERATION_GET,
      GIT_OPERATION_START: WorkerServiceOperation.GIT_OPERATION_START,
      GIT_OPERATION_CANCEL: WorkerServiceOperation.GIT_OPERATION_CANCEL,
      GIT_APPLY_HUNK: WorkerServiceOperation.GIT_APPLY_HUNK,
      FILE_ENTRY_TRASH_LIST: WorkerServiceOperation.FILE_ENTRY_TRASH_LIST,
      FILE_INFO: WorkerServiceOperation.FILE_INFO,
      FILE_ENTRY_CREATE: WorkerServiceOperation.FILE_ENTRY_CREATE,
      FILE_ENTRY_RENAME: WorkerServiceOperation.FILE_ENTRY_RENAME,
      FILE_ENTRY_MOVE: WorkerServiceOperation.FILE_ENTRY_MOVE,
      FILE_ENTRY_DELETE: WorkerServiceOperation.FILE_ENTRY_DELETE,
      FILE_ENTRY_RESTORE: WorkerServiceOperation.FILE_ENTRY_RESTORE,
      ASSET_IMPORT: WorkerServiceOperation.ASSET_IMPORT,
      WATCH_SUBSCRIBE: WorkerServiceOperation.WATCH_SUBSCRIBE,
      WATCH_UNSUBSCRIBE: WorkerServiceOperation.WATCH_UNSUBSCRIBE,
    }).toEqual({
      GIT_REPOSITORIES: 19,
      GIT_BRANCHES: 20,
      GIT_HISTORY: 21,
      GIT_COMMIT_DETAIL: 22,
      GIT_COMMIT_FILE_DIFF: 23,
      GIT_WORKTREES: 24,
      GIT_REBASE_TODO: 25,
      GIT_TAGS: 26,
      GIT_REMOTES: 27,
      GIT_STASHES: 28,
      GIT_STASH_DETAIL: 29,
      GIT_INTEGRATION: 30,
      GIT_CHERRY_PICK_PREVIEW: 31,
      GIT_HUNKS: 32,
      GIT_MESSAGE_SOURCE: 33,
      GIT_OPERATIONS: 34,
      GIT_OPERATION_GET: 35,
      GIT_OPERATION_START: 36,
      GIT_OPERATION_CANCEL: 37,
      GIT_APPLY_HUNK: 38,
      FILE_ENTRY_TRASH_LIST: 39,
      FILE_INFO: 40,
      FILE_ENTRY_CREATE: 41,
      FILE_ENTRY_RENAME: 42,
      FILE_ENTRY_MOVE: 43,
      FILE_ENTRY_DELETE: 44,
      FILE_ENTRY_RESTORE: 45,
      ASSET_IMPORT: 46,
      WATCH_SUBSCRIBE: 47,
      WATCH_UNSUBSCRIBE: 48,
    });
  });
});
