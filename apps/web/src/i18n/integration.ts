import type { MessageModule } from "./index";

/**
 * 设置 → 集成（[Agent 接入归一](../../../../docs/design/agent-integration-mcp.md) §2）。
 *
 * 取代原来分散在 `modals` 里的 `settings.hooks.*` / `settings.skills.*`：
 * 一种 CLI 一行，所以文案也归到一处。Claude / Codex 这些是 CLI 名，保留原文
 * （§14 第 2 条）；`aicc-hook` 与上一个产品名是磁盘上的字面量（见 core 的
 * `hook/install/repair.ts` `LEGACY_MARKERS`），同样不翻译。
 */
export const integration: MessageModule = {
  "zh-CN": {
    "integration.nav": "集成",
    "integration.empty": "没有可接入的 CLI",
    "integration.mode.canvas": "画布内注入",
    "integration.mode.launch": "启动时注入",
    "integration.mode.file": "写配置文件",
    "integration.mode.extension": "进程内扩展",
    "integration.agentMissing": "未检测到 CLI",
    "integration.hook.revision": "Hook rev {value}", // i18n-exempt
    "integration.hook.missing": "Hook 未生成", // i18n-exempt
    "integration.skill.revision": "技能 rev {value}", // i18n-exempt
    "integration.skill.missing": "技能未生成",
    "integration.globalWrite": "信任记录写在 {path}",
    "integration.migrated": "已清理全局安装",
    "integration.regenerate": "重新生成",
    "integration.regenerated": "注入产物已重新生成",
    "integration.failed": "接入操作失败",
    "integration.legacy.count": "旧残留 {count}",
    "integration.loading": "读取中…",
    "integration.repair": "修复",
    "integration.repair.done": "已清理旧残留",
    "integration.repair.failed": "修复失败",
    "integration.repair.found": "发现 {count} 处",
    "integration.repair.removed": "移除 {count} 处",
    "integration.repair.kept": "保留 {count} 处（不是我们写的）",
    "integration.backup": "原文件已备份到 {path}",
  },
  en: {
    "integration.nav": "Integration",
    "integration.empty": "No CLI to integrate",
    "integration.mode.canvas": "Canvas only",
    "integration.mode.launch": "Injected at launch",
    "integration.mode.file": "Writes a config file",
    "integration.mode.extension": "In-process extension",
    "integration.agentMissing": "CLI not detected",
    "integration.hook.revision": "Hook rev {value}",
    "integration.hook.missing": "Hook not generated",
    "integration.skill.revision": "Skill rev {value}",
    "integration.skill.missing": "Skill not generated",
    "integration.globalWrite": "Trust records in {path}",
    "integration.migrated": "Global install removed",
    "integration.regenerate": "Regenerate",
    "integration.regenerated": "Injection regenerated",
    "integration.failed": "Integration action failed",
    "integration.legacy.count": "{count} left over",
    "integration.loading": "Loading…",
    "integration.repair": "Repair",
    "integration.repair.done": "Leftovers cleaned up",
    "integration.repair.failed": "Repair failed",
    "integration.repair.found": "Found {count}",
    "integration.repair.removed": "Removed {count}",
    "integration.repair.kept": "Kept {count} (not written by us)",
    "integration.backup": "The original was backed up to {path}",
  },
};
