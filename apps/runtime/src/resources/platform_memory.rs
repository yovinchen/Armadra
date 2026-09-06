//! The operating system's own memory-pressure verdict (T02, terminal host
//! design §8).
//!
//! Why not compute it from used/total: on a modern kernel most "used" memory is
//! reclaimable — file caches, compressed pages, purgeable buffers — so a
//! machine sitting at 95% used is very often under no pressure at all, and a
//! ratio dressed up as a pressure level would tell the reader the opposite of
//! the truth. The panel already shows the used ratio separately; this is the
//! kernel's answer to a different question, and it is only reported where the
//! kernel actually answers it.
//!
//! macOS publishes it as `kern.memorystatus_vm_pressure_level`, the same value
//! Activity Monitor's memory-pressure graph is coloured from. Every other
//! platform reports `None`, which the panel renders as unknown — not as
//! "normal", which would be a claim nobody made.

/// `"normal"`, `"warning"`, `"critical"`, or `None` when this platform has no
/// pressure signal or the read failed.
pub fn pressure() -> Option<&'static str> {
    read()
}

/// The XNU levels (`kern_memorystatus.h`): 1 normal, 2 warning, 4 critical.
/// Anything else is a value this code does not understand, and an
/// unrecognised level is unknown rather than the nearest guess.
#[cfg(target_os = "macos")]
fn level_name(level: i32) -> Option<&'static str> {
    match level {
        1 => Some("normal"),
        2 => Some("warning"),
        4 => Some("critical"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn read() -> Option<&'static str> {
    let mut value: i32 = 0;
    let mut size = std::mem::size_of::<i32>();
    let name = c"kern.memorystatus_vm_pressure_level";
    // SAFETY: `sysctlbyname` writes at most `size` bytes into `value`, and
    // `size` is that variable's own size. The name is a NUL-terminated literal
    // and nothing is read back on failure.
    let status = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            std::ptr::from_mut(&mut value).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if status != 0 || size != std::mem::size_of::<i32>() {
        return None;
    }
    level_name(value)
}

#[cfg(not(target_os = "macos"))]
fn read() -> Option<&'static str> {
    // Linux has PSI (`/proc/pressure/memory`), but it reports stall *time*
    // rather than a level, and mapping stall percentages onto three buckets
    // would be this module inventing the thresholds. Windows has no equivalent
    // at all. Both stay unknown until there is a real signal to report.
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reported_level_is_one_of_the_three_names() {
        // On a machine with no signal this is `None`, which is the honest
        // answer; what must never happen is an invented level.
        if let Some(level) = pressure() {
            assert!(
                matches!(level, "normal" | "warning" | "critical"),
                "unexpected level {level}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_unrecognised_xnu_level_is_unknown_rather_than_the_nearest_guess() {
        assert_eq!(level_name(1), Some("normal"));
        assert_eq!(level_name(2), Some("warning"));
        assert_eq!(level_name(4), Some("critical"));
        for unknown in [0, 3, 5, -1, i32::MAX] {
            assert_eq!(level_name(unknown), None, "{unknown}");
        }
    }
}
