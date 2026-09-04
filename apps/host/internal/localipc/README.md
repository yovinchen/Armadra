# 本机控制传输

`Listen(dataDir)`、`Dial(ctx, dataDir)` 和 `Endpoint(dataDir)` 提供 Go Host 控制连接。调用 Listen 前必须持有该数据目录的 hoststate 锁。接口返回字节流，消息协议由上层负责。

Unix 使用规范化数据目录与当前 UID 的哈希，在短路径的私有目录中建立 UDS；检查目录 owner/0700、socket owner/0600 与文件类型。别名指向同一目录时得到同一端点，长项目路径不直接放入 sockaddr_un。

已有端点只有在确认为本人 socket、连接明确被拒绝且 inode 未改变时才可清理。活跃连接、普通文件、目录、符号链接和替换后的端点不会被覆盖。Listener 关闭时仅清理自己创建的 inode；Dial/Endpoint 不创建或删除文件。

Windows 使用固定版本 go-winio 的命名管道，配置当前用户/SYSTEM 的受保护 DACL，并禁止远程客户端。客户端在同一已连接 handle 上核验 pipe owner 与服务进程 token SID，避免连接到其他用户预先建立的同名管道；无法核验即拒绝，不当作未运行。

`ErrNotRunning` 只表示明确缺失或连接拒绝；权限、无效对象、繁忙、取消和超时是不同结果。未知平台返回 `ErrUnsupported`。

macOS race/vet 和长路径、别名、权限、替换、取消等测试已通过。Windows 的真实 API 测试已交叉编译，Linux 构建通过；这些不等于相应平台实机验收。应用的公开 HTTP/CORS 不接入这个控制通道。
