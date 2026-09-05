//! Private command process tree. A Host-owned outer Job covers the interval
//! between suspended process creation and assignment to this nested Job.
use super::process_types::*;
use std::{
    fs::File,
    io::Write,
    mem::{size_of, zeroed},
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    ptr::{null, null_mut},
    sync::mpsc,
    time::{Duration, Instant},
};
use tokio::sync::{oneshot::error::TryRecvError, watch};
use windows_sys::Win32::{
    Foundation::*,
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::ReadFile,
    System::{
        JobObjects::*,
        Pipes::{CreatePipe, PeekNamedPipe},
        Threading::*,
    },
};

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
// Only moved between threads, never concurrently operated through this wrapper.
unsafe impl Send for Handle {}
struct Job(Handle);
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            TerminateJobObject(self.0.0, 1);
        }
    }
}
fn job() -> Option<Job> {
    unsafe {
        let handle = CreateJobObjectW(null(), null());
        if handle.is_null() {
            return None;
        }
        let job = Job(Handle(handle));
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            return None;
        }
        Some(job)
    }
}
pub fn containment_ready() -> bool {
    unsafe {
        let mut present = 0;
        IsProcessInJob(GetCurrentProcess(), null_mut(), &mut present) != 0 && present != 0
    }
}
fn active(job: &Job) -> Option<u32> {
    unsafe {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
        (QueryInformationJobObject(
            job.0.0,
            JobObjectBasicAccountingInformation,
            (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            null_mut(),
        ) != 0)
            .then_some(info.ActiveProcesses)
    }
}
fn pipe() -> Option<(Handle, Handle)> {
    unsafe {
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let (mut read, mut write) = (null_mut(), null_mut());
        if CreatePipe(&mut read, &mut write, &attributes, 65536) == 0 {
            return None;
        }
        Some((Handle(read), Handle(write)))
    }
}
fn private(handle: &Handle) -> bool {
    unsafe { SetHandleInformation(handle.0, HANDLE_FLAG_INHERIT, 0) != 0 }
}
fn wide(value: &std::ffi::OsStr) -> Option<Vec<u16>> {
    let mut text: Vec<u16> = value.encode_wide().collect();
    if text.contains(&0) {
        return None;
    }
    text.push(0);
    Some(text)
}
// Windows CRT argv quoting, with an explicit executable path (no shell lookup).
fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            if ch == '"' { slashes * 2 + 1 } else { slashes },
        ));
        slashes = 0;
        result.push(ch);
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}
struct Attributes {
    storage: Vec<usize>,
}
impl Attributes {
    fn new(handles: &[HANDLE]) -> Option<Self> {
        unsafe {
            let mut size = 0;
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
            if size == 0 {
                return None;
            }
            let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
            if InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 1, 0, &mut size) == 0
            {
                return None;
            }
            let mut result = Self { storage };
            if UpdateProcThreadAttribute(
                result.ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                std::mem::size_of_val(handles),
                null_mut(),
                null(),
            ) == 0
            {
                return None;
            }
            Some(result)
        }
    }
    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.ptr());
        }
    }
}
fn drain(handle: &Handle, output: &mut CapturedOutput, limit: usize) -> bool {
    // One bounded turn keeps cancellation responsive even for endless output.
    for _ in 0..8 {
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                handle.0,
                null_mut(),
                0,
                null_mut(),
                &mut available,
                null_mut(),
            )
        } == 0
        {
            return unsafe { GetLastError() } == ERROR_BROKEN_PIPE;
        }
        if available == 0 {
            return true;
        }
        let mut buffer = [0u8; 8192];
        let mut read = 0;
        if unsafe {
            ReadFile(
                handle.0,
                buffer.as_mut_ptr(),
                available.min(buffer.len() as u32),
                &mut read,
                null_mut(),
            )
        } == 0
        {
            return false;
        }
        output.total_bytes = output.total_bytes.saturating_add(read as u64);
        let keep = (read as usize).min(limit.saturating_sub(output.bytes.len()));
        output.bytes.extend_from_slice(&buffer[..keep]);
        output.truncated |= keep < read as usize;
    }
    true
}
fn cleanup(job: &Job, process: &Handle) -> bool {
    unsafe {
        TerminateJobObject(job.0.0, 1);
    }
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if active(job) == Some(0) && unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0 {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub async fn execute(
    spec: SpawnSpec,
    cancel: watch::Receiver<bool>,
    gate: StartGate,
) -> ExecutionResult {
    tokio::task::spawn_blocking(move || execute_sync(spec, cancel, gate))
        .await
        .unwrap_or_else(|_| ExecutionResult::failed("supervisor_failed", false, false))
}
fn execute_sync(
    spec: SpawnSpec,
    cancel: watch::Receiver<bool>,
    mut gate: StartGate,
) -> ExecutionResult {
    if !containment_ready() {
        return ExecutionResult::failed("outer_job_required", true, true);
    }
    let Some(job) = job() else {
        return ExecutionResult::failed("job_create_failed", true, true);
    };
    let Some((input, writer)) = pipe() else {
        return ExecutionResult::failed("pipe_failed", true, true);
    };
    let Some((output, child_output)) = pipe() else {
        return ExecutionResult::failed("pipe_failed", true, true);
    };
    let Some((error, child_error)) = pipe() else {
        return ExecutionResult::failed("pipe_failed", true, true);
    };
    if !private(&writer) || !private(&output) || !private(&error) {
        return ExecutionResult::failed("pipe_privacy_failed", true, true);
    }
    let Some(executable) = wide(spec.executable.as_os_str()) else {
        return ExecutionResult::failed("invalid_executable", true, true);
    };
    let Some(cwd) = wide(spec.cwd.as_os_str()) else {
        return ExecutionResult::failed("invalid_cwd", true, true);
    };
    let Some(program) = spec.executable.to_str() else {
        return ExecutionResult::failed("invalid_executable", true, true);
    };
    if !spec.executable.is_absolute()
        || !spec
            .executable
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return ExecutionResult::failed("native_executable_required", true, true);
    }
    let line = std::iter::once(program)
        .chain(spec.args.iter().map(String::as_str))
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ");
    let Some(mut line) = wide(std::ffi::OsStr::new(&line)) else {
        return ExecutionResult::failed("invalid_arguments", true, true);
    };
    if line.len() > 32767 {
        return ExecutionResult::failed("arguments_too_long", true, true);
    }
    let handles = [input.0, child_output.0, child_error.0];
    let Some(mut attributes) = Attributes::new(&handles) else {
        return ExecutionResult::failed("handle_list_failed", true, true);
    };
    let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input.0;
    startup.StartupInfo.hStdOutput = child_output.0;
    startup.StartupInfo.hStdError = child_error.0;
    startup.lpAttributeList = attributes.ptr();
    if unsafe {
        CreateProcessW(
            executable.as_ptr(),
            line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
            null(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut info,
        )
    } == 0
    {
        return ExecutionResult::failed("spawn_failed", true, true);
    }
    let process = Handle(info.hProcess);
    let thread = Handle(info.hThread);
    drop(input);
    drop(child_output);
    drop(child_error);
    drop(attributes);
    if unsafe { AssignProcessToJobObject(job.0.0, process.0) } == 0 {
        unsafe {
            TerminateProcess(process.0, 1);
        }
        let confirmed = unsafe { WaitForSingleObject(process.0, 5000) } == WAIT_OBJECT_0;
        return ExecutionResult::failed("job_assign_failed", true, confirmed);
    }
    let until = Instant::now() + spec.timeout;
    if gate.pid.send(info.dwProcessId).is_err() {
        let done = cleanup(&job, &process);
        return ExecutionResult::failed("start_observer_lost", true, done);
    }
    loop {
        match gate.permit.try_recv() {
            Ok(()) => break,
            Err(TryRecvError::Closed) => {
                let done = cleanup(&job, &process);
                return ExecutionResult::failed("start_permit_lost", true, done);
            }
            Err(TryRecvError::Empty) => {}
        }
        if *cancel.borrow() || cancel.has_changed().is_err() || Instant::now() >= until {
            let done = cleanup(&job, &process);
            return ExecutionResult::failed("start_cancelled", true, done);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if *cancel.borrow() || cancel.has_changed().is_err() || Instant::now() >= until {
        let done = cleanup(&job, &process);
        return ExecutionResult::failed("start_cancelled", true, done);
    }
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        let done = cleanup(&job, &process);
        return ExecutionResult::failed("resume_failed", true, done);
    }
    let observer = gate.running.send(()).is_ok();
    drop(thread);
    let (sent, received) = mpsc::sync_channel(1);
    let input_thread = std::thread::Builder::new()
        .name("command-stdin".into())
        .spawn(move || {
            let mut file = unsafe { File::from_raw_handle(writer.0) };
            std::mem::forget(writer);
            let result = file.write_all(&spec.stdin);
            drop(file);
            let _ = sent.send(result.is_ok());
        });
    let mut result = ExecutionResult::failed("completed", false, false);
    let mut io_ok = input_thread.is_ok();
    loop {
        io_ok &= drain(&output, &mut result.stdout, spec.output_limit);
        io_ok &= drain(&error, &mut result.stderr, spec.output_limit);
        let status = unsafe { WaitForSingleObject(process.0, 0) };
        if status == WAIT_OBJECT_0 {
            let mut code = 0;
            if unsafe { GetExitCodeProcess(process.0, &mut code) } != 0 {
                result.exit_code = Some(code as i32);
            }
            break;
        }
        if status == WAIT_FAILED {
            result.reason_code = "process_wait_failed";
            break;
        }
        result.cancelled = *cancel.borrow() || cancel.has_changed().is_err();
        result.timed_out = Instant::now() >= until;
        if result.cancelled {
            result.reason_code = "cancelled";
            break;
        }
        if result.timed_out {
            result.reason_code = "timed_out";
            break;
        }
        if !observer || !io_ok {
            result.reason_code = "command_io_failed";
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    result.cleanup_confirmed = cleanup(&job, &process);
    // Job termination closes every inherited pipe endpoint. Read only what is
    // actually available; never wait on arbitrary external pipe holders.
    io_ok &= drain(&output, &mut result.stdout, spec.output_limit);
    io_ok &= drain(&error, &mut result.stderr, spec.output_limit);
    if input_thread.is_ok() {
        match received.recv_timeout(Duration::from_secs(1)) {
            Ok(ok) => io_ok &= ok,
            Err(_) => {
                io_ok = false;
                result.cleanup_confirmed = false;
            }
        }
    }
    result.io_complete = io_ok && observer;
    if !io_ok && result.reason_code == "completed" {
        result.reason_code = "command_io_failed";
    }
    result
}

/// Match the Host's private state policy without silently repairing a directory
/// supplied by an untrusted caller. Inherited SQLite files must have the same
/// two principals; a NULL/empty/permissive or foreign-owner ACL is rejected.
fn private_acl(handle: HANDLE, directory: bool) -> std::io::Result<()> {
    use windows_sys::Win32::Security::{Authorization::*, *};
    use windows_sys::Win32::Storage::FileSystem::*;
    fn denied() -> std::io::Error {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "command state permissions are not private",
        )
    }
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let token = Handle(token);
        let mut needed = 0;
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut needed);
        if needed == 0 || needed > 16384 {
            return Err(denied());
        }
        let mut user = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
        if GetTokenInformation(
            token.0,
            TokenUser,
            user.as_mut_ptr().cast(),
            needed,
            &mut needed,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let current = (*(user.as_ptr().cast::<TOKEN_USER>())).User.Sid;
        let mut system = [0u32; 17];
        let mut sid_size = std::mem::size_of_val(&system) as u32;
        if CreateWellKnownSid(
            WinLocalSystemSid,
            null_mut(),
            system.as_mut_ptr().cast(),
            &mut sid_size,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let system = system.as_mut_ptr().cast();
        let mut owner = null_mut();
        let mut acl = null_mut();
        let mut descriptor = null_mut();
        let code = GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        );
        if code != ERROR_SUCCESS {
            return Err(std::io::Error::from_raw_os_error(code as i32));
        }
        struct Descriptor(*mut core::ffi::c_void);
        impl Drop for Descriptor {
            fn drop(&mut self) {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
        let _descriptor = Descriptor(descriptor);
        if owner.is_null()
            || IsValidSid(owner) == 0
            || (EqualSid(owner, current) == 0 && EqualSid(owner, system) == 0)
            || acl.is_null()
            || IsValidAcl(acl) == 0
            || (*acl).AceCount != 2
        {
            return Err(denied());
        }
        let mut control = 0;
        let mut revision = 0;
        if GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) == 0 {
            return Err(denied());
        }
        if directory && control & SE_DACL_PROTECTED == 0 {
            return Err(denied());
        }
        let mut seen_user = false;
        let mut seen_system = false;
        for index in 0..2 {
            let mut pointer = null_mut();
            if GetAce(acl, index, &mut pointer) == 0 || pointer.is_null() {
                return Err(denied());
            }
            let ace = &*pointer.cast::<ACCESS_ALLOWED_ACE>();
            let inheritance = if directory {
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
            } else {
                0
            };
            let flags = ace.Header.AceFlags as u32;
            if ace.Header.AceType != 0 /* ACCESS_ALLOWED_ACE_TYPE */
                || ace.Header.AceSize < 16
                || ace.Mask != FILE_ALL_ACCESS
                || flags & !INHERITED_ACE != inheritance
            {
                return Err(denied());
            }
            let sid = std::ptr::addr_of!(ace.SidStart).cast_mut().cast();
            if IsValidSid(sid) == 0 || GetLengthSid(sid) > u32::from(ace.Header.AceSize) - 8 {
                return Err(denied());
            }
            let is_user = EqualSid(sid, current) != 0;
            let is_system = EqualSid(sid, system) != 0;
            if !is_user && !is_system {
                return Err(denied());
            }
            seen_user |= is_user;
            seen_system |= is_system;
        }
        if !seen_user || !seen_system {
            return Err(denied());
        }
        let mut info: BY_HANDLE_FILE_INFORMATION = zeroed();
        if GetFileInformationByHandle(handle, &mut info) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
            || (!directory && info.nNumberOfLinks != 1)
        {
            return Err(denied());
        }
        Ok(())
    }
}
fn private_state_file(path: &std::path::Path, directory: bool) -> std::io::Result<File> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::*;
    let name = wide(path.as_os_str()).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid command state path",
        )
    })?;
    let access = if directory {
        READ_CONTROL | FILE_READ_ATTRIBUTES
    } else {
        READ_CONTROL | GENERIC_READ | GENERIC_WRITE
    };
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            0
        };
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            if directory {
                OPEN_EXISTING
            } else {
                OPEN_ALWAYS
            },
            flags,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_handle(handle) };
    private_acl(file.as_raw_handle(), directory)?;
    Ok(file)
}
pub fn verify_private_directory(path: &std::path::Path) -> std::io::Result<()> {
    drop(private_state_file(path, true)?);
    Ok(())
}
pub fn open_private_file(path: &std::path::Path) -> std::io::Result<File> {
    private_state_file(path, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_crt_arguments_without_losing_empty_quotes_or_backslashes() {
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("two words"), "\"two words\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote("C:\\path\\"), "\"C:\\path\\\\\"");
        assert_eq!(quote("中文🙂"), "\"中文🙂\"");
    }
}
