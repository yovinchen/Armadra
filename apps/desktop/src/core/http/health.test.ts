import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILD, instanceId } from "../instance";
import { NO_HOOK_SERVICE, healthDocument } from "./health";

const here = dirname(fileURLToPath(import.meta.url));

describe("the health document", () => {
  it("reports the fields, in the order, the Rust Runtime reports them", () => {
    const document = healthDocument({
      version: "0.1.0",
      hookHealth: () => NO_HOOK_SERVICE,
    });
    expect(Object.keys(document)).toEqual([
      "status",
      "version",
      "instanceId",
      "build",
      "hook",
    ]);
    expect(document.status).toBe("ok");
    expect(document.instanceId).toBe(instanceId());
    expect(document.build).toBe(BUILD);
  });

  it("declares the same field names the Rust struct does", () => {
    const rust = readFileSync(
      resolve(here, "../../../../runtime/src/api/health.rs"),
      "utf8",
    );
    for (const field of ["status", "version", "instance_id", "build", "hook"]) {
      expect(rust).toContain(`${field}:`);
    }
    expect(rust).toContain('rename_all = "camelCase"');
  });

  it("reports a core with no hook service as not ok, with no transport", () => {
    // R0 has none. A core whose endpoint file does not name it reports the
    // same thing, which is exactly the honest answer.
    expect(NO_HOOK_SERVICE).toEqual({ ok: false });
    const document = healthDocument({
      version: "0.1.0",
      hookHealth: () => NO_HOOK_SERVICE,
    });
    expect(JSON.stringify(document.hook)).toBe('{"ok":false}');
  });

  it("passes a real hook section through untouched, for R3", () => {
    const document = healthDocument({
      version: "0.1.0",
      hookHealth: () => ({ sock: "/tmp/hook.sock", port: 43120, ok: true }),
    });
    expect(document.hook).toEqual({
      sock: "/tmp/hook.sock",
      port: 43120,
      ok: true,
    });
  });

  it("answers with the version it was told, not a hard-coded one", () => {
    expect(
      healthDocument({ version: "9.9.9", hookHealth: () => NO_HOOK_SERVICE })
        .version,
    ).toBe("9.9.9");
  });
});
