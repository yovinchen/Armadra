use std::{
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

use tauri::{Manager, RunEvent};

const RUNTIME_HEALTH_URL: &str = "http://127.0.0.1:43120/health";

#[derive(Default)]
struct RuntimeProcess(Mutex<Option<Child>>);

impl RuntimeProcess {
    fn start(&self) -> Result<(), String> {
        if cfg!(not(feature = "custom-protocol")) {
            return Ok(());
        }
        let current = std::env::current_exe().map_err(|error| error.to_string())?;
        let directory = current
            .parent()
            .ok_or_else(|| "Desktop executable has no parent directory".to_owned())?;
        let executable = directory.join(runtime_binary_name());
        let child = Command::new(&executable)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                format!(
                    "Could not start Runtime at {}: {error}",
                    executable.display()
                )
            })?;
        *self.0.lock().map_err(|_| "Runtime process lock failed")? = Some(child);
        Ok(())
    }

    fn stop(&self) {
        if let Ok(mut child) = self.0.lock()
            && let Some(mut child) = child.take()
        {
            #[cfg(unix)]
            {
                let _ = Command::new("kill")
                    .args(["-TERM", &child.id().to_string()])
                    .status();
                for _ in 0..20 {
                    if child.try_wait().ok().flatten().is_some() {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn exited_early(&self) -> bool {
        if cfg!(not(feature = "custom-protocol")) {
            return false;
        }
        self.0
            .lock()
            .ok()
            .and_then(|mut child| child.as_mut().and_then(|child| child.try_wait().ok()))
            .flatten()
            .is_some()
    }
}

fn runtime_binary_name() -> &'static str {
    if cfg!(windows) {
        "ai-coding-canvas-runtime.exe"
    } else {
        "ai-coding-canvas-runtime"
    }
}

#[derive(serde::Deserialize)]
struct HealthResponse {
    status: String,
    version: String,
}

async fn wait_for_runtime(app: &tauri::AppHandle) -> Result<(), String> {
    for _ in 0..40 {
        if app.state::<RuntimeProcess>().exited_early() {
            return Err("Runtime process exited before becoming ready".into());
        }
        if let Ok(response) = reqwest::get(RUNTIME_HEALTH_URL).await
            && response.status().is_success()
            && let Ok(health) = response.json::<HealthResponse>().await
            && health.status == "ok"
            && health.version == env!("CARGO_PKG_VERSION")
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("Runtime did not become healthy within 10 seconds".into())
}

fn main() {
    let application = tauri::Builder::default()
        // Thin shell only (plan §0): the folder picker and "open in the system
        // browser" are the two OS capabilities the web app cannot provide.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(RuntimeProcess::default())
        .setup(|app| {
            app.state::<RuntimeProcess>().start()?;
            let app_handle = app.handle().clone();
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "Main window is unavailable".to_owned())?;
            tauri::async_runtime::spawn(async move {
                if let Err(error) = wait_for_runtime(&app_handle).await {
                    eprintln!("{error}");
                }
                let _ = window.show();
                let _ = window.set_focus();
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build AI Coding Canvas desktop application");

    application.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            app_handle.state::<RuntimeProcess>().stop();
        }
    });
}
