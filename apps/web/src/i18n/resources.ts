import type { MessageModule } from "./index";

/**
 * 资源面板与防休眠（T02，终端宿主设计 §8/§9）。
 *
 * 两处措辞是刻意的，不要「顺手改顺」：
 *
 *  - 会话内存写「估计」。它是进程树 RSS 之和，共享页会被重复计入，不是
 *    独占内存（设计 §8）。
 *  - 防休眠写「空闲睡眠」。这套机制不常亮屏幕、不管合盖、拦不住用户自己
 *    点睡眠，文案不能许下它做不到的承诺（设计 §9）。
 */
export const resources: MessageModule = {
  "zh-CN": {
    "resources.title": "资源",
    "resources.close": "关闭资源面板",
    "resources.refresh": "刷新",
    "resources.loading": "正在采样",
    "resources.cancel": "取消",

    "resources.host": "执行主机",
    "resources.host.cpu": "CPU",
    "resources.host.cores": "{count} 核",
    "resources.host.memory": "内存",
    "resources.host.swap": "交换",
    "resources.host.load": "负载",
    "resources.host.disk": "磁盘",
    "resources.host.uptime": "已运行",
    "resources.host.powerUnknown": "电源状态未知",
    "resources.location.local": "本机",
    "resources.location.remote": "远程",
    "resources.power.ac": "接电源",
    "resources.power.battery": "电池",
    "resources.power.charging": "充电中",
    "resources.unit.day": " 天",
    "resources.unit.hour": " 时",
    "resources.unit.minute": " 分",

    "resources.sessions": "会话",
    "resources.noSessions": "这个工作空间没有正在运行的会话",
    "resources.sort.cpu": "按 CPU",
    "resources.sort.memory": "按内存",
    "resources.sort.name": "按名称",
    "resources.session.children": "子进程 {count}",
    "resources.session.ended": "已结束",
    "resources.session.locate": "定位到节点",
    "resources.session.end": "结束会话",
    "resources.session.memoryEstimated":
      "进程树 RSS 之和；共享内存会被重复计入，是估计值",
    "resources.endTitle": "结束这个会话？",
    "resources.endBody": "「{name}」里正在运行的进程会被终止，无法恢复。",
    "resources.endFailed": "结束会话失败",

    "resources.unknown.remote": "在远程主机上运行，本机测不到指标",
    "resources.unknown.exited": "会话已结束",
    "resources.unknown.no-pid": "没有可用的进程号",
    "resources.unknown.not-found": "进程已经不在了",
    "resources.unknown.warming-up": "正在建立采样基线",

    "resources.orphans": "孤立会话",
    "resources.noOrphans": "没有孤立会话",
    "resources.orphan.no-node": "无对应节点",
    "resources.orphan.no-row": "无会话记录",
    "resources.orphan.adopt": "附着到新节点",
    "resources.orphan.terminate": "终止",
    "resources.orphan.terminateTitle": "终止这个孤立会话？",
    "resources.orphan.terminateBody":
      "「{name}」的进程树会被终止，会话不再存在。",
    "resources.adoptFailed": "认领会话失败",

    "resources.power": "防休眠",
    "resources.power.holding": "生效中",
    "resources.power.idle": "未生效",
    "resources.power.manual": "手动阻止系统空闲睡眠",
    "resources.power.manualReason": "用户在资源面板中手动开启",
    "resources.power.scope":
      "只阻止系统空闲睡眠；不常亮屏幕，也不影响合盖或手动睡眠。",
    "resources.power.expires": "{value}到期",
    "resources.power.unavailable": "这个平台没有可用的防休眠机制",
    "resources.power.failed": "防休眠操作失败",
    "resources.power.blocked.policy": "当前策略不允许",
    "resources.power.blocked.unavailable": "平台不支持",
    "resources.power.source.session": "会话",
    "resources.power.source.automation": "自动化",
    "resources.power.source.manual": "手动",
    "resources.power.policy.never": "策略：从不",
    "resources.power.policy.agentSessions": "策略：有活跃 Agent 会话时",
    "resources.power.policy.automation": "策略：有自动化运行时",
    "resources.power.policy.manual": "策略：手动",
    "resources.power.policyLabel": "防休眠策略",
    "resources.power.policyHint":
      "只阻止系统空闲睡眠；租约全部释放或 Runtime 退出时立即解除。",
    "resources.intervalLabel": "采样间隔",
    "resources.intervalHint": "面板打开时才采样；关闭后 Runtime 自动停止。",
    "resources.interval.value": "{value} 秒",

    "cluster.resources": "资源",
    "cmd.app.resources": "资源面板",
  },
  en: {
    "resources.title": "Resources",
    "resources.close": "Close resources",
    "resources.refresh": "Refresh",
    "resources.loading": "Sampling",
    "resources.cancel": "Cancel",

    "resources.host": "Execution host",
    "resources.host.cpu": "CPU",
    "resources.host.cores": "{count} cores",
    "resources.host.memory": "Memory",
    "resources.host.swap": "Swap",
    "resources.host.load": "Load",
    "resources.host.disk": "Disk",
    "resources.host.uptime": "Uptime",
    "resources.host.powerUnknown": "Power state unknown",
    "resources.location.local": "Local",
    "resources.location.remote": "Remote",
    "resources.power.ac": "On mains",
    "resources.power.battery": "On battery",
    "resources.power.charging": "Charging",
    "resources.unit.day": "d",
    "resources.unit.hour": "h",
    "resources.unit.minute": "m",

    "resources.sessions": "Sessions",
    "resources.noSessions": "No sessions are running in this workspace",
    "resources.sort.cpu": "By CPU",
    "resources.sort.memory": "By memory",
    "resources.sort.name": "By name",
    "resources.session.children": "{count} children",
    "resources.session.ended": "Ended",
    "resources.session.locate": "Find on canvas",
    "resources.session.end": "End session",
    "resources.session.memoryEstimated":
      "Sum of the process tree’s RSS; shared pages are counted more than once, so this is an estimate",
    "resources.endTitle": "End this session?",
    "resources.endBody":
      "The processes running in “{name}” are terminated and cannot be resumed.",
    "resources.endFailed": "Could not end the session",

    "resources.unknown.remote": "Runs on a remote host; not measurable here",
    "resources.unknown.exited": "Session has ended",
    "resources.unknown.no-pid": "No process id available",
    "resources.unknown.not-found": "The process is gone",
    "resources.unknown.warming-up": "Establishing a sampling baseline",

    "resources.orphans": "Orphaned sessions",
    "resources.noOrphans": "No orphaned sessions",
    "resources.orphan.no-node": "No node",
    "resources.orphan.no-row": "No record",
    "resources.orphan.adopt": "Attach to a new node",
    "resources.orphan.terminate": "Terminate",
    "resources.orphan.terminateTitle": "Terminate this orphaned session?",
    "resources.orphan.terminateBody":
      "The process tree of “{name}” is terminated and the session stops existing.",
    "resources.adoptFailed": "Could not adopt the session",

    "resources.power": "Keep awake",
    "resources.power.holding": "Active",
    "resources.power.idle": "Not active",
    "resources.power.manual": "Hold off idle system sleep",
    "resources.power.manualReason": "Switched on from the resources panel",
    "resources.power.scope":
      "Only idle system sleep is held off. The display still sleeps, and closing the lid or sleeping manually still works.",
    "resources.power.expires": "expires {value}",
    "resources.power.unavailable":
      "This platform has no sleep inhibitor available",
    "resources.power.failed": "The keep-awake request failed",
    "resources.power.blocked.policy": "Not allowed by the policy",
    "resources.power.blocked.unavailable": "Not supported on this platform",
    "resources.power.source.session": "Session",
    "resources.power.source.automation": "Automation",
    "resources.power.source.manual": "Manual",
    "resources.power.policy.never": "Policy: never",
    "resources.power.policy.agentSessions": "Policy: while agents work",
    "resources.power.policy.automation": "Policy: while automations run",
    "resources.power.policy.manual": "Policy: manual only",
    "resources.power.policyLabel": "Keep-awake policy",
    "resources.power.policyHint":
      "Only idle system sleep is held off, and it is released the moment the last lease goes away or the runtime exits.",
    "resources.intervalLabel": "Sampling interval",
    "resources.intervalHint":
      "Sampling only runs while the panel is open; the runtime stops on its own once it closes.",
    "resources.interval.value": "{value}s",

    "cluster.resources": "Resources",
    "cmd.app.resources": "Resources panel",
  },
};
