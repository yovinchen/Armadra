import type {
  BoardDocument,
  CanvasNode,
  ContextItem,
  ContextItemKind,
} from "@ai-coding-canvas/shared";

/**
 * Everything an Agent node is allowed to see: the sources of its incoming
 * `ref` / `dispatch` edges, plus the chips pinned onto the Agent itself.
 * See docs/redesign-plan.md §2.
 */
export function collectContextItems(
  document: BoardDocument,
  agentNodeId: string,
): ContextItem[] {
  const sources = new Set(
    document.edges
      .filter(
        (edge) =>
          edge.targetNodeId === agentNodeId &&
          (edge.type === "ref" || edge.type === "dispatch"),
      )
      .map((edge) => edge.sourceNodeId),
  );

  const fromEdges = document.nodes
    .filter((node) => sources.has(node.id))
    .flatMap(nodeToContextItem);

  const agent = document.nodes.find((node) => node.id === agentNodeId);
  const fromChips: ContextItem[] =
    agent?.data.kind === "agent"
      ? agent.data.contextChips.map((chip) => ({
          nodeId: agentNodeId,
          kind: chip.kind as ContextItemKind,
          title: chip.label,
          value: chip.value,
        }))
      : [];

  return [...fromEdges, ...fromChips];
}

function nodeToContextItem(node: CanvasNode): ContextItem[] {
  const item = (kind: ContextItemKind, value: string): ContextItem[] => [
    { nodeId: node.id, kind, title: node.data.title, value },
  ];

  switch (node.data.kind) {
    case "task":
      return item("task", node.data.description);
    case "file":
      return item("file", node.data.path);
    case "context":
      return item("context", node.data.path);
    case "log":
      return item("log", node.data.content);
    case "note":
      return item("note", node.data.content);
    case "browser":
      return item("browser", node.data.url);
    default:
      // agent / terminal / diff / image carry no transferable prompt context.
      return [];
  }
}
