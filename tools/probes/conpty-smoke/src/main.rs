use std::ptr::{null, null_mut};
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::{
        Console::{COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole},
        Pipes::CreatePipe,
    },
};
fn main() {
    unsafe {
        let (mut input_read, mut input_write, mut output_read, mut output_write) =
            (null_mut(), null_mut(), null_mut(), null_mut());
        assert_ne!(CreatePipe(&mut input_read, &mut input_write, null(), 0), 0);
        assert_ne!(
            CreatePipe(&mut output_read, &mut output_write, null(), 0),
            0
        );
        let mut con: HPCON = 0;
        assert_eq!(
            CreatePseudoConsole(
                COORD { X: 80, Y: 24 },
                input_read,
                output_write,
                0,
                &mut con
            ),
            0
        );
        assert_eq!(ResizePseudoConsole(con, COORD { X: 120, Y: 40 }), 0);
        ClosePseudoConsole(con);
        for handle in [input_read, input_write, output_read, output_write] {
            CloseHandle(handle);
        }
    }
}
