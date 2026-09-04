# M0 执行器核验记录

核验日期：2026-09-05（Asia/Shanghai）。状态：部分底层可行性已验证，跨平台及产品集成验收未完成。

## 可重复入口

代码与命令见 [探针说明](../../scripts/probes/README.md)。探针与主应用 workspace 独立，不修改根依赖；运行产物默认进入被忽略的 `target/m0-probes/`，不提交浏览器 profile、日志或截图。

## macOS Chromium 实测

| 项目 | 实测值 |
| --- | --- |
| 主机 | macOS 26.6 / arm64 |
| Node | 26.5.1 |
| 浏览器 | Google Chrome 152.0.7977.76 |
| 默认探测路径 | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| CDP 报告版本 | 1.3 |
| viewport | 1000 × 700 CSS px，deviceScaleFactor 1 |
| PNG | 26,906 字节；尺寸检查通过；首次探针截图已进行视觉检查 |
| 输入 | 鼠标聚焦/点击，英文/中文/emoji 文本插入并提交表单 |
| 滚动 | wheel 后 scrollY = 400 |
| 帧传输 | Page.startScreencast 收到帧并 ACK；可重复入口复测 1 帧，初次探针 2 帧 |
| 失败路径 | 不存在的 CHROME_PATH 返回非零状态及明确错误，无下载行为 |

以隔离临时 profile、随机本机 HTTP/CDP 端口运行 headless Chrome。初次受限沙箱内启动失败，允许进程执行的环境下通过；此环境权限差异不记录成浏览器不支持。初次探针退出后确认 CDP 端口关闭，可重复入口在 finally 退出浏览器并删除临时 profile。

Chrome 版本和 CDP 1.3 仅描述本次实测；不能据此声称所有 CDP 版本都兼容。后续受管下载需独立实现版本、签名/hash 校验及能力探测。独立数据目录符合 [Chrome 调试开关要求](https://developer.chrome.com/blog/remote-debugging-port)。

尚未验证：Windows/Linux 浏览器实机、操作系统 IME composition、tldraw 裁剪与缩放、焦点与输入事件协调、上传下载、登录持久化、人工接管、远程帧传输及延迟预算。`Input.insertText` 传入中文成功只证明文本提交路径。

## Windows ConPTY 编译核验

Rust 1.97.1，已安装 `x86_64-pc-windows-msvc` target。独立最小 API 探针使用 windows-sys 0.61.2，`cargo check --locked --offline` 通过；`cargo build` 失败，原因为 `link.exe` 缺失。本机没有生成可执行 Windows 工件，没有运行 Windows 实机测试。

另一次临时 portable-pty 0.9.0 的 cmd.exe spawn/read/write 示例完成 Windows target 离线编译检查；该结果只用于确认现有依赖可通过类型检查，未把整个 Runtime 或 Windows 持久终端标记可用。

现有终端后端只有 Direct/Tmux。Direct 的 detach_all 销毁会话；增加 Session Host 时必须分别处理后端枚举、设置、恢复和宿主生命周期。当前 process_table 使用 Unix ps，Windows foreground/子进程信息需要单独适配。

持久宿主应持续排空输出，以独立线程服务输入和输出。若采用 portable-pty 当前的 INHERIT_CURSOR 标志，必须响应光标位置查询，不能依赖已关闭的 UI；未响应查询可能在关闭时死锁。依据 [Microsoft ConPTY 创建与生命周期说明](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)。

## 下一步独立交付边界

1. Browser Worker 生命周期、独立 profile、能力探测及不可用原因；随后实现固定动作与 navigationEpoch，再接画布画面和输入。
2. Windows Session Host 独立进程、同用户 IPC 和 ConPTY 所有权；有 Windows runner 后验证关闭 UI、重启 Worker 后 PID 连续性及重附着。
3. 无头 VT 屏幕库仍待选型与 corpus 验证。输入/输出压力、最终输出排空、中文/emoji/TUI、命名管道 ACL、并发发现、退出与冷恢复均不能由本次 cargo check 代替。
