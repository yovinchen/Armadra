# 本机 Host 控制协议

`Serve(ctx, listener, status, shutdown)`、`Status(ctx, dataDir)` 和 `Stop(ctx, dataDir, expectedInstanceID)` 在 localipc 的同用户连接上运行，不注册到 HTTP/CORS。

一条连接只处理一个请求：4 字节大端长度 + Protobuf，单帧最多 1 MiB，每次请求期限 3 秒，服务端最多同时处理 32 条连接。取消服务会关闭监听器和活跃连接，并等待 handler 退出。

状态响应含持久 Host ID、进程实例 ID、HTTP 地址、启动时间和诊断 PID。PID 只帮助启动器辨认自己创建的进程，不用于发送信号；停止必须绑定已观察到的实例 ID。实例不匹配返回冲突，完整 ACK 写出后才调用非阻塞 shutdown 回调。ACK 表示接受停止请求，外层仍须等待 HTTP 排空及目录锁释放才能报告停止完成。

客户端校验 requestId、响应类型和必需字段，不重试请求。发送 Stop 后没有可信 ACK，会保留 `OutcomeUnknown`，不能据此再次盲目发送停止。`ErrNotRunning` 只映射明确的端点缺失/连接拒绝，权限、取消、超时和畸形响应分别报告。

控制契约是 proto3，拒绝 group wire type；只对已知 message 字段递归预检，最多 32 层，未知 length-delimited bytes 保持不透明。固定版本 Go 解码器的 RecursionLimit 不覆盖未知 group，因此不能仅依赖该选项限制这类输入。实际消息仍由生成的 Protobuf 解码器解码。

测试覆盖真实 localipc、状态快照、实例冲突、停止 ACK、丢失 ACK、慢连接取消、帧长度/截断/深度和未知 bytes 兼容；Windows 系统调用路径仍需实机验证。
