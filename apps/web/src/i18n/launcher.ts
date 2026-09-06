import type { MessageModule } from "./index";

/**
 * 工作空间的打开 / 新建 / 克隆 / 移除，外加那两个对话框（§20 →§27）。
 *
 * 首页删掉之后这些串只剩侧栏顶行的下拉、工作空间行菜单与两个对话框在用，
 * 模块名保留 `launcher` 以免键名整体搬家。
 */
export const launcher: MessageModule = {
  "zh-CN": {
    "launcher.newFolder": "新建文件夹",
    "launcher.open": "打开文件夹",
    "launcher.clone": "克隆仓库",
    "launcher.remove": "从列表移除",
    "launcher.removeTitle": "移除工作空间？",
    "launcher.removeNote": "不会删除磁盘文件",
    "launcher.removeConfirm": "移除",
    "launcher.cancel": "取消",

    "folder.parent": "父目录",
    "folder.choose": "选择",

    "clone.url": "仓库地址",
    "clone.start": "克隆",
    "clone.progress": "克隆进度",
  },
  en: {
    "launcher.newFolder": "New folder",
    "launcher.open": "Open folder",
    "launcher.clone": "Clone repository",
    "launcher.remove": "Remove from list",
    "launcher.removeTitle": "Remove workspace?",
    "launcher.removeNote": "Files on disk are not deleted",
    "launcher.removeConfirm": "Remove",
    "launcher.cancel": "Cancel",

    "folder.parent": "Parent folder",
    "folder.choose": "Choose",

    "clone.url": "Repository URL",
    "clone.start": "Clone",
    "clone.progress": "Clone progress",
  },
};
