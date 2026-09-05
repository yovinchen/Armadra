import { describe, expect, it } from "vitest";
import { create } from "@armadra/protocol";
import {
  GithubIssueSchema,
  GithubPullRequestSchema,
  GithubStatusMappingSchema,
} from "@armadra/protocol";
import { HostGithubError } from "@armadra/host-client";

import {
  MAX_POLL_MS,
  MIN_POLL_MS,
  failureKey,
  groupIssues,
  mergeReasonKey,
  pollInterval,
  suggestedHeadRef,
} from "./model";

const repository = {
  owner: "armadra",
  name: "armadra",
  apiBase: "https://api.github.com",
  host: "github.com",
};

function issue(number: number, statusGroupId = "") {
  return create(GithubIssueSchema, {
    repository,
    number: BigInt(number),
    title: `issue ${number}`,
    statusGroupId,
    updatedAtUnixMs: 1_788_000_000_000n,
  });
}

const mapping = create(GithubStatusMappingSchema, {
  repository,
  revision: 4n,
  groups: [
    { id: "todo", title: "Todo" },
    { id: "done", title: "Done" },
  ],
});

describe("status groups", () => {
  it("keeps the configured order and pushes the rest into one unmapped pile", () => {
    const groups = groupIssues(
      [issue(1, "done"), issue(2), issue(3, "todo"), issue(4, "gone")],
      mapping,
    );
    expect(groups.map((group) => group.id)).toEqual(["todo", "done", ""]);
    expect(groups[2]!.issues.map((item) => Number(item.number))).toEqual([
      2, 4,
    ]);
  });

  it("shows no unmapped section when every issue has a configured group", () => {
    const groups = groupIssues([issue(1, "todo")], mapping);
    expect(groups.map((group) => group.id)).toEqual(["todo", "done"]);
  });

  it("puts everything under unmapped when no mapping is configured", () => {
    const groups = groupIssues([issue(1, "todo")], undefined);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.group).toBeNull();
  });
});

describe("polling", () => {
  it("uses the Host's interval, clamped on both ends", () => {
    expect(pollInterval(60_000n)).toBe(60_000);
    expect(pollInterval(10n)).toBe(MIN_POLL_MS);
    expect(pollInterval(0n)).toBe(MIN_POLL_MS);
    expect(pollInterval(undefined)).toBe(MIN_POLL_MS);
    expect(pollInterval(9_999_999n)).toBe(MAX_POLL_MS);
  });
});

describe("local checkout naming", () => {
  const pull = (fromFork: boolean, headRef: string) =>
    create(GithubPullRequestSchema, {
      repository,
      number: 42n,
      headRef,
      fromFork,
    });

  it("keeps a same-repository head ref", () => {
    expect(suggestedHeadRef(pull(false, "feature/x"))).toBe("feature/x");
  });

  it("never suggests a fork's ref name, so a local branch is not taken over", () => {
    expect(suggestedHeadRef(pull(true, "main"))).toBe("pr-42");
  });
});

describe("failures and reason codes", () => {
  it("names the repair for each client failure", () => {
    expect(failureKey(new HostGithubError("conflict"))).toBe(
      "github.error.conflict",
    );
    expect(failureKey(new Error("boom"))).toBe("github.error.network");
  });

  it("never tells the user to just retry a write whose result is unknown", () => {
    expect(failureKey(new HostGithubError("network", true))).toBe(
      "github.error.unknownOutcome",
    );
  });

  it("explains only the merge codes the Host documents", () => {
    expect(mergeReasonKey("HEAD_MOVED")).toBe("github.mergeReason.HEAD_MOVED");
    expect(mergeReasonKey("SOMETHING_ELSE")).toBeNull();
  });
});
