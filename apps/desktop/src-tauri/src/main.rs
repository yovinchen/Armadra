use std::{
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

use tauri::{
    Manager, RunEvent, WebviewWindow,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

mod host;

fn runtime_health_url() -> String {
    let port = std::env::var("ARMADRA_RUNTIME_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(43120);
    format!("http://127.0.0.1:{port}/health")
}

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
        "armadra-runtime.exe"
    } else {
        "armadra-runtime"
    }
}

#[derive(serde::Deserialize)]
struct HealthResponse {
    status: String,
    version: String,
}

async fn wait_for_runtime(app: &tauri::AppHandle) -> Result<(), String> {
    let health_url = runtime_health_url();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|error| error.to_string())?;
    for _ in 0..40 {
        if app.state::<RuntimeProcess>().exited_early() {
            return Err("Runtime process exited before becoming ready".into());
        }
        if let Ok(response) = client.get(&health_url).send().await
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

/* -------------------------------- 窗口材质 -------------------------------- */

/**
 * 侧栏毛玻璃（计划书 §24.2「源列表侧栏」「一致的窗口 chrome」）。
 *
 * 窗口在 tauri.conf.json 里是 `transparent: true`，这里给它贴上系统的
 * sidebar 材质：网页那边只把侧栏那一片留成半透明（`--sidebar-material`），
 * 画布与节点各自有实底，所以毛玻璃只会出现在该出现的地方。
 * 半径给 12，配 `titleBarStyle: Overlay` 的无边框圆角窗。
 *
 * 只有 macOS 有这个材质；其他平台什么也不做，前端回退成纯色 `--panel`。
 */
#[cfg(target_os = "macos")]
fn apply_window_material(window: &WebviewWindow) {
    use window_vibrancy::{NSVisualEffectMaterial, apply_vibrancy};

    if let Err(error) = apply_vibrancy(window, NSVisualEffectMaterial::Sidebar, None, Some(12.0)) {
        // 材质贴不上不是致命错误：窗口仍然可用，只是没有毛玻璃。
        eprintln!("Could not apply sidebar vibrancy: {error}");
    }
}

#[cfg(not(target_os = "macos"))]
fn apply_window_material(_window: &WebviewWindow) {}

/**
 * 给 <html> 打上 `data-tauri`，让样式表知道自己跑在透明窗口里
 * （见 apps/web/src/styles/tokens.css 末尾那一段）。
 *
 * 不写成 index.html 的内联脚本：CSP 是 `default-src 'self'`，内联脚本会被挡。
 * webview 的 `eval` 不走 CSP，而且挂在 `on_page_load` 上，开发时热重载
 * 整页刷新之后也会重新打上。
 */
fn mark_tauri_document(webview: &tauri::Webview) {
    let _ = webview.eval("document.documentElement.setAttribute('data-tauri','')");
}

/* --------------------------------- 托盘 ---------------------------------- */

/** 把窗口从隐藏 / 最小化里拉回前台。 */
fn reveal(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/**
 * 托盘图标（计划书 §17）。两项菜单：显示窗口 / 退出；左键单击等价于「显示窗口」。
 *
 * 图标复用 bundle 里那张——托盘不单独出一套资源，省得两边不同步。
 * 「退出」走 `app.exit(0)`，这条路径最后仍会触发 `RunEvent::Exit`，
 * Runtime sidecar 的关停逻辑（`RuntimeProcess::stop`）照常跑。
 */
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "显示窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Armadra")
        .menu(&menu)
        // 左键留给「点一下把窗口叫回来」，菜单只从右键出。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => {
                if let Some(window) = app.get_webview_window("main") {
                    reveal(&window);
                }
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
                && let Some(window) = tray.app_handle().get_webview_window("main")
            {
                reveal(&window);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    let application = tauri::Builder::default()
        // Thin shell only (plan §0): the folder picker, "open in the system
        // browser" and the notification tray are the OS capabilities the web
        // app cannot provide. Notifications back the "agent needs you / agent
        // finished" alerts of plan §5.4.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(RuntimeProcess::default())
        .on_page_load(|webview, _payload| mark_tauri_document(webview))
        .setup(|app| {
            app.state::<RuntimeProcess>().start()?;
            let app_handle = app.handle().clone();
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "Main window is unavailable".to_owned())?;
            apply_window_material(&window);
            build_tray(app.handle())?;
            let host_config = (|| {
                let development = cfg!(not(feature = "custom-protocol"));
                let origin = if development {
                    app.config()
                        .build
                        .dev_url
                        .as_ref()
                        .ok_or(host::HostLaunchError::InvalidConfiguration)?
                        .origin()
                        .ascii_serialization()
                } else if cfg!(windows) {
                    let https = app
                        .config()
                        .app
                        .windows
                        .iter()
                        .find(|config| config.label == "main")
                        .is_some_and(|config| config.use_https_scheme);
                    if https {
                        "https://tauri.localhost"
                    } else {
                        "http://tauri.localhost"
                    }
                    .to_owned()
                } else {
                    "tauri://localhost".to_owned()
                };
                host::HostLaunchConfig::from_environment(development, origin)
            })();
            // Host availability must not delay Runtime or UI startup. It has a
            // separate lifecycle and is deliberately absent from the exit hook.
            tauri::async_runtime::spawn(async move {
                let result = match host_config {
                    Ok(config) => host::ensure_host(&config).await,
                    Err(error) => Err(error),
                };
                if let Err(error) = result {
                    eprintln!("Background {error}");
                }
            });
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
        .expect("failed to build Armadra desktop application");

    application.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            app_handle.state::<RuntimeProcess>().stop();
        }
    });
}
