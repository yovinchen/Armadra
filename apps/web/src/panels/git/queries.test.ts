import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { invalidateGitQueries } from "./queries";

describe("invalidateGitQueries", () => {
  it("一次写之后日志页的历史与引用也要重读", async () => {
    // 在提交页提交之后切到日志页，表格仍停在提交之前（远端探针实测）：日志页
    // 两份查询只在它自己发起的写之后失效，提交页、暂存、Stash 走的是这里。
    const client = new QueryClient();
    client.setQueryData(["git-log", "w1", "key"], { entries: [] });
    client.setQueryData(["git-refs", "w1"], []);
    client.setQueryData(["git-log", "w2", "key"], { entries: [] });
    invalidateGitQueries(client, "w1");
    expect(client.getQueryState(["git-log", "w1", "key"])?.isInvalidated).toBe(
      true,
    );
    expect(client.getQueryState(["git-refs", "w1"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["git-log", "w2", "key"])?.isInvalidated).toBe(
      false,
    );
  });
});
