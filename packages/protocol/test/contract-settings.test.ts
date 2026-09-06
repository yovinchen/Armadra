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
  EventDomain,
  EventEnvelopeSchema,
  EventPriority,
  ExecutionHostKind,
  ExecutionHostSchema,
  GetSettingsRequestSchema,
  GetSettingsResponseSchema,
  PutSettingsRequestSchema,
  PutSettingsResponseSchema,
  SettingsDocumentSchema,
  SettingsScope,
  SshExecutionHostSchema,
  WorkerLocalSettingsSchema,
  WorkerRequestSchema,
  WorkerResponseSchema,
  WorkerSettingsDirection,
  WorkerSettingsRequestSchema,
  WorkerSettingsSnapshotSchema,
} from "../src/index.js";

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

const beyondDouble = 9_007_199_254_740_993n;
const maxUint64 = 18_446_744_073_709_551_615n;
const document = new TextEncoder().encode(
  '{"terminal":{"backend":"tmux"},"主题":"深色"}',
);
const digest = new Uint8Array(32).fill(3);

// The settings domain (Go Host 业务所有权迁移 §2.4). The browser is the side
// that reads the document and saves it back, so it decodes the same fixtures
// the Go and Rust sides do.
//
// The document travels as bytes on purpose. A settings page that re-serialized
// a parsed object before saving would produce a different digest from the one
// the Runtime wrote, and every consistency check across the switch would then
// fail for a reason that has nothing to do with the settings.
describe("the settings document", () => {
  it("carries opaque bytes, a digest and one revision for the whole object", () => {
    check("settings_document_global", SettingsDocumentSchema, {
      scope: SettingsScope.GLOBAL,
      document,
      sha256: digest,
      schemaVersion: 1,
      updatedAtUnixMs: 1788557900000n,
      revision: beyondDouble,
    });
  });

  it("keeps a device overlay a distinct scope that names its device", () => {
    check("settings_document_device", SettingsDocumentSchema, {
      scope: SettingsScope.DEVICE,
      deviceId: "0123456789abcdef0123456789abcdef",
      document: new TextEncoder().encode(
        '{"keymap":{"mac":{"canvas.tidy":"Mod+Shift+K"}}}',
      ),
      sha256: new Uint8Array(32).fill(4),
      schemaVersion: 1,
      revision: 1n,
    });
  });

  it("does not read an unset scope as the global document", () => {
    const empty = create(SettingsDocumentSchema, {});
    expect(empty.scope).toBe(SettingsScope.UNSPECIFIED);
    expect(create(ExecutionHostSchema, {}).kind).toBe(
      ExecutionHostKind.UNSPECIFIED,
    );
    expect(create(WorkerSettingsRequestSchema, {}).direction).toBe(
      WorkerSettingsDirection.UNSPECIFIED,
    );
  });
});

describe("execution hosts projected from the document", () => {
  it("keeps an SSH target's identity, path and revision", () => {
    check("settings_execution_host_ssh", ExecutionHostSchema, {
      executionHostId: "盒子-1",
      name: "构建机",
      kind: ExecutionHostKind.SSH,
      ssh: create(SshExecutionHostSchema, {
        host: "example.com",
        port: 2222,
        user: "ada",
        identityFile: "~/.ssh/id_ed25519",
        workerPath: "/opt/armadra/armadra-runtime",
        stateDir: "/var/lib/armadra",
      }),
      updatedAtUnixMs: 1788557900000n,
      revision: maxUint64,
    });
  });

  it("leaves the local host's identifier empty", () => {
    check("settings_execution_host_local", ExecutionHostSchema, {
      kind: ExecutionHostKind.LOCAL,
      name: "本机",
      revision: 2n,
    });
  });
});

describe("the HTTPS settings surface", () => {
  it("answers a read with the document, its hosts and its sequence", () => {
    check("settings_get_response", GetSettingsResponseSchema, {
      document: create(SettingsDocumentSchema, {
        scope: SettingsScope.GLOBAL,
        document,
        sha256: digest,
        schemaVersion: 1,
        revision: 4n,
      }),
      executionHosts: [
        create(ExecutionHostSchema, {
          executionHostId: "盒子-1",
          kind: ExecutionHostKind.SSH,
          revision: 4n,
        }),
      ],
      eventSequence: beyondDouble,
    });
    // The read request itself is a scope and nothing else; a client that
    // named no scope would be asking for whichever document the Host felt
    // like, so UNSPECIFIED has to stay refusable rather than default.
    expect(create(GetSettingsRequestSchema, {}).scope).toBe(
      SettingsScope.UNSPECIFIED,
    );
  });

  it("states revision 0 for a document that has never been written", () => {
    check("settings_put_create", PutSettingsRequestSchema, {
      meta: {
        requestId: "settings-1",
        scope: { hostId: "0123456789abcdef0123456789abcdef" },
      },
      operationId: "settings/global/0",
      expectedRevision: 0n,
      document: create(SettingsDocumentSchema, {
        scope: SettingsScope.GLOBAL,
        document,
        sha256: digest,
        schemaVersion: 1,
      }),
    });
  });

  it("answers a save with the stored document and its receipt", () => {
    check("settings_put_response", PutSettingsResponseSchema, {
      document: create(SettingsDocumentSchema, {
        scope: SettingsScope.GLOBAL,
        document,
        sha256: digest,
        schemaVersion: 1,
        revision: 5n,
      }),
      receipt: {
        operationId: "settings/global/4",
        transactionId: 12n,
        firstSequence: 30n,
        lastSequence: 31n,
      },
    });
  });
});

describe("the Worker settings frame", () => {
  it("names the export direction rather than implying it from an empty body", () => {
    check("settings_worker_export", WorkerRequestSchema, {
      requestId: "settings-export-1",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1788557900000n,
      action: {
        case: "settings",
        value: create(WorkerSettingsRequestSchema, {
          direction: WorkerSettingsDirection.EXPORT,
        }),
      },
    });
  });

  it("carries the document, the epoch and the import identity on the way back", () => {
    check("settings_worker_import", WorkerRequestSchema, {
      requestId: "settings-import-1",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1788557900000n,
      action: {
        case: "settings",
        value: create(WorkerSettingsRequestSchema, {
          direction: WorkerSettingsDirection.IMPORT,
          document: create(SettingsDocumentSchema, {
            scope: SettingsScope.GLOBAL,
            document,
            sha256: digest,
            schemaVersion: 1,
            revision: 6n,
          }),
          expectedEpoch: 2n,
          importId: "0123456789abcdef0123456789abcdef",
        }),
      },
    });
  });

  it("reports what the execution host actually holds, local settings included", () => {
    check("settings_worker_snapshot", WorkerResponseSchema, {
      requestId: "settings-import-1",
      hostId: "0123456789abcdef0123456789abcdef",
      instanceId: "abcdef0123456789abcdef0123456789",
      result: {
        case: "settings",
        value: create(WorkerSettingsSnapshotSchema, {
          document: create(SettingsDocumentSchema, {
            scope: SettingsScope.GLOBAL,
            document,
            sha256: digest,
            schemaVersion: 1,
          }),
          local: create(WorkerLocalSettingsSchema, {
            terminalBackend: "tmux",
            browserAvailable: true,
            powerPolicy: "manual",
            pathAugmented: true,
          }),
          executionHosts: [
            create(ExecutionHostSchema, {
              executionHostId: "盒子-1",
              kind: ExecutionHostKind.SSH,
              ssh: create(SshExecutionHostSchema, {
                host: "example.com",
                workerPath: "/opt/armadra/armadra-runtime",
              }),
            }),
          ],
          applied: true,
        }),
      },
    });
  });
});

describe("settings on the shared event stream", () => {
  it("publishes a host-wide envelope with no workspace", () => {
    const envelope = fromBinary(
      EventEnvelopeSchema,
      fixture("settings_event_envelope"),
    );
    // Host-wide, so no workspace. A client admits it on the settings grant
    // alone; attributing it to one workspace would hide the change from every
    // other one it follows.
    expect(envelope.workspaceId).toBe("");
    expect(envelope.domain).toBe(EventDomain.SETTINGS);
    expect(envelope.kind).toBe("document");
    expect(envelope.priority).toBe(EventPriority.NORMAL);
    expect(envelope.entity.case).toBe("settingsDocument");
    if (envelope.entity.case !== "settingsDocument")
      throw new Error("unreachable");
    expect(envelope.entity.value.document).toEqual(document);
    expect(envelope.entity.value.revision).toBe(5n);
  });
});
