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
  AuthenticatedSessionSchema,
  HostControlRequestSchema,
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

describe("device identity and pairing", () => {
  it("binds bootstrap to Host, instance and origin and preserves device revision", () => {
    check("identity_bootstrap", HostControlRequestSchema, {
      requestId: "pair-1",
      action: {
        case: "bootstrap",
        value: {
          expectedHostId: "host-1",
          expectedInstanceId: "instance-1",
          origin: "https://armadra.example",
          deviceName: "手机📱",
          scopes: [
            { permission: "canvas:read" },
            { permission: "terminal:write", workspaceId: "workspace-1" },
          ],
        },
      },
    });
    check("identity_session", AuthenticatedSessionSchema, {
      hostId: "host-1",
      device: {
        deviceId: "device-1",
        principalId: "owner-1",
        displayName: "手机📱",
        role: "owner",
        createdAtUnixMs: 1788557000000n,
        revision: maxUint64,
      },
      scopes: [{ permission: "canvas:read" }],
      csrfToken: "fixture-not-a-secret",
      expiresAtUnixMs: 1788557900000n,
    });
  });
});
