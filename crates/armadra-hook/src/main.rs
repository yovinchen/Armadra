//! Entry point. Everything interesting lives in the library so the integration
//! tests can drive the same code paths as the shipped binary.

use std::io::Write;
use std::process::ExitCode;

use armadra_hook::{context_usage, control, doctor, hook, USAGE};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(first) = args.first().map(String::as_str) else {
        eprint!("{USAGE}");
        return ExitCode::from(1);
    };

    let code = match first {
        "-h" | "--help" | "help" => {
            print!("{USAGE}");
            0
        }
        "--version" | "-V" => {
            println!("armadra-hook {}", env!("CARGO_PKG_VERSION"));
            0
        }
        "context" => control::run_context(&args[1..]),
        "context-usage" => context_usage::run(),
        "canvas" => control::run_canvas(&args[1..]),
        "doctor" => doctor::run(),
        agent_id if agent_id.starts_with('-') => {
            let _ = write!(std::io::stderr(), "{USAGE}");
            1
        }
        // Anything else is an agent id: this is hook mode, which always
        // succeeds so a canvas problem never breaks the user's CLI.
        agent_id => hook::run(agent_id),
    };

    ExitCode::from(code as u8)
}
