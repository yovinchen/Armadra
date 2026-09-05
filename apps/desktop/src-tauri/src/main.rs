use std::{
    io::Write,
    process::{Child, Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use armadra_protocol::{Message, v1};
use tauri::{
    Manager, RunEvent, WebviewWindow, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_dialog::DialogExt;

mod host;
mod lifecycle;
mod transport;
use lifecycle::DesktopLifecycle;
use transport::{RuntimeAddress, RuntimeTransport, WebSocketForwarder};

fn trace_lifecycle(event: &str) {
    if std::env::var("ARMADRA_DESKTOP_LIFECYCLE_TRACE").as_deref() == Ok("1") {
        eprintln!("Desktop lifecycle {}: {event}", std::process::id());
    }
}

/// The Runtime's data directory as this shell resolves it, matching the Rust
/// Runtime's own `paths::data_dir`. The socket and `endpoints.json` both live
/// here, so the two processes have to agree on it without talking first.
fn runtime_data_dir() -> std::path::PathBuf {
    if let Some(path) = std::env::var_os("ARMADRA_DATA_DIR") {
        return std::path::PathBuf::from(path);
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        return std::path::PathBuf::from(home).join("Library/Application Support/Armadra");
    }
    #[cfg(target_os = "windows")]
    if let Some(path) = std::env::var_os("LOCALAPPDATA") {
        return std::path::PathBuf::from(path).join("Armadra");
    }
    std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/share"))
        })
        .unwrap_or_else(std::env::temp_dir)
        .join("armadra")
}

/// Where a *development* Runtime is: an external process the shell did not
/// start, still on its loopback port. A shell that owns its Runtime never uses
/// this — it has a socket, and no port exists to health-check.
fn external_runtime_health_url() -> String {
    let port = std::env::var("ARMADRA_RUNTIME_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(43120);
    format!("http://127.0.0.1:{port}/health")
}

#[derive(Default)]
struct RuntimeProcess(Mutex<Option<Child>>, AtomicBool);

impl RuntimeProcess {
    /// Starts the Runtime on `address` and nothing else: a shell-owned Runtime
    /// holds no TCP port, so nothing on the machine can reach it and the
    /// WebView goes through the `armadra://` protocol instead (roadmap §4.4).
    fn start(&self, address: &RuntimeAddress) -> Result<(), String> {
        if !owns_runtime(
            cfg!(not(feature = "custom-protocol")),
            std::env::var("ARMADRA_DESKTOP_OWNS_RUNTIME")
                .ok()
                .as_deref(),
        ) {
            return Ok(());
        }
        let current = std::env::current_exe().map_err(|error| error.to_string())?;
        let directory = current
            .parent()
            .ok_or_else(|| "Desktop executable has no parent directory".to_owned())?;
        let executable = directory.join(runtime_binary_name());
        let child = Command::new(&executable)
            .arg("--desktop-control-stdin")
            .arg("--listen")
            .arg(address.listen_argument())
            .stdin(Stdio::piped())
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

    /// True when this shell started the Runtime, and therefore reaches it over
    /// the socket rather than a port.
    fn owns(&self) -> bool {
        self.0.lock().is_ok_and(|child| child.is_some())
    }

    fn stop(&self) -> Result<(), String> {
        let mut slot = self.0.lock().map_err(|_| "Runtime process lock failed")?;
        let Some(mut child) = slot.take() else {
            // Development Runtime processes are external and are not ours to kill.
            return if self.1.load(Ordering::SeqCst) {
                Err(
                    "A previous Runtime shutdown failed; managed sessions require inspection"
                        .into(),
                )
            } else {
                Ok(())
            };
        };
        let control = v1::DesktopRuntimeControl {
            action: Some(v1::desktop_runtime_control::Action::Shutdown(
                v1::DesktopShutdownRequest {},
            )),
        }
        .encode_to_vec();
        let result = (|| {
            if child
                .try_wait()
                .map_err(|_| "Could not inspect Runtime process")?
                .is_some()
            {
                // An ordinary/earlier exit (even exit 0) may intentionally leave
                // tmux alive. Only our explicit control request confirms cleanup.
                return Err("Runtime already exited; managed-session shutdown was not confirmed");
            }
            let mut stdin = child
                .stdin
                .take()
                .ok_or("Runtime control pipe unavailable")?;
            stdin
                .write_all(&(control.len() as u32).to_be_bytes())
                .map_err(|_| "Could not send Runtime shutdown")?;
            stdin
                .write_all(&control)
                .map_err(|_| "Could not send Runtime shutdown")?;
            drop(stdin);
            match wait_for_child(&mut child, Duration::from_secs(12))? {
                Some(status) if status.success() => Ok(()),
                Some(_) => Err("Runtime failed to stop all managed sessions"),
                None => Err("Runtime shutdown timed out; managed sessions may still be running"),
            }
        })();
        if result.is_err() {
            self.1.store(true, Ordering::SeqCst);
            // Fallback terminates only this owned child; it is not proof that
            // persistent sessions stopped, so retain the failure for the user.
            let _ = child.kill();
            let _ = wait_for_child(&mut child, Duration::from_secs(2));
        }
        result.map_err(str::to_owned)
    }

    fn exited_early(&self) -> bool {
        self.0
            .lock()
            .ok()
            .and_then(|mut child| child.as_mut().and_then(|child| child.try_wait().ok()))
            .flatten()
            .is_some()
    }
}

fn owns_runtime(development: bool, explicit_ownership: Option<&str>) -> bool {
    !development || explicit_ownership == Some("1")
}

fn wait_for_child(
    child: &mut Child,
    timeout: Duration,
) -> Result<Option<std::process::ExitStatus>, &'static str> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Could not inspect Runtime shutdown")?
        {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(25));
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
    // A shell-owned Runtime is probed through its own socket; a development
    // Runtime we did not start is still on a loopback port.
    let owned = app.state::<RuntimeProcess>().owns();
    let transport = app.state::<RuntimeTransport>().inner().clone();
    let health_url = external_runtime_health_url();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|error| error.to_string())?;
    for _ in 0..40 {
        if app.state::<RuntimeProcess>().exited_early() {
            return Err("Runtime process exited before becoming ready".into());
        }
        let health = if owned {
            socket_health(&transport).await
        } else {
            match client.get(&health_url).send().await {
                Ok(response) if response.status().is_success() => response.json().await.ok(),
                _ => None,
            }
        };
        if health.is_some_and(|health: HealthResponse| {
            health.status == "ok" && health.version == env!("CARGO_PKG_VERSION")
        }) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("Runtime did not become healthy within 10 seconds".into())
}

async fn socket_health(transport: &RuntimeTransport) -> Option<HealthResponse> {
    let request = http::Request::builder()
        .uri("armadra://localhost/health")
        .body(Vec::new())
        .ok()?;
    let response = transport::forward(transport, request).await;
    if !response.status().is_success() {
        return None;
    }
    serde_json::from_slice(response.body()).ok()
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
    if !window.state::<DesktopLifecycle>().reveal() {
        return;
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn request_quit(app: &tauri::AppHandle) {
    if !app.state::<DesktopLifecycle>().begin_quit() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let host_result = app.state::<DesktopLifecycle>().stop_host().await;
        let runtime_app = app.clone();
        let runtime_result = tauri::async_runtime::spawn_blocking(move || {
            runtime_app.state::<RuntimeProcess>().stop()
        })
        .await
        .unwrap_or_else(|_| Err("Runtime shutdown task failed".into()));
        let result = host_result.and(runtime_result);
        if let Err(error) = result {
            eprintln!("Application shutdown incomplete: {error}");
            app.state::<DesktopLifecycle>().quit_failed();
            if let Some(window) = app.get_webview_window("main") {
                reveal(&window);
            }
            app.dialog()
                .message(format!(
                    "后台未能全部停止，应用尚未退出。请检查后台状态。\n{error}"
                ))
                .title("Armadra 退出未完成")
                .show(|_| {});
            return;
        }
        app.state::<DesktopLifecycle>().quit_completed();
        app.exit(0);
    });
}

fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    #[cfg(target_os = "macos")]
    {
        // Explicitly install the native application/Edit/Window menus. Their
        // predefined CloseWindow and Quit retain standard Command-W/Command-Q.
        Menu::default(app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri::menu::{PredefinedMenuItem, Submenu};
        let file = Submenu::with_items(
            app,
            "文件",
            true,
            &[
                &MenuItem::with_id(app, "desktop-show", "显示窗口", true, None::<&str>)?,
                &MenuItem::with_id(app, "desktop-close", "关闭窗口", true, Some("Ctrl+W"))?,
                &PredefinedMenuItem::separator(app)?,
                // Ctrl-Q remains terminal XON; it is deliberately not an accelerator.
                &MenuItem::with_id(app, "desktop-quit", "退出并停止后台", true, None::<&str>)?,
            ],
        )?;
        let edit = Submenu::with_items(
            app,
            "编辑",
            true,
            &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ],
        )?;
        let window = Submenu::with_items(
            app,
            "窗口",
            true,
            &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::maximize(app, None)?,
            ],
        )?;
        Menu::with_items(app, &[&file, &edit, &window])
    }
}

/**
 * 托盘图标（计划书 §17）。两项菜单：显示窗口 / 退出；左键单击等价于「显示窗口」。
 *
 * 图标复用 bundle 里那张——托盘不单独出一套资源，省得两边不同步。
 * 「退出」与 macOS Command-Q 共用完整后台关闭流程。
 */
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "显示窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出并停止后台", true, None::<&str>)?;
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
            "tray-quit" => request_quit(app),
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
        .manage(DesktopLifecycle::default())
        .manage(RuntimeTransport::new(RuntimeAddress::for_data_dir(
            &runtime_data_dir(),
        )))
        // The WebView's only door to a Runtime that holds no port. Every
        // request is replayed on the socket and the Runtime's own answer is
        // returned untouched, so it keeps deciding CORS and authorization.
        .register_asynchronous_uri_scheme_protocol(
            transport::SCHEME,
            |context, request, responder| {
                let transport = context
                    .app_handle()
                    .state::<RuntimeTransport>()
                    .inner()
                    .clone();
                tauri::async_runtime::spawn(async move {
                    responder.respond(transport::forward(&transport, request).await);
                });
            },
        )
        .menu(build_app_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "desktop-show" => {
                if let Some(window) = app.get_webview_window("main") {
                    reveal(&window);
                }
            }
            "desktop-close" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
            "desktop-quit" => request_quit(app),
            _ => {}
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let WindowEvent::CloseRequested { api, .. } = event
            {
                trace_lifecycle("foreground close requested");
                // Preserve unsaved editor state and frontend tasks until those
                // lifecycles migrate to Host. Closing the foreground is not quit.
                api.prevent_close();
                window.state::<DesktopLifecycle>().hide();
                let _ = window.hide();
            }
        })
        .on_page_load(|webview, _payload| mark_tauri_document(webview))
        .setup(|app| {
            trace_lifecycle("setup");
            let transport = app.state::<RuntimeTransport>().inner().clone();
            app.state::<RuntimeProcess>().start(transport.address())?;
            // WebSockets cannot travel over a custom protocol, so the terminal
            // and event streams get a loopback forwarder on a kernel-assigned
            // port. It is started only when this shell owns the Runtime; a
            // development Runtime already has a port of its own.
            if app.state::<RuntimeProcess>().owns() {
                let address = transport.address().clone();
                let forwarder_transport = transport.clone();
                let forwarder_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match WebSocketForwarder::start(address).await {
                        Ok(forwarder) => {
                            forwarder_transport
                                .set_websocket_base(Some(forwarder.base().to_owned()));
                            // The forwarder lives as long as the application.
                            forwarder_app.manage(forwarder);
                        }
                        Err(error) => {
                            eprintln!("Could not start the WebSocket forwarder: {error}");
                        }
                    }
                });
            }
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
                host::HostLaunchConfig::from_environment(development, origin, runtime_data_dir())
            })();
            if let Ok(config) = host_config {
                app.state::<DesktopLifecycle>().configure_host(config);
            } else if let Err(error) = host_config {
                eprintln!("Background {error}");
            }
            let host_app = app.handle().clone();
            // Serialize startup with explicit quit, so a late startup cannot
            // revive the Host after the user requested all services to stop.
            tauri::async_runtime::spawn(async move {
                let result = host_app.state::<DesktopLifecycle>().start_host().await;
                if let Err(error) = result {
                    eprintln!("Background {error}");
                }
            });
            tauri::async_runtime::spawn(async move {
                if let Err(error) = wait_for_runtime(&app_handle).await {
                    eprintln!("{error}");
                }
                if app_handle.state::<DesktopLifecycle>().should_show() {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Armadra desktop application");

    trace_lifecycle("enter event loop");
    application.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, .. }
            if !app_handle.state::<DesktopLifecycle>().can_exit() =>
        {
            trace_lifecycle("exit requested; stopping services");
            api.prevent_exit();
            request_quit(app_handle);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            trace_lifecycle("reopen");
            if let Some(window) = app_handle.get_webview_window("main") {
                reveal(&window);
            }
        }
        RunEvent::Ready => trace_lifecycle("ready"),
        RunEvent::Exit => trace_lifecycle("exit"),
        _ => {}
    });
    trace_lifecycle("event loop returned");
}

#[cfg(test)]
mod lifecycle_process_tests {
    use super::*;

    #[test]
    fn development_runtime_ownership_requires_explicit_launcher_opt_in() {
        assert!(owns_runtime(false, None));
        assert!(owns_runtime(true, Some("1")));
        for flag in [None, Some("0"), Some("true"), Some("")] {
            assert!(!owns_runtime(true, flag));
        }
    }

    #[cfg(unix)]
    #[test]
    fn owned_runtime_receives_shutdown_frame_and_must_exit_successfully() {
        let path = std::env::temp_dir().join(format!(
            "armadra-runtime-control-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let child = Command::new("/bin/sh")
            .args([
                "-c",
                "dd bs=1 count=6 of=\"$1\" 2>/dev/null",
                "runtime-test",
            ])
            .arg(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let runtime = RuntimeProcess(Mutex::new(Some(child)), AtomicBool::new(false));
        runtime.stop().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), [0, 0, 0, 2, 10, 0]);
        std::fs::remove_file(path).unwrap();
        runtime.stop().unwrap();
    }

    #[test]
    fn failed_shutdown_cannot_turn_into_success_on_a_second_quit() {
        let runtime = RuntimeProcess(Mutex::new(None), AtomicBool::new(true));
        assert!(runtime.stop().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn prior_successful_exit_is_not_a_managed_session_shutdown_confirmation() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        assert!(child.wait().unwrap().success());
        let runtime = RuntimeProcess(Mutex::new(Some(child)), AtomicBool::new(false));
        let error = runtime.stop().unwrap_err();
        assert!(error.contains("already exited"));
        assert!(runtime.stop().is_err());
    }
}
