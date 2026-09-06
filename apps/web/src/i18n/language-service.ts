import type { MessageModule } from "./index";

/**
 * 语言服务（语言服务设计 §4.2）。
 *
 * 三条文案上的规矩：
 *
 *  * **「不可用」永远带原因。** `lsp.reason.*` 与 Runtime 的稳定 reason key
 *    一一对应；界面说的是缺什么，不是笼统的「未启用」。
 *  * **不出现「安装」。** Armadra 不下载、不安装任何 language server
 *    （设计 §6.2），所以这里没有一句会让人以为可以一键装上的话。
 *  * **不解释 LSP 是什么。** 状态栏和设置页只报状态。
 */
export const languageService: MessageModule = {
  "zh-CN": {
    "lsp.title": "语言服务",
    "lsp.probing": "正在探测…",
    "lsp.unavailable": "未启用",
    "lsp.description": "只使用这台执行主机上已经装好的 language server。",
    "lsp.reprobe": "重新探测",
    "lsp.restart": "重启",
    "lsp.stop": "停止",
    "lsp.formatOnSave": "保存时格式化",
    "lsp.formatOnSaveHint":
      "保存前先请求 textDocument/formatting，超时则跳过。",
    "lsp.enabled": "启用",
    "lsp.pathOverride": "可执行文件路径",
    "lsp.pathPlaceholder": "留空则在 PATH 中查找",
    "lsp.noServers": "没有可列出的语言",
    "lsp.executableMissing": "未找到",
    "lsp.openDocuments": "{count} 个文档",
    "lsp.notApplicable": "LSP 不适用",
    "lsp.following": "LSP 跟随另一节点",
    "lsp.stderr": "服务器最后的输出",

    "lsp.state.none": "LSP 未启用",
    "lsp.state.available": "可用",
    "lsp.state.unsupported": "不可用",
    "lsp.state.starting": "正在启动…",
    "lsp.state.running": "运行中",
    "lsp.state.idleStopped": "空闲已停止",
    "lsp.state.crashed": "已崩溃",
    "lsp.state.stopped": "已停止",
    "lsp.state.disconnected": "连接已断开",
    "lsp.state.reconnecting": "正在重连…",

    "lsp.reason.server_not_found": "这台机器上没有对应的 language server",
    "lsp.reason.server_probe_failed": "language server 存在但无法运行",
    "lsp.reason.execution_not_granted": "需要工作区的执行权限",
    "lsp.reason.disabled": "已在设置中关闭",
    "lsp.reason.language_unknown": "没有这种语言的 server",
    "lsp.reason.too_many_servers": "同时运行的 server 已达上限",
    "lsp.reason.containment_unavailable": "这台机器无法约束子进程",
    "lsp.reason.resource_exhausted": "超出资源上限",
    "lsp.reason.session_failed": "无法建立语言会话",
    "lsp.reason.idle": "空闲超时",
    "lsp.reason.user": "已手动停止",
    "lsp.reason.crashed": "进程异常退出",
    "lsp.reason.restart_budget_exhausted": "重启次数已用尽",
    "lsp.reason.workspace_closed": "工作区已关闭",

    "lsp.rename.prompt": "新名称",
    "lsp.rename.submit": "重命名",
    "lsp.rename.title": "重命名 {from} → {to}",
    "lsp.rename.empty": "服务器没有返回任何改动",

    "lsp.preview.title": "应用修改",
    "lsp.preview.computing": "正在计算…",
    "lsp.preview.apply": "应用",
    "lsp.preview.cancel": "取消",
    "lsp.preview.close": "关闭",
    "lsp.preview.files": "{count} 个文件",
    "lsp.preview.noChanges": "没有需要修改的文件",
    "lsp.preview.blocked": "有文件无法修改，整次修改都不会应用",
    "lsp.preview.applied": "已写入 {count} 个文件",
    "lsp.preview.failedTitle": "未能写入",
    "lsp.preview.unchanged": "无变化",
    "lsp.blocked.external": "在工作区之外",
    "lsp.blocked.fileOperation": "需要新建、重命名或删除文件",
    "lsp.blocked.dirty": "有未保存的草稿，请先保存",
    "lsp.blocked.unreadable": "读不到这个文件",
    "lsp.blocked.noVersion": "没有内容版本，无法安全写入",

    "problems.title": "问题",
    "problems.close": "关闭",
    "problems.empty": "没有诊断",
    "problems.inactive": "打开一个有语言服务的文件后才会有诊断",
    "problems.summary": "{errors} 个错误 · {warnings} 个警告",
    "problems.at": "第 {line} 行",
    "cmd.app.problems": "问题面板",
  },
  en: {
    "lsp.title": "Language service",
    "lsp.probing": "Probing…",
    "lsp.unavailable": "Not enabled",
    "lsp.description":
      "Uses only the language servers already installed on this execution host.",
    "lsp.reprobe": "Probe again",
    "lsp.restart": "Restart",
    "lsp.stop": "Stop",
    "lsp.formatOnSave": "Format on save",
    "lsp.formatOnSaveHint":
      "Request textDocument/formatting before saving; skipped if it times out.",
    "lsp.enabled": "Enabled",
    "lsp.pathOverride": "Executable path",
    "lsp.pathPlaceholder": "Leave empty to look it up on PATH",
    "lsp.noServers": "No languages to list",
    "lsp.executableMissing": "Not found",
    "lsp.openDocuments": "{count} documents",
    "lsp.notApplicable": "LSP not applicable",
    "lsp.following": "LSP follows another node",
    "lsp.stderr": "Last output from the server",

    "lsp.state.none": "LSP not enabled",
    "lsp.state.available": "Available",
    "lsp.state.unsupported": "Unavailable",
    "lsp.state.starting": "Starting…",
    "lsp.state.running": "Running",
    "lsp.state.idleStopped": "Stopped while idle",
    "lsp.state.crashed": "Crashed",
    "lsp.state.stopped": "Stopped",
    "lsp.state.disconnected": "Disconnected",
    "lsp.state.reconnecting": "Reconnecting…",

    "lsp.reason.server_not_found":
      "No language server for this on this machine",
    "lsp.reason.server_probe_failed":
      "The language server exists but will not run",
    "lsp.reason.execution_not_granted": "Needs the workspace's execute grant",
    "lsp.reason.disabled": "Turned off in settings",
    "lsp.reason.language_unknown": "No server for this language",
    "lsp.reason.too_many_servers": "Too many servers are already running",
    "lsp.reason.containment_unavailable":
      "This machine cannot contain child processes",
    "lsp.reason.resource_exhausted": "Past its resource ceiling",
    "lsp.reason.session_failed": "Could not open a language session",
    "lsp.reason.idle": "Idle timeout",
    "lsp.reason.user": "Stopped by hand",
    "lsp.reason.crashed": "The process exited unexpectedly",
    "lsp.reason.restart_budget_exhausted": "Out of restart attempts",
    "lsp.reason.workspace_closed": "The workspace was closed",

    "lsp.rename.prompt": "New name",
    "lsp.rename.submit": "Rename",
    "lsp.rename.title": "Rename {from} → {to}",
    "lsp.rename.empty": "The server returned no changes",

    "lsp.preview.title": "Apply changes",
    "lsp.preview.computing": "Working…",
    "lsp.preview.apply": "Apply",
    "lsp.preview.cancel": "Cancel",
    "lsp.preview.close": "Close",
    "lsp.preview.files": "{count} files",
    "lsp.preview.noChanges": "Nothing to change",
    "lsp.preview.blocked":
      "Some files cannot be changed, so nothing is applied",
    "lsp.preview.applied": "Wrote {count} files",
    "lsp.preview.failedTitle": "Not written",
    "lsp.preview.unchanged": "No change",
    "lsp.blocked.external": "Outside the workspace",
    "lsp.blocked.fileOperation": "Needs a file created, renamed or deleted",
    "lsp.blocked.dirty": "Has unsaved changes; save it first",
    "lsp.blocked.unreadable": "This file cannot be read",
    "lsp.blocked.noVersion":
      "No content version, so it cannot be written safely",

    "problems.title": "Problems",
    "problems.close": "Close",
    "problems.empty": "No diagnostics",
    "problems.inactive":
      "Diagnostics appear once a file with a language service is open",
    "problems.summary": "{errors} errors · {warnings} warnings",
    "problems.at": "Line {line}",
    "cmd.app.problems": "Problems panel",
  },
};
