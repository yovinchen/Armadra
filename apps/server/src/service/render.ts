import { GENERATED_MARKER, type Spec, dirFor, specArguments } from "./spec";

/**
 * 三种平台的定义渲染器。全是纯函数：同一份 Spec 永远渲染出同样的字节。
 *
 * 三份文件都只是**文件**：plist 不会被 load，unit 不会被 enable，Windows 那份
 * 干脆就是一段「运维自己去运行」的脚本。这条规则在每份文件的头几行里用大白话
 * 写着，因为读到它的人多半是在决定要不要执行它。
 */

export function render(spec: Spec): string {
  switch (spec.platform) {
    case "darwin":
      return renderLaunchd(spec);
    case "linux":
      return renderSystemd(spec);
    default:
      return renderWindows(spec);
  }
}

/* --------------------------------- launchd -------------------------------- */

export function renderLaunchd(spec: Spec): string {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
  );
  lines.push(
    `<!-- 由 ${GENERATED_MARKER} 生成。没有注册，也没有启动任何东西。 -->`,
  );
  lines.push(`<plist version="1.0">`);
  lines.push(`<dict>`);
  lines.push(...plistString(1, "Label", spec.identifier));
  lines.push(`${indent(1)}<key>ProgramArguments</key>`);
  lines.push(`${indent(1)}<array>`);
  for (const argument of [spec.executable, ...specArguments(spec)]) {
    lines.push(`${indent(2)}<string>${escapeXml(argument)}</string>`);
  }
  lines.push(`${indent(1)}</array>`);
  lines.push(...plistString(1, "UserName", spec.runAs));
  lines.push(...plistString(1, "WorkingDirectory", spec.workingDir));
  lines.push(...plistString(1, "StandardOutPath", spec.logPath));
  lines.push(...plistString(1, "StandardErrorPath", spec.logPath));
  lines.push(`${indent(1)}<key>RunAtLoad</key>`, `${indent(1)}<true/>`);
  lines.push(`${indent(1)}<key>KeepAlive</key>`, `${indent(1)}<true/>`);
  // core 收到 SIGTERM 会排空 HTTP 再退出；Background 让 launchd 不按交互任务
  // 去限流它。
  lines.push(...plistString(1, "ProcessType", "Background"));
  if (spec.environment.length > 0) {
    lines.push(`${indent(1)}<key>EnvironmentVariables</key>`);
    lines.push(`${indent(1)}<dict>`);
    for (const entry of spec.environment) {
      const [name, value] = cut(entry);
      lines.push(...plistString(2, name, value));
    }
    lines.push(`${indent(1)}</dict>`);
  }
  lines.push(`</dict>`);
  lines.push(`</plist>`);
  return `${lines.join("\n")}\n`;
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

function plistString(depth: number, key: string, value: string): string[] {
  return [
    `${indent(depth)}<key>${escapeXml(key)}</key>`,
    `${indent(depth)}<string>${escapeXml(value)}</string>`,
  ];
}

/** 显式转义，而不是交给某个库：定义的字节必须跨版本稳定。 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* --------------------------------- systemd -------------------------------- */

export function renderSystemd(spec: Spec): string {
  const lines: string[] = [];
  lines.push(`# 由 ${GENERATED_MARKER} 生成。没有注册，也没有启动任何东西。`);
  lines.push(`# 审阅之后自己复制进 unit 目录，再自己决定何时 enable。`);
  lines.push("");
  lines.push("[Unit]");
  lines.push(`Description=Armadra 服务器壳 (${systemdValue(spec.identifier)})`);
  lines.push("Documentation=https://github.com/yovinchen/Armadra");
  lines.push("After=network-online.target");
  lines.push("Wants=network-online.target");
  lines.push("");
  lines.push("[Service]");
  lines.push("Type=simple");
  lines.push(
    `ExecStart=${[spec.executable, ...specArguments(spec)]
      .map(systemdQuote)
      .join(" ")}`,
  );
  lines.push(`User=${systemdValue(spec.runAs)}`);
  lines.push(`WorkingDirectory=${systemdValue(spec.workingDir)}`);
  lines.push(`StandardOutput=append:${systemdValue(spec.logPath)}`);
  lines.push(`StandardError=append:${systemdValue(spec.logPath)}`);
  lines.push("Restart=on-failure");
  lines.push("RestartSec=5");
  // core 在 SIGTERM 上排空 HTTP、撤回端点文件并关库，给它时间，而不是在写到
  // 一半时被杀掉。
  lines.push("KillSignal=SIGTERM");
  lines.push("TimeoutStopSec=30");
  for (const entry of spec.environment) {
    const [name, value] = cut(entry);
    lines.push(`Environment=${name}=${systemdQuote(value)}`);
  }
  lines.push("");
  lines.push(
    "# 加固到此为止：ProtectHome 与 ProtectSystem=strict 是故意不设的，",
  );
  lines.push("# 因为 core 要在使用者自己的工作区里跑他们自己的命令。");
  lines.push("NoNewPrivileges=true");
  lines.push("ProtectSystem=full");
  lines.push("ProtectKernelTunables=true");
  lines.push("ProtectKernelModules=true");
  lines.push("ProtectControlGroups=true");
  lines.push("RestrictSUIDSGID=true");
  lines.push("RestrictRealtime=true");
  lines.push("LockPersonality=true");
  const writable = readWritePaths(spec);
  if (writable.length > 0) {
    lines.push(`ReadWritePaths=${writable.map(systemdQuote).join(" ")}`);
  }
  lines.push("UMask=0077");
  lines.push("");
  lines.push("[Install]");
  lines.push("WantedBy=multi-user.target");
  return `${lines.join("\n")}\n`;
}

/** `ProtectSystem=full` 之下仍然必须可写的那几个目录，去重并排序。 */
export function readWritePaths(spec: Spec): string[] {
  const unique = new Set(
    [spec.dataDir, spec.workingDir, dirFor(spec.platform, spec.logPath)].filter(
      (value) => value !== "" && value !== ".",
    ),
  );
  return [...unique].sort();
}

export function systemdEscape(value: string): string {
  // 百分号要加倍：systemd 在引号里也会做 specifier 展开。
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
}

function systemdQuote(value: string): string {
  return `"${systemdEscape(value)}"`;
}

function systemdValue(value: string): string {
  return value.replace(/%/g, "%%");
}

/* --------------------------------- Windows -------------------------------- */

export function renderWindows(spec: Spec): string {
  const lines: string[] = [];
  lines.push("@echo off");
  lines.push(`REM 由 ${GENERATED_MARKER} 生成。什么都没有安装。`);
  lines.push("REM 这是一份可审阅的定义，不是一次安装。");
  lines.push("REM 想注册这个服务，请自己在提升权限的命令行里运行它。");
  lines.push("REM 这里不写任何账号凭据：密码由 sc.exe 向你要，或者你自己给该");
  lines.push("REM 账号授予「作为服务登录」的权利。");
  lines.push("");
  lines.push(`set ARMADRA_SERVICE=${windowsPlain(spec.identifier)}`);
  lines.push(`set ARMADRA_ACCOUNT=${windowsPlain(spec.runAs)}`);
  lines.push(`set ARMADRA_WORKDIR=${windowsPlain(spec.workingDir)}`);
  lines.push(`set ARMADRA_LOG=${windowsPlain(spec.logPath)}`);
  for (const entry of spec.environment) {
    const [name, value] = cut(entry);
    lines.push(`REM environment: ${windowsPlain(name)}=${windowsPlain(value)}`);
  }
  lines.push("");
  lines.push(
    `sc.exe create "%ARMADRA_SERVICE%" binPath= ${windowsQuote(commandLine(spec))}` +
      ` obj= "%ARMADRA_ACCOUNT%" start= auto DisplayName= "Armadra Server"`,
  );
  lines.push(
    `sc.exe description "%ARMADRA_SERVICE%" "Armadra 服务器壳后台服务"`,
  );
  lines.push(
    `sc.exe failure "%ARMADRA_SERVICE%" reset= 86400 actions= restart/5000/restart/5000/restart/30000`,
  );
  lines.push("");
  lines.push("REM 诊断写在 %ARMADRA_LOG%。");
  lines.push('REM 准备好之后自己启动它：  sc.exe start "%ARMADRA_SERVICE%"');
  return `${lines.join("\r\n")}\r\n`;
}

function commandLine(spec: Spec): string {
  return [spec.executable, ...specArguments(spec)]
    .map(windowsArgument)
    .join(" ");
}

function windowsArgument(value: string): string {
  if (value !== "" && !/[ \t"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function windowsQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function windowsPlain(value: string): string {
  return value.replace(/%/g, "%%");
}

/* ---------------------------------- 归属 ---------------------------------- */

/**
 * 这份内容看起来是不是本命令为这个 Spec 生成的：同一个标识、同一个程序路径、
 * 加上那句生成标记。`uninstall` 不删任何通不过这条检查的文件，所以运维自己那个
 * 恰好同名的 unit 能活下来。
 */
export function owns(content: string, spec: Spec): boolean {
  return (
    content.includes(GENERATED_MARKER) &&
    content.includes(spec.identifier) &&
    content.includes(executableToken(spec))
  );
}

function executableToken(spec: Spec): string {
  switch (spec.platform) {
    case "darwin":
      return escapeXml(spec.executable);
    case "linux":
      return systemdEscape(spec.executable);
    default:
      return spec.executable;
  }
}

function cut(entry: string): [string, string] {
  const separator = entry.indexOf("=");
  return separator < 0
    ? [entry, ""]
    : [entry.slice(0, separator), entry.slice(separator + 1)];
}
