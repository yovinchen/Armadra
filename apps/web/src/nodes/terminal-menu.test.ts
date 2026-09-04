import { describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@armadra/shared";
import type { NodeMenuItemsFactory } from "@/canvas/menus/node-menu";

const registration = vi.hoisted(() => ({
  factory: null as NodeMenuItemsFactory | null,
}));
vi.mock("@/canvas/menus/node-menu", () => ({
  registerNodeMenuItems: (_type: string, factory: NodeMenuItemsFactory) => {
    registration.factory = factory;
    return () => undefined;
  },
}));
vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: { getState: () => ({ updateNodeData: vi.fn() }) },
}));
vi.mock("@/meta/annotations", () => ({ openNodeAnnotation: vi.fn() }));
vi.mock("./terminal-registry", () => ({ terminalHandle: () => null }));
vi.mock("@/agent/launch", () => ({
  customAgentFor: (id: string) =>
    id === "custom:pi" ? { baseAgent: "pi" } : undefined,
  permissionModeLabel: (mode: string) => mode,
}));

import "./terminal-menu";

function permissions(id: string) {
  const node = {
    id: "test",
    type: "terminal",
    data: { kind: "terminal", agent: { id } },
  } as CanvasNode;
  return registration.factory!({ node, targetIds: [node.id] })
    .map((item) => item.id)
    .filter((key) => key.startsWith("agent.permission."));
}

describe("terminal permissions", () => {
  it.each(["pi", "opencode", "custom:pi"])(
    "does not offer unsupported permissions for %s",
    (id) => {
      expect(permissions(id)).toEqual(["agent.permission.default"]);
    },
  );

  it("does not present OMP's model selection flag as a planning permission", () => {
    expect(permissions("omp")).not.toContain("agent.permission.plan");
    expect(permissions("omp")).toContain("agent.permission.full-auto");
  });

  it("keeps the supported Claude planning mode available", () => {
    expect(permissions("claude")).toContain("agent.permission.plan");
  });
});
