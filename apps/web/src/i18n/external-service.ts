import type { MessageModule } from "./index";

export const externalService: MessageModule = {
  "zh-CN": {
    "externalService.title": "对外服务",
    "externalService.note":
      "开启后，同一网络里的手机和浏览器可以经这台电脑的后台服务打开画布。终端、文件与 Git 仍在这台电脑上执行。",
    "externalService.enable": "对外提供服务",
    "externalService.address": "监听地址",
    "externalService.address.loopback": "仅本机（127.0.0.1）",
    "externalService.port": "端口",
    "externalService.port.fixed":
      "端口由服务地址决定，证书和登录状态都绑定在它上面。",
    "externalService.allowLan": "允许局域网访问",
    "externalService.allowLan.note": "选择局域网地址前需要先勾选。",
    "externalService.save": "应用",
    "externalService.saving": "正在应用…",
    "externalService.accessUrl": "访问地址",
    "externalService.qrAlt": "访问地址的二维码",
    "externalService.qrUnavailable":
      "地址过长，无法生成二维码；请直接使用上面的地址。",
    "externalService.off": "未开启：只有这台电脑上的客户端可以连接。",
    "externalService.unsupported":
      "此后台服务没有配置 HTTPS 来源与证书，无法对外提供服务。",
    "externalService.unavailable":
      "当前页面不是由后台服务提供的，无法读取这个开关。",
    "externalService.pairNote":
      "新设备打开访问地址后仍需配对：在这台电脑上运行 pair 命令，把一次性票据填进设备的登录界面。",
    "externalService.error.auth": "当前页面尚未登录后台服务。",
    "externalService.error.permission": "此设备没有修改服务设置的权限。",
    "externalService.error.invalid": "服务拒绝了这组设置。",
    "externalService.error.network": "无法连接后台服务。",
  },
  en: {
    "externalService.title": "Serve other devices",
    "externalService.note":
      "Phones and browsers on the same network can open the canvas through this computer's background service. Terminals, files and Git still run on this computer.",
    "externalService.enable": "Serve other devices",
    "externalService.address": "Listen address",
    "externalService.address.loopback": "This computer only (127.0.0.1)",
    "externalService.port": "Port",
    "externalService.port.fixed":
      "The port comes from the service address; the certificate and the signed-in session are bound to it.",
    "externalService.allowLan": "Allow local network access",
    "externalService.allowLan.note":
      "Required before a local network address can be selected.",
    "externalService.save": "Apply",
    "externalService.saving": "Applying…",
    "externalService.accessUrl": "Access address",
    "externalService.qrAlt": "QR code for the access address",
    "externalService.qrUnavailable":
      "The address is too long for a QR code; use the address above.",
    "externalService.off": "Off: only clients on this computer can connect.",
    "externalService.unsupported":
      "This background service has no HTTPS origin and certificate configured, so it cannot serve other devices.",
    "externalService.unavailable":
      "This page was not served by the background service, so this switch cannot be read.",
    "externalService.pairNote":
      "A new device still has to pair after opening the address: run the pair command on this computer and enter the one-time ticket on the device.",
    "externalService.error.auth":
      "This page is not signed in to the background service.",
    "externalService.error.permission":
      "This device may not change service settings.",
    "externalService.error.invalid": "The service rejected these settings.",
    "externalService.error.network": "Cannot reach the background service.",
  },
};
