import { beforeEach, describe, expect, it, vi } from "vitest";

const getTerminal = vi.fn();
const wakeTerminal = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: {
    getTerminal: (id: string) => getTerminal(id),
    wakeTerminal: (id: string) => wakeTerminal(id),
  },
}));

import { sessionGateway } from "./gateway";

/**
 * 节能休眠的会话（终端宿主设计 §7.2）在网关上不是「已退出」。
 *
 * 挂载读到「已退出」就会替节点新建一个会话——在同一个节点上另起一个互不相识
 * 的 CLI，休眠的那段对话就再也没人接得回来了。
 */

const row = (patch: Record<string, unknown>) => ({
  id: "00000000-0000-4000-8000-000000000001",
  sessionKey: "node-1",
  status: "running",
  generation: 1,
  exitCode: null,
  ...patch,
});

beforeEach(() => {
  getTerminal.mockReset();
  wakeTerminal.mockReset();
});

describe("sessionGateway", () => {
  it("以休眠结束的行读成 hibernated，其余结束的行照旧是 exited", async () => {
    getTerminal.mockResolvedValueOnce(
      row({ status: "terminated", hibernation: "hibernated" }),
    );
    expect((await sessionGateway.find("ws", "n", "s"))?.state).toBe(
      "hibernated",
    );
    getTerminal.mockResolvedValueOnce(row({ status: "terminated" }));
    expect((await sessionGateway.find("ws", "n", "s"))?.state).toBe("exited");
  });

  it("唤醒答回同一个会话 id 的下一代", async () => {
    wakeTerminal.mockResolvedValueOnce(row({ generation: 2 }));
    const woken = await sessionGateway.wake("ws", "s");
    expect(wakeTerminal).toHaveBeenCalledWith("s");
    expect(woken).toMatchObject({ state: "running", generation: 2n });
  });
});
