import { describe, expect, it } from "vitest";

import { parseLsof, parseProcNet } from "./sockets";

/**
 * SSH 会话与远端进程树靠连接端口对上（`sockets.ts`）。两种读法的解析各钉一次：
 * 形状不对的行一律不算，不猜。
 */
describe("谁握着哪条连接", () => {
  it("读 lsof 的字段输出，IPv4 与 IPv6 都认", () => {
    const output = [
      "p101",
      "f3",
      "n127.0.0.1:52001->127.0.0.1:22",
      "p202",
      "f7",
      "n[::1]:22->[::1]:52001",
      "f8",
      "n*:8080",
      "",
    ].join("\n");
    expect(parseLsof(output)).toEqual([
      { pid: 101, localPort: 52001, remotePort: 22 },
      { pid: 202, localPort: 22, remotePort: 52001 },
    ]);
  });

  it("读 /proc/net/tcp，只要已建立的连接", () => {
    const text = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0016 0100007F:CB21 01 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 20 4 30 10 -1",
      "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 17 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    expect([...parseProcNet(text).entries()]).toEqual([
      ["4242", { pid: 0, localPort: 22, remotePort: 0xcb21 }],
    ]);
  });
});
