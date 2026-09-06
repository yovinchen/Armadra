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
  AutomationCommandSessionSchema,
  AutomationCommandSessionState,
  type AutomationOutcome,
  AutomationPlanSnapshotSchema,
  AutomationPlanState,
  AutomationReceiptSchema,
  AutomationRunSchema,
  AutomationRunState,
  DefineAutomationRequestSchema,
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

const maxUint64 = 18_446_744_073_709_551_615n;

describe("automation plans, runs and receipts", () => {
  it("preserves unknown executor outcomes and irreversible delivery evidence", () => {
    check("automation_unknown_receipt", AutomationReceiptSchema, {
      operationId: "operation-1",
      requestSha256: new Uint8Array(32).fill(7),
      outcome: 999 as AutomationOutcome,
      sequence: maxUint64,
      observedAtUnixMs: 1788557900000n,
    });
    check("automation_delivery_evidence", AutomationRunSchema, {
      id: "run-1",
      planId: "plan-1",
      workspaceId: "workspace-1",
      configVersion: 9007199254740993n,
      state: AutomationRunState.UNKNOWN,
      deliveryObserved: true,
    });
  });

  it("keeps the authenticated automation surface byte-identical across runtimes", () => {
    check("automation_command_session", AutomationCommandSessionSchema, {
      sessionId: "session/夜间",
      workspaceId: "workspace-1",
      executionHostId: "0123456789abcdef0123456789abcdef",
      rootPath: "/项目/仓库",
      launch: {
        executable: "/bin/echo",
        args: ["--flag", "值📦"],
        workingDirectory: ".",
        accountId: "default",
        timeoutMs: 86_400_000n,
      },
      generation: maxUint64,
      launchSha256: new Uint8Array(32).fill(9),
      state: AutomationCommandSessionState.UNREBUILDABLE,
      reasonCode: "GENERATION_CHANGED",
      revision: 9007199254740993n,
      createdAtUnixMs: 1788557000000n,
      updatedAtUnixMs: 1788557900000n,
    });
    check("automation_define_request", DefineAutomationRequestSchema, {
      meta: {
        requestId: "define-1",
        scope: {
          hostId: "0123456789abcdef0123456789abcdef",
          workspaceId: "workspace-1",
          executionHostId: "0123456789abcdef0123456789abcdef",
        },
      },
      planId: "plan-1",
      config: {
        workspaceId: "workspace-1",
        title: "每晚构建",
        target: {
          executionHostId: "0123456789abcdef0123456789abcdef",
          sessionId: "session-1",
          generation: 1n,
        },
        schedule: {
          kind: {
            case: "cron",
            value: { expression: "0 3 * * *", timezone: "Asia/Shanghai" },
          },
        },
      },
      payload: new Uint8Array([0x00, 0x9f, 0x99, 0x82]),
      expectedRevision: 9007199254740993n,
    });
    check("automation_plan_snapshot", AutomationPlanSnapshotSchema, {
      plan: {
        id: "plan-1",
        configVersion: 2n,
        state: AutomationPlanState.ACTIVE,
      },
      revision: maxUint64,
      configSha256: new Uint8Array(32).fill(3),
    });
    check("automation_needs_attention", AutomationPlanSnapshotSchema, {
      plan: {
        id: "plan-1",
        configVersion: 2n,
        state: AutomationPlanState.ACTIVE,
        needsAttention: true,
        attentionReasonCode: "TARGET_UNSUPPORTED",
        attentionStreak: 4294967295,
      },
      revision: maxUint64,
      configSha256: new Uint8Array(32).fill(3),
    });
  });
});
