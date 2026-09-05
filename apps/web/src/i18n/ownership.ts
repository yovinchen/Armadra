import type { MessageModule } from "./index";

/** 画布写归属（H01 §4）：只读横幅与保存指示灯的文案。 */
export const ownership: MessageModule = {
  "zh-CN": {
    "ownership.maintenance": "画布正在切换写入方，现在只能查看",
    "ownership.unknown": "尚未确认画布由谁写入，暂不保存",
    "ownership.error": "无法确认画布由谁写入，暂不保存",
    "ownership.recheck": "重新检查",
    "ownership.save.readonly": "只读，未保存",
  },
  en: {
    "ownership.maintenance":
      "The canvas is switching writers and is view-only right now",
    "ownership.unknown": "Canvas writer not confirmed yet; saving is paused",
    "ownership.error": "Canvas writer could not be confirmed; saving is paused",
    "ownership.recheck": "Check again",
    "ownership.save.readonly": "Read-only, not saved",
  },
};
