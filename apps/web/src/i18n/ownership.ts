import type { MessageModule } from "./index";

/**
 * 写归属（H01 §4；Go Host 业务所有权迁移 §2.2、§2.11）：只读横幅、保存指示灯，
 * 以及设置页里六个域的归属表。
 *
 * 原因键是服务发来的稳定键（`ownership.switch.pending` 之类），照原样翻译；
 * 没登记的键不显示，免得把内部字符串糊到界面上。
 */
export const ownership: MessageModule = {
  "zh-CN": {
    "ownership.maintenance": "画布正在切换写入方，现在只能查看",
    "ownership.unknown": "尚未确认画布由谁写入，暂不保存",
    "ownership.error": "无法确认画布由谁写入，暂不保存",
    "ownership.recheck": "重新检查",
    "ownership.settings.readonly": "设置正在切换写入方，现在只能查看",
    "ownership.settings.error": "无法确认设置由谁写入，现在只能查看",
    "ownership.settings.unconfirmed": "尚未确认设置由谁写入，这次保存没有发出",
    "ownership.settings.host": "设置的写入已经交给 Host，请重新打开设置页",
    "ownership.save.readonly": "只读，未保存",
    "ownership.title": "写入归属",
    "ownership.note": "切换归属要在本机执行 armadra-host ownership switch。",
    "ownership.loading": "正在读取各域归属…",
    "ownership.unavailable": "读不到归属记录，界面不显示归属状态。",
    "ownership.epoch": "纪元",
    "ownership.domain.canvas": "画布",
    "ownership.domain.settings": "设置",
    "ownership.domain.filesystem": "文件",
    "ownership.domain.session": "会话",
    "ownership.domain.agent": "Agent",
    "ownership.domain.git": "Git",
    "ownership.writer.runtime": "Runtime",
    "ownership.writer.host": "Host",
    "ownership.writer.maintenance": "维护窗口",
    "ownership.writer.unknown": "未知",
    "ownership.writer.error": "读取失败",
    "ownership.reason.ownership.switch.pending": "切换进行中，两侧都拒绝写入",
    "ownership.reason.ownership.switch.unknown":
      "Runtime 的状态没读到，窗口保持打开",
    "ownership.reason.ownership.rollback.exported": "已写出反向导出包，待交回",
  },
  en: {
    "ownership.maintenance":
      "The canvas is switching writers and is view-only right now",
    "ownership.unknown": "Canvas writer not confirmed yet; saving is paused",
    "ownership.error": "Canvas writer could not be confirmed; saving is paused",
    "ownership.recheck": "Check again",
    "ownership.settings.readonly":
      "Settings are switching writers and are view-only right now",
    "ownership.settings.error":
      "The settings writer could not be confirmed; settings are view-only",
    "ownership.settings.unconfirmed":
      "The settings writer is not confirmed; this save was not sent",
    "ownership.settings.host":
      "Settings writes have moved to the Host; reopen this page",
    "ownership.save.readonly": "Read-only, not saved",
    "ownership.title": "Write ownership",
    "ownership.note":
      "Switching is done at this machine with armadra-host ownership switch.",
    "ownership.loading": "Reading each domain's owner…",
    "ownership.unavailable":
      "The ownership record could not be read; no owner is shown.",
    "ownership.epoch": "Epoch",
    "ownership.domain.canvas": "Canvas",
    "ownership.domain.settings": "Settings",
    "ownership.domain.filesystem": "Files",
    "ownership.domain.session": "Sessions",
    "ownership.domain.agent": "Agents",
    "ownership.domain.git": "Git",
    "ownership.writer.runtime": "Runtime",
    "ownership.writer.host": "Host",
    "ownership.writer.maintenance": "Maintenance window",
    "ownership.writer.unknown": "Unknown",
    "ownership.writer.error": "Unreadable",
    "ownership.reason.ownership.switch.pending":
      "A switch is open; both sides refuse writes",
    "ownership.reason.ownership.switch.unknown":
      "The Runtime's state was not read; the window stays open",
    "ownership.reason.ownership.rollback.exported":
      "The reverse export is written; the epoch has not moved back yet",
  },
};
