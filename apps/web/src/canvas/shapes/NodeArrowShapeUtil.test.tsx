import * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Editor, TLArrowShape } from "tldraw";

vi.mock("tldraw", async () => {
  const React = await import("react");
  return {
    ArrowShapeUtil: class {
      constructor(readonly editor: Editor) {}
      component() {
        // tldraw's actual util calls hooks in component(), not in a child.
        const [label] = React.useState("Native arrow");
        return React.createElement("span", null, label);
      }
    },
  };
});
vi.mock("./LinkArrow", () => ({
  isNodeShape: (shape: { type: string }) => shape?.type === "armadra",
}));
vi.mock("./LinkShapeUtil", () => ({
  LinkShapeContent: () => <span>Node link preview</span>,
}));

import { NodeArrowShapeUtil } from "./NodeArrowShapeUtil";

afterEach(cleanup);

it("keeps native hook order while the pointer enters and leaves a target node", () => {
  const bindings = [{ toId: "shape:a", props: { terminal: "start" } }];
  const matrix = {
    clone: () => matrix,
    invert: () => matrix,
    toCssString: () => "matrix(1,0,0,1,0,0)",
  };
  const editor = {
    getBindingsFromShape: () => bindings,
    getShape: () => ({ type: "armadra" }),
    getShapePageTransform: () => matrix,
  } as unknown as Editor;
  const util = new NodeArrowShapeUtil(editor);
  const shape = { id: "shape:arrow", type: "arrow" } as TLArrowShape;
  function Shape() {
    return util.component(shape);
  }

  const view = render(<Shape />);
  expect(screen.getByText("Native arrow")).toBeTruthy();
  bindings.push({ toId: "shape:b", props: { terminal: "end" } });
  view.rerender(<Shape />);
  expect(screen.getByText("Node link preview")).toBeTruthy();
  bindings.pop();
  view.rerender(<Shape />);
  expect(screen.getByText("Native arrow")).toBeTruthy();
});
