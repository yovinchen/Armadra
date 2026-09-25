import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitRepositoryOperation } from "@armadra/shared";

const loading = vi.fn();
const dismiss = vi.fn();
const error = vi.fn();
const warning = vi.fn();
const info = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    loading: (...args: unknown[]) => loading(...args),
    dismiss: (...args: unknown[]) => dismiss(...args),
    error: (...args: unknown[]) => error(...args),
    warning: (...args: unknown[]) => warning(...args),
    info: (...args: unknown[]) => info(...args),
  },
}));

import { gitGateway } from "../../../git/gateway";
import { t, usePreferencesStore } from "../../../app/preferences-store";
import { followOperation } from "./follow-operation";

/**
 * 日志页的写（获取远端更新、拉取、推送……）交出去之后：此前页面只重读一次
 * 就不管了——fetch 跑多久、到了百分之几都看不见，也没有地方取消，尽管
 * core 的队列与远端 Worker 都支持取消（§44）。
 */

const target = {
  workspaceId: "w1",
  repositoryPath: "/srv/project",
  path: ".",
};

function operation(
  state: GitRepositoryOperation["state"],
  progress = 0,
): GitRepositoryOperation {
  return {
    id: "op-1",
    repositoryId: "repo",
    workspaceRoot: "/srv/project",
    repositoryPath: ".",
    action: { kind: "fetch", remote: "origin", prune: false },
    state,
    cancellationRequested: false,
    progress,
    createdAt: "2026-09-26T00:00:00Z",
    finishedAt: null,
    message: state === "failed" ? "远端拒绝" : null,
  } as GitRepositoryOperation;
}

beforeEach(() => {
  vi.useFakeTimers();
  usePreferencesStore.setState({ locale: "zh-CN" });
  for (const mock of [loading, dismiss, error, warning, info]) mock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("followOperation", () => {
  it("跟着进度更新同一条提示，完成后收起并重读", async () => {
    const reads = [operation("running", 40), operation("succeeded", 100)];
    vi.spyOn(gitGateway, "operation").mockImplementation(
      async () => reads.shift() ?? operation("succeeded", 100),
    );
    const settled = vi.fn();
    followOperation(target, operation("queued"), settled);
    expect(loading).toHaveBeenLastCalledWith(
      `${t("gitRepo.fetch")} · ${t("gitRepo.state.queued")}`,
      expect.objectContaining({ id: "git-operation-op-1" }),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(loading).toHaveBeenLastCalledWith(
      `${t("gitRepo.fetch")} · ${t("gitRepo.state.running")} · 40%`,
      expect.anything(),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(dismiss).toHaveBeenCalledWith("git-operation-op-1");
    expect(settled).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("提示上的「取消」发出取消请求，结局是「已取消」", async () => {
    const cancel = vi
      .spyOn(gitGateway, "cancel")
      .mockResolvedValue(operation("running"));
    const reads = [operation("running", 10), operation("cancelled")];
    vi.spyOn(gitGateway, "operation").mockImplementation(
      async () => reads.shift() ?? operation("cancelled"),
    );
    followOperation(target, operation("running"), () => {});
    const options = loading.mock.calls.at(-1)?.[1] as {
      action: { label: string; onClick: () => void };
    };
    expect(options.action.label).toBe(t("gitRepo.cancel"));
    options.action.onClick();
    expect(cancel).toHaveBeenCalledWith(target, "op-1");
    await vi.advanceTimersByTimeAsync(1200);
    expect(info).toHaveBeenCalledWith(
      `${t("gitRepo.fetch")} · ${t("gitRepo.state.cancelled")}`,
      expect.objectContaining({ id: "git-operation-op-1" }),
    );
  });

  it("失败与结果不确定各说各的，已经结束的操作不挂进度条", async () => {
    vi.spyOn(gitGateway, "operation").mockResolvedValue(operation("failed"));
    followOperation(target, operation("running"), () => {});
    await vi.advanceTimersByTimeAsync(600);
    expect(error).toHaveBeenCalledWith(
      "远端拒绝",
      expect.objectContaining({ id: "git-operation-op-1" }),
    );
    loading.mockReset();
    followOperation(target, operation("unknownOutcome"), () => {});
    expect(loading).not.toHaveBeenCalled();
    // 结局不带进行中那条的「取消」，也不再常驻。
    expect(warning).toHaveBeenCalledWith(t("gitRepo.unknown"), {
      id: "git-operation-op-1",
      action: undefined,
      duration: undefined,
    });
  });
});
