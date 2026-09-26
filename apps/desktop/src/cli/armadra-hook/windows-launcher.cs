// armadra-hook 的 Windows 启动器（控制台程序）。
//
// 为什么不是 .cmd：Agent 在 Windows 上的 shell 多半是 Git Bash 或 PowerShell，
// 它们调用 .cmd 时都会经过 cmd.exe，而 cmd.exe 会把整行命令再读一遍——
// `canvas send --body "a & b"` 里的 `&` 成了命令分隔符，`%PATH%` 被展开，
// 带 `\"` 的正文让引号状态错位，后半截变成另一条命令。这一层没法在 .cmd 里修好。
//
// 这个启动器只做一件事：读旁边的 `<自身名>.launch`（第一行 runner，第二行
// bundle），设 ELECTRON_RUN_AS_NODE=1，然后把**调用方原样给的命令行尾巴**接在
// `"runner" "bundle"` 后面交给 CreateProcess。调用方（Git Bash、PowerShell、
// Node 的 spawn）为一个普通 .exe 拼命令行时用的就是 MSVCRT 的引号规则，
// runner 解析时用的也是同一套规则，所以参数一个字节都不经过第二次解释。
//
// 其他几点：
//   * 控制台子系统：调用方会等它结束、拿到退出码；Electron 本身是 GUI 子系统，
//     PowerShell 直接调它不会等。
//   * 子进程放进一个 KILL_ON_JOB_CLOSE 的作业对象：调用方超时杀掉启动器时，
//     Electron 跟着退出，不会留一个孤儿进程。
//   * Ctrl+C 交给子进程处理，启动器自己只是不退出——不能用
//     SetConsoleCtrlHandler(NULL, TRUE)，那个「忽略」标志会被子进程继承。
//
// 只用 C# 5 与 .NET Framework 4 的类库：每台 Windows 10/11 都自带
// `%WINDIR%\Microsoft.NET\Framework*\v4.0.30319\csc.exe`，构建时不需要另装工具链
// （apps/desktop/scripts/hook-launcher.mjs）。以 anycpu 编译，在 arm64 上原生运行。

using System;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

internal static class ArmadraHookLauncher
{
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint INFINITE = 0xFFFFFFFF;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint cbInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    private static int Main()
    {
        try
        {
            return Run();
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("armadra-hook: " + error.Message);
            return 1;
        }
    }

    private static int Run()
    {
        string self = Assembly.GetEntryAssembly().Location;
        string config = Path.ChangeExtension(self, ".launch");
        if (!File.Exists(config))
        {
            Console.Error.WriteLine("armadra-hook: launcher config missing: " + config);
            return 1;
        }
        string[] lines = File.ReadAllLines(config, new UTF8Encoding(false));
        if (lines.Length < 2 || lines[0].Length == 0 || lines[1].Length == 0)
        {
            Console.Error.WriteLine("armadra-hook: launcher config is incomplete: " + config);
            return 1;
        }
        string runner = lines[0];
        string bundle = lines[1];

        StringBuilder commandLine = new StringBuilder();
        commandLine.Append(Quote(runner)).Append(' ').Append(Quote(bundle));
        commandLine.Append(Tail(Environment.CommandLine));

        // 写进本进程的环境块；lpEnvironment 传 NULL 时子进程继承的就是它。
        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1");

        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = Inheritable(GetStdHandle(STD_INPUT_HANDLE));
        startup.hStdOutput = Inheritable(GetStdHandle(STD_OUTPUT_HANDLE));
        startup.hStdError = Inheritable(GetStdHandle(STD_ERROR_HANDLE));

        // Ctrl+C / Ctrl+Break 到达整个控制台进程组：子进程自己处理，启动器等它退出。
        // 没有控制台（调用方用管道起的进程）时注册可能失败，那时也没有 Ctrl+C 可收。
        try
        {
            Console.CancelKeyPress += delegate (object sender, ConsoleCancelEventArgs e) { e.Cancel = true; };
        }
        catch (Exception)
        {
        }

        PROCESS_INFORMATION process;
        if (!CreateProcessW(
                runner,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                IntPtr.Zero,
                null,
                ref startup,
                out process))
        {
            int code = Marshal.GetLastWin32Error();
            Console.Error.WriteLine(
                "armadra-hook: could not start " + runner + ": " + new Win32Exception(code).Message);
            return 1;
        }

        // 作业对象失败（例如所在作业不许嵌套）不致命：只是少了「一起退出」这一条。
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job != IntPtr.Zero)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, size)
                || !AssignProcessToJobObject(job, process.hProcess))
            {
                CloseHandle(job);
                job = IntPtr.Zero;
            }
        }

        ResumeThread(process.hThread);
        CloseHandle(process.hThread);
        WaitForSingleObject(process.hProcess, INFINITE);
        uint exitCode;
        if (!GetExitCodeProcess(process.hProcess, out exitCode)) exitCode = 1;
        CloseHandle(process.hProcess);
        // 句柄留到进程退出时由系统关：此刻子进程已经结束，关不关作业都一样。
        return unchecked((int)exitCode);
    }

    /// <summary>
    /// 调用方命令行里 argv[0] 之后的部分，原样返回（带前导空白）。
    /// argv[0] 的切法与 CommandLineToArgvW 相同：以引号开头就到下一个引号为止，
    /// 中间不处理转义；否则到第一个空格或制表符为止。
    /// </summary>
    internal static string Tail(string commandLine)
    {
        int index = 0;
        if (commandLine.Length > 0 && commandLine[0] == '"')
        {
            int close = commandLine.IndexOf('"', 1);
            index = close < 0 ? commandLine.Length : close + 1;
        }
        else
        {
            while (index < commandLine.Length && commandLine[index] != ' ' && commandLine[index] != '\t')
                index++;
        }
        string rest = commandLine.Substring(index);
        // 没有参数时不留一个孤零零的空格；有参数时补一个分隔空格，引号后紧跟参数也能分开。
        if (rest.Trim().Length == 0) return "";
        return rest[0] == ' ' || rest[0] == '\t' ? rest : " " + rest;
    }

    /// <summary>
    /// 按 MSVCRT 规则给一个路径加引号：包在双引号里，结尾的反斜杠加倍。
    /// 路径里不会有双引号（Windows 文件名不允许）。
    /// </summary>
    internal static string Quote(string value)
    {
        int trailing = 0;
        while (trailing < value.Length && value[value.Length - 1 - trailing] == '\\') trailing++;
        return "\"" + value + new string('\\', trailing) + "\"";
    }

    private static IntPtr Inheritable(IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1))
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        return handle;
    }
}
