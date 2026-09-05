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
  CheckForUpdateRequestSchema,
  ReleaseChannel,
  UpdateArtifactSchema,
  UpdateSignatureState,
} from "../src/index.js";

// Protocol minor 2 adds `component` to the update artifact and the check
// request (design docs/design/updates-and-service-install.md §1.5). The
// fixtures are the same bytes the Go and Rust suites read.
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

describe("update component, protocol minor 2", () => {
  it("names the program a release artifact carries", () => {
    check("update_component_request", CheckForUpdateRequestSchema, {
      meta: { requestId: "更新检查" },
      channel: ReleaseChannel.BETA,
      installedVersion: { major: 0, minor: 2, patch: 0 },
      target: "linux-x86_64",
      component: "host",
    });
    check("update_component_artifact", UpdateArtifactSchema, {
      target: "windows-aarch64",
      url: "https://example.invalid/armadra-host_0.2.0_windows-aarch64.zip",
      sizeBytes: 9007199254740993n,
      sha256: new Uint8Array(32).fill(6),
      signature: {
        state: UpdateSignatureState.PRESENT,
        value: "dW50cnVzdGVkIGNvbW1lbnQ",
        keyId: "key-2",
      },
      component: "host",
    });
    // One manifest serves every platform: a component with no target. A
    // reader that matched on target alone would drop it or claim it for one.
    check("update_manifest_artifact", UpdateArtifactSchema, {
      url: "https://example.invalid/latest.json",
      sizeBytes: 2048n,
      sha256: new Uint8Array(32).fill(9),
      signature: { state: UpdateSignatureState.ABSENT },
      component: "manifest",
    });
  });

  it("costs nothing on the wire when the publisher did not say", () => {
    const absent = create(UpdateArtifactSchema, {
      target: "darwin-aarch64",
      url: "https://example.invalid/Armadra_0.2.0_darwin-aarch64.tar.gz",
      sizeBytes: 12n,
    });
    const wire = toBinary(UpdateArtifactSchema, absent);
    expect(fromBinary(UpdateArtifactSchema, wire).component).toBe("");
    const named = create(UpdateArtifactSchema, {
      ...absent,
      component: "worker",
    });
    // Tag, length, six characters: a minor 1 encoder and a minor 2 encoder
    // that was told no component produce byte-identical output.
    expect(toBinary(UpdateArtifactSchema, named).length).toBe(wire.length + 8);
  });
});
