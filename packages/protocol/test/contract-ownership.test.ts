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
  CanvasOwnershipOwner,
  CanvasOwnershipPhase,
  ConsistencyCheckSchema,
  GetOwnershipRequestSchema,
  GetOwnershipResponseSchema,
  HostControlRequestSchema,
  ListOwnershipRequestSchema,
  ListOwnershipResponseSchema,
  MaintenanceTicketRequestSchema,
  OwnershipReportSchema,
  OwnershipSwitchPlanSchema,
  OwnershipSwitchResponseSchema,
  RollbackOwnershipRequestSchema,
  SwitchOwnershipRequestSchema,
  WriteOwnershipDomain,
  WriteOwnershipSchema,
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

// Multi-domain write ownership (Go Host 业务所有权迁移 §2.2). The browser is
// the side that has to stop writing when a domain moves, so it decodes the
// same fixtures the Go and Rust sides do, and reads epochs as BigInt: an epoch
// past 2^53 that arrived as a JavaScript number would compare equal to the one
// before it.
describe("write ownership across the six domains", () => {
  it("keeps a record's domain, phase and watermark", () => {
    check("ownership_domain_record", WriteOwnershipSchema, {
      domain: WriteOwnershipDomain.AGENT,
      owner: CanvasOwnershipOwner.HOST,
      epoch: beyondDouble,
      phase: CanvasOwnershipPhase.SWITCHING,
      importId: "0123456789abcdef0123456789abcdef",
      eventSequence: maxUint64,
      reasonCode: "ownership.switch.pending",
      updatedAtUnixMs: 1788557900000n,
      revision: 3n,
    });
  });

  it("carries the dependencies a switch was allowed against", () => {
    check("ownership_switch_plan", OwnershipSwitchPlanSchema, {
      domain: WriteOwnershipDomain.SESSION,
      targetOwner: CanvasOwnershipOwner.HOST,
      expectedEpoch: beyondDouble,
      importId: "0123456789abcdef0123456789abcdef",
      dependencies: [
        {
          domain: WriteOwnershipDomain.CANVAS,
          owner: CanvasOwnershipOwner.HOST,
          epoch: 2n,
          phase: CanvasOwnershipPhase.SETTLED,
          revision: 1n,
        },
        {
          domain: WriteOwnershipDomain.FILESYSTEM,
          owner: CanvasOwnershipOwner.HOST,
          epoch: 4n,
          phase: CanvasOwnershipPhase.SETTLED,
          revision: 2n,
        },
      ],
      maintenanceToken: "fixture-not-a-secret",
    });
  });

  it("reports a refusal with the identifiers that differed", () => {
    check("ownership_report_refused", OwnershipReportSchema, {
      domain: WriteOwnershipDomain.CANVAS,
      importId: "0123456789abcdef0123456789abcdef",
      exportId: "导出-1",
      manifestSha256: new Uint8Array(32).fill(2),
      checks: [
        {
          check: "canvas.nodes",
          expectedCount: 2n,
          actualCount: 2n,
          matched: true,
        },
        {
          check: "canvas.assets",
          expectedCount: 1n,
          actualCount: 0n,
          matched: false,
          differences: ["asset-1"],
        },
      ],
      entityCount: beyondDouble,
      matched: false,
      verifiedAtUnixMs: 1788557900000n,
    });
    // A check that matched and one that did not are distinguishable without
    // reading the report's own summary flag.
    const refused = create(ConsistencyCheckSchema, { check: "canvas.assets" });
    expect(refused.matched).toBe(false);
  });

  it("asks for a maintenance window on the control channel", () => {
    check("ownership_maintenance_ticket", HostControlRequestSchema, {
      requestId: "maintenance-1",
      action: {
        case: "maintenance",
        value: create(MaintenanceTicketRequestSchema, {
          expectedHostId: "0123456789abcdef0123456789abcdef",
          expectedInstanceId: "abcdef0123456789abcdef0123456789",
          domain: "canvas",
        }),
      },
    });
  });

  it("never reads an unspecified domain as the canvas", () => {
    expect(WriteOwnershipDomain.UNSPECIFIED).toBe(0);
    expect(create(WriteOwnershipSchema, {}).domain).toBe(
      WriteOwnershipDomain.UNSPECIFIED,
    );
    expect([
      WriteOwnershipDomain.CANVAS,
      WriteOwnershipDomain.SETTINGS,
      WriteOwnershipDomain.FILESYSTEM,
      WriteOwnershipDomain.SESSION,
      WriteOwnershipDomain.AGENT,
      WriteOwnershipDomain.GIT,
    ]).toEqual([1, 2, 3, 4, 5, 6]);
    // A domain a newer Host introduced keeps its number instead of being
    // rounded down to one this build understands.
    const future = create(ListOwnershipResponseSchema, {
      ownership: [{ domain: 99 as WriteOwnershipDomain, epoch: 1n }],
    });
    const decoded = fromBinary(
      ListOwnershipResponseSchema,
      toBinary(ListOwnershipResponseSchema, future),
    );
    expect(decoded.ownership.at(0)?.domain).toBe(99);
  });

  it("keeps the switch and rollback envelopes apart", () => {
    const plan = {
      domain: WriteOwnershipDomain.CANVAS,
      targetOwner: CanvasOwnershipOwner.RUNTIME,
      expectedEpoch: 2n,
      maintenanceToken: "fixture-not-a-secret",
    };
    const wire = toBinary(
      RollbackOwnershipRequestSchema,
      create(RollbackOwnershipRequestSchema, {
        meta: { requestId: "rollback-1" },
        plan,
        acceptExportOnly: true,
      }),
    );
    const asSwitch = fromBinary(SwitchOwnershipRequestSchema, wire);
    expect(asSwitch.plan?.expectedEpoch).toBe(2n);
    // The accept-export-only flag is not a field of a switch: it survives as
    // an unknown field this runtime relays untouched, and never as a property
    // a caller could read as "the operator accepted an export-only rollback".
    expect(asSwitch.$unknown?.length ?? 0).toBeGreaterThan(0);
    expect("acceptExportOnly" in asSwitch).toBe(false);
    const empty = create(GetOwnershipResponseSchema, {});
    expect(toBinary(GetOwnershipResponseSchema, empty).length).toBe(0);
    const request = create(GetOwnershipRequestSchema, {
      meta: { requestId: "get-1" },
      domain: WriteOwnershipDomain.SETTINGS,
    });
    expect(
      fromBinary(
        GetOwnershipRequestSchema,
        toBinary(GetOwnershipRequestSchema, request),
      ).domain,
    ).toBe(WriteOwnershipDomain.SETTINGS);
    expect(
      toBinary(
        ListOwnershipRequestSchema,
        create(ListOwnershipRequestSchema, {}),
      ).length,
    ).toBe(0);
    const response = create(OwnershipSwitchResponseSchema, {
      ownership: {
        domain: WriteOwnershipDomain.CANVAS,
        epoch: 3n,
        revision: 4n,
      },
      plan,
    });
    expect(
      toBinary(OwnershipSwitchResponseSchema, response).length,
    ).toBeGreaterThan(0);
  });
});
