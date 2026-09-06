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
  CheckForUpdateResponseSchema,
  ReleaseChannel,
  UpdateArtifactSchema,
  UpdateCheckState,
  UpdateSignatureState,
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

describe("desktop update checks", () => {
  it("distinguishes an unchecked update from an up-to-date one", () => {
    check("update_unsupported", CheckForUpdateResponseSchema, {
      state: UpdateCheckState.UNSUPPORTED,
      channel: ReleaseChannel.STABLE,
      installedVersion: { major: 0, minor: 1, patch: 0 },
      reasonCode: "UPDATES_NOT_CONFIGURED",
      checkedAtUnixMs: 1788557000000n,
    });
    check("update_available", CheckForUpdateResponseSchema, {
      state: UpdateCheckState.AVAILABLE,
      channel: ReleaseChannel.BETA,
      installedVersion: { major: 0, minor: 1, patch: 0 },
      release: {
        version: { major: 0, minor: 2, patch: 1, prerelease: "beta.1" },
        channel: ReleaseChannel.BETA,
        publishedAtUnixMs: 1788557900000n,
        notesUrl: "https://example.invalid/发布说明",
        compatibility: {
          minimumInstalled: { minor: 1 },
          maximumInstalled: { major: 1 },
          protocolMajor: 1,
          minimumProtocolMinor: 1,
        },
        artifacts: [
          {
            target: "darwin-aarch64",
            url: "https://example.invalid/Armadra.tar.gz",
            sizeBytes: 9007199254740993n,
            sha256: new Uint8Array(32).fill(4),
            signature: {
              state: UpdateSignatureState.PRESENT,
              value: "dW50cnVzdGVkIGNvbW1lbnQ",
              keyId: "key-1",
            },
          },
        ],
      },
      checkedAtUnixMs: 1788557900000n,
      retryAfterMs: 3600000n,
    });
    check("update_unconfigured_signature", UpdateArtifactSchema, {
      target: "windows-x86_64",
      url: "https://example.invalid/Armadra.msi",
      sizeBytes: 1n,
      sha256: new Uint8Array(32).fill(2),
      signature: { state: UpdateSignatureState.UNCONFIGURED },
    });
  });
});
