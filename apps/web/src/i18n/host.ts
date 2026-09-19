import type { MessageModule } from "./index";

export const host: MessageModule = {
  "zh-CN": {
    "host.nav": "后台服务",
    "host.note": "检查后台服务连接，不会切换当前正在运行的工作空间或终端。",
    "host.check": "检查连接",
    "host.cancel": "取消",
    "host.status.idle": "尚未检查连接",
    "host.status.checking": "正在检查连接…",
    "host.status.connected": "已确认服务响应",
    "host.status.cancelled": "已取消检查",
    "host.details": "连接详情",
    "host.identity": "持久服务 ID",
    "host.instance": "本次进程 ID",
    "host.legacy": "此版本尚未提供持久服务标识",
    "host.capabilities": "已装配的面",
    "host.capability.none": "本次启动没有报告任何面。",
    "host.error.network":
      "无法连接。请确认服务已启动、地址正确，且允许此页面来源。桌面端当前仅允许默认本机地址。",
    "host.error.invalidResponse": "服务返回了无效的连接信息。",
    "host.error.auth": "服务需要身份验证，当前页面尚未登录。",
    "host.error.permission": "服务拒绝访问，请检查允许的页面来源及访问权限。",
    "host.error.unsupported": "服务尚不支持本次连接检查。",
    "host.error.remote": "服务暂时无法完成连接检查。",
  },
  en: {
    "host.nav": "Background service",
    "host.note":
      "Check the background service without switching the workspace or terminals currently running.",
    "host.check": "Check connection",
    "host.cancel": "Cancel",
    "host.status.idle": "Connection not checked",
    "host.status.checking": "Checking connection…",
    "host.status.connected": "Service response confirmed",
    "host.status.cancelled": "Check cancelled",
    "host.details": "Connection details",
    "host.identity": "Persistent service ID",
    "host.instance": "Current process ID",
    "host.legacy":
      "This version does not provide a persistent service identity",
    "host.capabilities": "Assembled surfaces",
    "host.capability.none": "This run reported no surfaces.",
    "host.error.network":
      "Cannot connect. Check that the service is running, the address is correct, and this page origin is allowed. The desktop app currently allows only the default local address.",
    "host.error.invalidResponse":
      "The service returned invalid connection information.",
    "host.error.auth":
      "The service requires authentication. This page is not signed in.",
    "host.error.permission":
      "Access was denied. Check allowed page origins and access permissions.",
    "host.error.unsupported":
      "The service does not support this connection check.",
    "host.error.remote":
      "The service cannot complete the connection check right now.",
  },
};
