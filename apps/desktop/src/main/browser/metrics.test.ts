import { describe, expect, it } from "vitest";

import { classifyMetrics, shellMetricsEvent } from "./metrics";

function metric(pid: number, type: string, kb = 1000, cpu = 1.25) {
  return {
    pid,
    type,
    creationTime: 1_700_000_000_000.4,
    memory: { workingSetSize: kb, peakWorkingSetSize: kb },
    cpu: { percentCPUUsage: cpu, idleWakeupsPerSecond: 0 },
  } as never;
}

describe("the shell's own processes", () => {
  it("names each process by what Electron and the guest list say it is", () => {
    const rows = classifyMetrics(
      [
        metric(40, "Tab"),
        metric(10, "Browser"),
        metric(30, "GPU"),
        metric(50, "Tab"),
        metric(60, "Utility"),
      ],
      new Set([50]),
    );
    expect(rows.map((row) => [row.pid, row.kind])).toEqual([
      [10, "shellMain"],
      [30, "shellGpu"],
      [40, "shellRenderer"],
      [50, "browserGuest"],
      [60, "shellUtility"],
    ]);
    expect(rows[0]).toMatchObject({
      startTimeUnixMs: 1_700_000_000_000,
      memoryBytes: 1000 * 1024,
      cpuPercent: 1.3,
    });
  });

  it("drops rows with no usable pid", () => {
    expect(classifyMetrics([metric(0, "Tab")], new Set())).toEqual([]);
  });

  it("travels as a drive event that belongs to no node", () => {
    expect(shellMetricsEvent([])).toEqual({
      type: "event",
      event: "shellMetrics",
      nodeId: "",
      processes: [],
    });
  });
});
