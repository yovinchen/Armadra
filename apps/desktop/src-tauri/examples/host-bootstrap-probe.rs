//! Runs the exact native startup adapter without starting a GUI or Runtime.
#[path = "../src/host.rs"]
pub mod host;

use armadra_protocol::Message;
use std::{io::Write, path::PathBuf, time::Duration};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 {
        return Err(
            "usage: host-bootstrap-probe <binary> <data-dir> <http-endpoint> <page-origin>".into(),
        );
    }
    // An empty endpoint asks the Host for no TCP surface at all (roadmap §4.4).
    let endpoint = args[2].to_str().ok_or("endpoint must be UTF-8")?;
    let config = host::HostLaunchConfig {
        binary: PathBuf::from(&args[0]),
        data_dir: Some(PathBuf::from(&args[1])),
        endpoints_dir: Some(PathBuf::from(&args[1])),
        expected_http_endpoint: (!endpoint.is_empty()).then(|| endpoint.to_owned()),
        browser_origin: args[3].to_str().ok_or("origin must be UTF-8")?.into(),
        cli_timeout: Duration::from_secs(15),
    };
    let status = host::ensure_host(&config).await?;
    std::io::stdout().write_all(&status.encode_to_vec())?;
    Ok(())
}
