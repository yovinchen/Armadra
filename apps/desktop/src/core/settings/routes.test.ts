/**
 * The settings and execution-host routes.
 *
 * Ported from the handler assertions in `apps/runtime/src/api/settings.rs` and
 * `apps/runtime/src/api/execution_hosts.rs`. The two refusals `patch_settings`
 * makes before the merge are here because `normalize` would otherwise snap the
 * value back to a default and the page's dropdown would disagree with the
 * stored document without anybody being told.
 */

import { describe, expect, it } from "vitest";

import { emptyRequest, type CoreRequest } from "../http/router";
import {
  deleteExecutionHost,
  exportExecutionHosts,
  importExecutionHosts,
  listExecutionHosts,
  putExecutionHost,
  type ExecutionHostDeps,
} from "./execution-hosts";
import type { JsonObject, JsonValue } from "./local";
import { getLocalSettings, getSettings, patchSettings } from "./routes";
import { SettingsStore } from "./store";

function request(body: JsonValue): CoreRequest {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  return {
    ...emptyRequest("POST", "/"),
    body: encoded,
    json: <T>() => JSON.parse(encoded.toString("utf8")) as T,
  };
}

function rawRequest(text: string): CoreRequest {
  const encoded = Buffer.from(text, "utf8");
  return {
    ...emptyRequest("POST", "/"),
    body: encoded,
    json: <T>() => JSON.parse(encoded.toString("utf8")) as T,
  };
}

function deps(document: JsonValue = {}) {
  const settings = SettingsStore.inMemory(document);
  return { settings, workerSettingsFile: "/data/worker-settings.json" };
}

function hostDeps(
  document: JsonValue = {},
  counts: Iterable<[string, number]> = [],
): ExecutionHostDeps {
  return {
    settings: SettingsStore.inMemory(document),
    workspaceCounts: () => new Map(counts),
  };
}

function list(result: { body?: unknown }): JsonObject[] {
  return result.body as JsonObject[];
}

describe("GET /api/settings", () => {
  it("answers the merged document, unknown keys and all", () => {
    const answer = getSettings(deps({ theme: "dark" }));
    expect(answer.status).toBe(200);
    const body = answer.body as JsonObject;
    expect(body.theme).toBe("dark");
    expect((body.terminal as JsonObject).backend).toBe("auto");
  });

  it("says where the local half lives rather than implying it", () => {
    const answer = getLocalSettings(deps());
    const body = answer.body as JsonObject;
    expect(body.file).toBe("/data/worker-settings.json");
    expect(body.paths).toEqual([
      "terminal.backend",
      "browser.executablePath",
      "power.policy",
      "agents.probes",
      "language.probes",
      "language.servers",
    ]);
  });
});

describe("PATCH /api/settings", () => {
  it("merges and answers the whole document", () => {
    const answer = patchSettings(
      deps({ theme: "dark" }),
      request({ terminal: { backend: "direct" } }),
    );
    expect(answer.status).toBe(200);
    const body = answer.body as JsonObject;
    expect((body.terminal as JsonObject).backend).toBe("direct");
    expect(body.theme).toBe("dark");
  });

  it("refuses a body that is not an object", () => {
    for (const body of [[], "text", 7, null] as JsonValue[]) {
      const answer = patchSettings(deps(), request(body));
      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({
        code: "bad_request",
        message: "Settings patch must be an object",
      });
    }
    // An empty body is the same refusal: there is nothing to merge.
    expect(patchSettings(deps(), emptyRequest("PATCH", "/api/settings")).status).toBe(400);
  });

  it("refuses a body that is not JSON", () => {
    const answer = patchSettings(deps(), rawRequest("{ not json"));
    expect(answer.status).toBe(400);
    expect((answer.body as JsonObject).code).toBe("bad_request");
  });

  /**
   * Both are closed choice lists `normalize` would silently snap back to a
   * default. A settings page whose dropdown said one thing while the stored
   * value said another is worse than a refusal naming the field.
   */
  it("names a terminal backend and a log retention it does not offer", () => {
    expect(
      patchSettings(deps(), request({ terminal: { backend: "screen" } })).body,
    ).toEqual({ code: "bad_request", message: "Unknown terminal backend" });
    expect(patchSettings(deps(), request({ logs: { retentionDays: 45 } })).body).toEqual({
      code: "bad_request",
      message: "Unknown log retention",
    });
    // The offered ones go through.
    expect(
      patchSettings(deps(), request({ terminal: { backend: "tmux" } })).status,
    ).toBe(200);
    expect(patchSettings(deps(), request({ logs: { retentionDays: 0 } })).status).toBe(200);
  });
});

describe("GET /api/execution-hosts", () => {
  /**
   * This machine is always in the list and is never stored: its identifier is
   * the empty string, it needs no registration, and it has no row to delete.
   */
  it("puts this machine first, without a record", () => {
    const hosts = list(listExecutionHosts(hostDeps({}, [["", 3]])));
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toEqual({
      executionHostId: "",
      name: "",
      kind: "local",
      workerConfigured: true,
      workspaceCount: 3,
    });
  });

  it("reports whether a host can run a workspace at all", () => {
    const hosts = list(
      listExecutionHosts(
        hostDeps(
          {
            ssh: {
              hosts: [
                { id: "plain", name: "Plain", host: "a.example" },
                {
                  id: "worker",
                  name: "Worker",
                  host: "b.example",
                  worker: { path: "/opt/armadra" },
                },
              ],
            },
          },
          [["worker", 2]],
        ),
      ),
    );
    expect(hosts).toHaveLength(3);
    // Without a worker the host runs terminals only; saying so is the whole
    // point of a separate flag.
    expect(hosts[1]?.workerConfigured).toBe(false);
    expect(hosts[2]?.workerConfigured).toBe(true);
    expect(hosts[2]?.workspaceCount).toBe(2);
    expect((hosts[2]?.ssh as JsonObject).worker).toEqual({ path: "/opt/armadra" });
  });
});

describe("PUT /api/execution-hosts/{id}", () => {
  const valid = { id: "box", name: "Box", host: "example.com" };

  it("creates and then replaces one host", () => {
    const context = hostDeps();
    expect(putExecutionHost(context, "box", request(valid)).status).toBe(200);
    // The whole entry is replaced rather than merged: a merge would make
    // "clear the identity file" impossible to express.
    const answer = putExecutionHost(
      context,
      "box",
      request({ ...valid, name: "Renamed", identityFile: "/home/ada/.ssh/id" }),
    );
    const hosts = list(answer);
    expect(hosts).toHaveLength(2);
    expect((hosts[1]?.ssh as JsonObject).name).toBe("Renamed");
    expect((hosts[1]?.ssh as JsonObject).identityFile).toBe("/home/ada/.ssh/id");
  });

  it("refuses a mismatched id, this machine, and an invalid field", () => {
    const context = hostDeps();
    expect(putExecutionHost(context, "other", request(valid)).body).toEqual({
      code: "bad_request",
      message: "The execution host id in the path and in the body must match",
    });
    expect(
      putExecutionHost(context, "", request({ ...valid, id: "" })).body,
    ).toEqual({
      code: "bad_request",
      message: "This machine is always available and is not registered",
    });
    // A refusal naming the field, rather than an entry that silently
    // disappears on the next read.
    expect(
      putExecutionHost(context, "box", request({ ...valid, host: "a;rm -rf /" })).body,
    ).toEqual({
      code: "bad_request",
      message: "Invalid execution host field: host",
    });
  });
});

describe("DELETE /api/execution-hosts/{id}", () => {
  const registry = { ssh: { hosts: [{ id: "box", name: "Box", host: "a.example" }] } };

  it("retires a host nothing runs on", () => {
    const context = hostDeps(registry);
    expect(list(deleteExecutionHost(context, "box"))).toHaveLength(1);
  });

  it("does not know a host that was never registered", () => {
    expect(deleteExecutionHost(hostDeps(registry), "nope")).toEqual({
      status: 404,
      body: { code: "not_found", message: "No such execution host" },
    });
  });

  /**
   * Deleting it would leave those workspaces naming a machine nothing can
   * reach, and their files are on it. Moving them is a decision, so it is asked
   * for rather than performed here.
   */
  it("refuses to delete a host workspaces still run on", () => {
    const answer = deleteExecutionHost(hostDeps(registry, [["box", 2]]), "box");
    expect(answer.status).toBe(409);
    expect((answer.body as JsonObject).code).toBe("conflict");
    expect((answer.body as JsonObject).message).toContain("2 workspace(s)");
  });
});

describe("execution host export and import", () => {
  const registry = {
    ssh: { hosts: [{ id: "box", name: "Box", host: "a.example" }] },
  };

  it("exports a configuration file rather than a secret", () => {
    const body = exportExecutionHosts(hostDeps(registry)).body as JsonObject;
    expect(body.version).toBe(1);
    // There is no field a password, passphrase or key could be carried in, so
    // moving this between two of a person's own machines moves no secret.
    expect(JSON.stringify(body)).not.toMatch(/password|passphrase|secret|token/i);
    expect(body.hosts).toEqual([{ id: "box", name: "Box", host: "a.example" }]);
  });

  it("refuses a package written to a shape this build does not read", () => {
    expect(
      importExecutionHosts(hostDeps(), request({ version: 2, hosts: [] })).status,
    ).toBe(400);
    // `deny_unknown_fields`: importing the half we understand would be a
    // registry nobody chose.
    expect(
      importExecutionHosts(hostDeps(), request({ version: 1, hosts: [], extra: 1 })).status,
    ).toBe(400);
  });

  it("merges by default and refuses a collision unless asked to overwrite", () => {
    const incoming = { id: "box", name: "Imported", host: "b.example" };
    const collision = importExecutionHosts(
      hostDeps(registry),
      request({ version: 1, hosts: [incoming] }),
    );
    expect(collision.status).toBe(409);
    expect((collision.body as JsonObject).message).toContain("import with overwrite");

    const overwritten = list(
      importExecutionHosts(
        hostDeps(registry),
        request({ version: 1, hosts: [incoming], overwrite: true }),
      ),
    );
    expect((overwritten[1]?.ssh as JsonObject).name).toBe("Imported");
  });

  it("replaces the whole registry when asked", () => {
    const hosts = list(
      importExecutionHosts(
        hostDeps(registry),
        request({
          version: 1,
          hosts: [{ id: "new", name: "New", host: "c.example" }],
          replace: true,
        }),
      ),
    );
    expect(hosts).toHaveLength(2);
    expect(hosts[1]?.executionHostId).toBe("new");
  });

  /**
   * A partial import — some hosts in, one refused — would leave a registry
   * nobody chose, and there is no way to tell from the result which half
   * landed.
   */
  it("validates the whole package before writing any of it", () => {
    const context = hostDeps(registry);
    const answer = importExecutionHosts(
      context,
      request({
        version: 1,
        hosts: [
          { id: "good", name: "Good", host: "c.example" },
          { id: "bad", name: "Bad", host: "a;rm -rf /" },
        ],
      }),
    );
    expect(answer.status).toBe(400);
    expect((answer.body as JsonObject).message).toBe(
      "Execution host 'bad' has an invalid host",
    );
    // Nothing was written: the good half did not land either.
    expect(list(listExecutionHosts(context))).toHaveLength(2);
  });
});
