import type { CanvasEdge, CanvasNode } from "./domain.js";

export interface FlowNodeProjection {
  id: string;
  type: CanvasNode["type"];
  position: CanvasNode["position"];
  width?: number;
  height?: number;
  /** Tri-state display mode; the canvas may force `mini` below the zoom threshold. */
  zoom: CanvasNode["zoom"];
  boardId: string;
  data: CanvasNode["data"];
}

export interface FlowEdgeProjection {
  id: string;
  source: string;
  target: string;
  type: "semantic";
  data: {
    semanticType: CanvasEdge["type"];
    label?: string;
  };
}

export function projectNode(node: CanvasNode): FlowNodeProjection {
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    width: node.size?.width,
    height: node.size?.height,
    zoom: node.zoom,
    boardId: node.boardId,
    data: node.data,
  };
}

export function projectEdge(edge: CanvasEdge): FlowEdgeProjection {
  return {
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    type: "semantic",
    data: {
      semanticType: edge.type,
      ...(edge.label ? { label: edge.label } : {}),
    },
  };
}
