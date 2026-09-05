import type { MessageModule } from "./index";

export const fileDrag: MessageModule = {
  "zh-CN": {
    "fileDrag.hint": "拖到终端插入路径，拖到画布打开预览",
    "fileDrag.invalidPayload": "无法识别拖入的文件，请从应用内文件树重新拖入。",
    "fileDrag.invalidPath": "路径包含无法安全插入的字符，未插入终端。",
    "fileDrag.scopeMismatch":
      "文件与目标不在同一服务或工作区，请先切换到对应工作区。",
    "fileDrag.destinationChanged": "终端或工作区已变化，请重新拖入。",
    "fileDrag.launchPending":
      "Agent 仍有待发送的启动输入，请等启动完成后再拖入路径。",
    "fileDrag.executionUnsupported":
      "无法确认这个终端的文件位置，请在对应执行环境中选择路径。",
    "fileDrag.shellUnsupported": "暂不支持为这个 Shell 安全引用路径。",
    "fileDrag.cmdPathUnsupported":
      "此路径包含 CMD 无法可靠引用的字符，未插入终端。",
    "fileDrag.externalPathUnavailable":
      "请从应用内文件树拖入；此处不会把外部文件名当作终端路径。",
    "fileDrag.canvasLocked": "请先解锁画布，再拖入文件预览。",
    "fileDrag.failed": "无法打开文件或插入路径，请确认文件仍可访问。",
  },
  en: {
    "fileDrag.hint":
      "Drag to a terminal to insert a path, or onto the canvas to preview",
    "fileDrag.invalidPayload":
      "The dropped file is not recognized. Drag it again from the app's file tree.",
    "fileDrag.invalidPath":
      "The path contains characters that cannot be inserted safely. Nothing was pasted.",
    "fileDrag.scopeMismatch":
      "The file and destination belong to different services or workspaces. Switch to the matching workspace first.",
    "fileDrag.destinationChanged":
      "The terminal or workspace changed. Drag the file again.",
    "fileDrag.launchPending":
      "The Agent still has scheduled startup input. Wait for startup to finish before dropping a path.",
    "fileDrag.executionUnsupported":
      "The file location for this terminal cannot be confirmed. Choose a path in its execution environment.",
    "fileDrag.shellUnsupported":
      "Safe path quoting is not supported for this shell yet.",
    "fileDrag.cmdPathUnsupported":
      "CMD cannot safely quote characters in this path. Nothing was pasted.",
    "fileDrag.externalPathUnavailable":
      "Drag from the app's file tree. External filenames are not treated as terminal paths here.",
    "fileDrag.canvasLocked":
      "Unlock the canvas before dropping a file preview.",
    "fileDrag.failed":
      "The file could not be previewed or its path inserted. Check that it is still accessible.",
  },
};
