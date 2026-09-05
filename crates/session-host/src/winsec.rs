//! Win32 identity and containment: who we are, who is on the other end of a
//! pipe, and the Job Object that owns a session's process tree.
//!
//! The pattern follows `apps/runtime/src/command/platform_windows.rs`, which
//! already runs this shape in production for the command worker. What is
//! different here is *who holds the Job*: it must be this process, never the
//! Worker and never the Tauri shell, because the whole point of the session
//! host is that those two can exit while the terminals keep running
//! (terminal host design §3, rule 4).

#![cfg(windows)]

use std::{ffi::OsStr, io, mem::size_of, os::windows::ffi::OsStrExt, ptr::null_mut};

use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, LocalFree},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject,
        },
        Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId},
        Threading::{
            GetCurrentProcess, GetCurrentProcessId, GetExitCodeProcess, OpenProcess,
            OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};

/// An owned Win32 handle.
pub struct Handle(pub HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

// Handles are moved between threads but never used through this wrapper from
// two at once.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn last_error(context: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::Other,
        format!("{context}: {}", io::Error::last_os_error()),
    )
}

/// The SID of the user this process runs as, as a string.
pub fn current_sid() -> io::Result<String> {
    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(last_error("OpenProcessToken"));
        }
        let token = Handle(token);
        sid_of_token(token.0)
    }
}

/// # Safety
/// `token` must be a valid token handle open for `TOKEN_QUERY`.
unsafe fn sid_of_token(token: HANDLE) -> io::Result<String> {
    unsafe {
        let mut needed = 0u32;
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut needed);
        if needed == 0 {
            return Err(last_error("GetTokenInformation size"));
        }
        let mut buffer = vec![0u8; needed as usize];
        if GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        ) == 0
        {
            return Err(last_error("GetTokenInformation"));
        }
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text: *mut u16 = null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return Err(last_error("ConvertSidToStringSidW"));
        }
        let mut length = 0;
        while *text.add(length) != 0 {
            length += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
        LocalFree(text.cast());
        Ok(sid)
    }
}

/// A self-freeing security descriptor built from SDDL, ready to hand to
/// `CreateNamedPipe`.
pub struct SecurityAttributes {
    descriptor: *mut std::ffi::c_void,
    attributes: SECURITY_ATTRIBUTES,
}

impl SecurityAttributes {
    pub fn from_sddl(sddl: &str) -> io::Result<Self> {
        unsafe {
            let mut descriptor = null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(sddl).as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            ) == 0
            {
                return Err(last_error(
                    "ConvertStringSecurityDescriptorToSecurityDescriptorW",
                ));
            }
            Ok(Self {
                descriptor,
                attributes: SECURITY_ATTRIBUTES {
                    nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: descriptor,
                    bInheritHandle: 0,
                },
            })
        }
    }

    /// The pointer `ServerOptions::create_with_security_attributes_raw` wants.
    ///
    /// # Safety
    /// The returned pointer is valid only while `self` lives.
    pub fn as_ptr(&mut self) -> *mut std::ffi::c_void {
        (&mut self.attributes as *mut SECURITY_ATTRIBUTES).cast()
    }
}

impl Drop for SecurityAttributes {
    fn drop(&mut self) {
        if !self.descriptor.is_null() {
            unsafe { LocalFree(self.descriptor) };
        }
    }
}

/// The SID of the process on the client end of a connected pipe.
///
/// The identity is taken from *this* handle, never by looking the name up
/// again: a check against a separately opened connection could be answered by
/// a different server. Mirrors `inspectPipeServer` in the Go host, from the
/// other direction.
///
/// # Safety
/// `pipe` must be a connected named pipe server handle.
pub unsafe fn client_sid(pipe: HANDLE) -> io::Result<String> {
    unsafe {
        let mut pid = 0u32;
        if GetNamedPipeClientProcessId(pipe, &mut pid) == 0 {
            return Err(last_error("GetNamedPipeClientProcessId"));
        }
        sid_of_pid(pid, "client")
    }
}

/// The SID of the process serving a connected pipe — the check the Worker
/// makes before it trusts a host it found at a predictable name.
///
/// # Safety
/// `pipe` must be a connected named pipe client handle.
pub unsafe fn server_sid(pipe: HANDLE) -> io::Result<String> {
    unsafe {
        let mut pid = 0u32;
        if GetNamedPipeServerProcessId(pipe, &mut pid) == 0 {
            return Err(last_error("GetNamedPipeServerProcessId"));
        }
        sid_of_pid(pid, "server")
    }
}

/// # Safety
/// Opens and closes a process handle; safe to call with any pid.
unsafe fn sid_of_pid(pid: u32, role: &str) -> io::Result<String> {
    unsafe {
        if pid == 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("pipe {role} has no process"),
            ));
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return Err(last_error("OpenProcess"));
        }
        let process = Handle(process);
        // A process that has already exited could have had its id reused; the
        // token below would then belong to somebody else entirely.
        let mut exit_code = 0u32;
        const STILL_ACTIVE: u32 = 259;
        if GetExitCodeProcess(process.0, &mut exit_code) == 0 {
            return Err(last_error("GetExitCodeProcess"));
        }
        if exit_code != STILL_ACTIVE {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("pipe {role} process has exited"),
            ));
        }
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(process.0, TOKEN_QUERY, &mut token) == 0 {
            return Err(last_error("OpenProcessToken"));
        }
        let token = Handle(token);
        sid_of_token(token.0)
    }
}

/// One session's process tree.
///
/// `KILL_ON_JOB_CLOSE` is the containment guarantee: if this host dies for any
/// reason, including being killed, the CLIs it started go with it rather than
/// becoming orphans nobody can find. Design §3 chooses that deliberately — an
/// unreachable agent still holding a worktree is worse than an honest "the
/// session host died, these runs are lost".
pub struct SessionJob(Handle);

impl SessionJob {
    pub fn new() -> io::Result<Self> {
        unsafe {
            let handle = CreateJobObjectW(null_mut(), std::ptr::null());
            if handle.is_null() {
                return Err(last_error("CreateJobObjectW"));
            }
            let job = Self(Handle(handle));
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(last_error("SetInformationJobObject"));
            }
            Ok(job)
        }
    }

    /// Puts a process and everything it spawns under this job.
    ///
    /// # Safety
    /// `process` must be a valid process handle with `PROCESS_SET_QUOTA` and
    /// `PROCESS_TERMINATE`.
    pub unsafe fn assign(&self, process: HANDLE) -> io::Result<()> {
        if unsafe { AssignProcessToJobObject(self.0.0, process) } == 0 {
            return Err(last_error("AssignProcessToJobObject"));
        }
        Ok(())
    }

    /// Ends the whole tree. This is the Windows spelling of SIGKILL; a polite
    /// shutdown is a Ctrl+C written into the PTY first, and then this.
    pub fn terminate(&self) {
        unsafe { TerminateJobObject(self.0.0, 1) };
    }
}

/// This process' id, for `welcome`.
pub fn current_pid() -> u32 {
    unsafe { GetCurrentProcessId() }
}
