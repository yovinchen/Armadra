use std::{sync::Mutex, time::Duration};

use tauri::{
    Manager, RunEvent, WebviewWindow, WindowEvent,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_dialog::DialogExt;

use armadra_desktop::{
    host,
    lifecycle::DesktopLifecycle,
    runtime_data_dir,
    runtime_process::{RuntimeProcess, external_runtime_health_url, wait_for_runtime},
    trace_lifecycle, transport,
    transport::{RuntimeAddress, RuntimeTransport, WebSocketForwarder},
    updates, usage,
};

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

/**
 * 开发构建的诊断桥：`ARMADRA_DESKTOP_DIAGNOSTIC_WS=ws://127.0.0.1:<port>` 时，
 * 把页面里的 console.error / console.warn、未捕获异常、未处理的 rejection 和
 * 非 2xx 的 fetch 逐条发到那个回环 WebSocket。
 *
 * 打包后的 WKWebView 没有开发者工具，Runtime 的 stderr 也被壳吞掉，页面出了
 * 什么错从外面完全看不见；这条桥就是为了在真实的壳里看见它。只编进 debug
 * 构建，发布版没有这段代码。
 */
#[cfg(debug_assertions)]
fn diagnostic_bridge(webview: &tauri::Webview) {
    let Ok(target) = std::env::var("ARMADRA_DESKTOP_DIAGNOSTIC_WS") else {
        return;
    };
    if !target.starts_with("ws://127.0.0.1:") {
        return;
    }
    // An optional prelude runs before the page's own scripts, e.g. to flip a
    // localStorage preference for one launch.
    let prelude = std::env::var("ARMADRA_DESKTOP_DIAGNOSTIC_PRELUDE").unwrap_or_default();
    let script = format!(
        "{prelude}\n{}",
        include_str!("diagnostic_bridge.js").replace("__TARGET__", &target)
    );
    let _ = webview.eval(&script);
}

#[cfg(not(debug_assertions))]
fn diagnostic_bridge(_webview: &tauri::Webview) {}

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
    let locale = usage::Locale::from_environment();
    // The two usage rows are disabled items: a readout, not an action. They
    // start as "unknown" rather than as empty bars, because nothing has been
    // read yet and an empty bar would read as "0% used" (roadmap §3.9).
    let [session_text, week_text] = usage::lines(locale, None);
    let session = MenuItem::with_id(app, "tray-usage-session", session_text, false, None::<&str>)?;
    let week = MenuItem::with_id(app, "tray-usage-week", week_text, false, None::<&str>)?;
    let show = MenuItem::with_id(app, "tray-show", locale.show_window(), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", locale.quit(), true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&session, &week, &separator, &show, &quit])?;
    app.manage(TrayUsage {
        session: Mutex::new(session),
        week: Mutex::new(week),
        locale,
    });

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

/// The two tray rows, kept so the poll can rewrite their labels in place.
struct TrayUsage {
    session: Mutex<MenuItem<tauri::Wry>>,
    week: Mutex<MenuItem<tauri::Wry>>,
    locale: usage::Locale,
}

/// Poll `GET /api/usage/mini` and keep the strip current (roadmap §3.9).
///
/// This uses the shell's existing Runtime channel — the same socket the
/// WebView's `armadra://` requests are replayed on — so a packaged build still
/// holds no port of its own. A read that fails leaves the previous numbers
/// alone: a momentarily unreachable Runtime is not a change in quota, and
/// blanking the strip would say something untrue.
fn start_usage_strip(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let minutes = usage::refresh_minutes(&runtime_get(&app, "/api/settings").await);
            if let Some(mini) = usage::parse(&runtime_get(&app, "/api/usage/mini").await) {
                let state = app.state::<TrayUsage>();
                let [session, week] = usage::lines(state.locale, Some(&mini));
                if let Ok(item) = state.session.lock() {
                    let _ = item.set_text(session);
                }
                if let Ok(item) = state.week.lock() {
                    let _ = item.set_text(week);
                }
            }
            tokio::time::sleep(usage::interval(minutes)).await;
        }
    });
}

/// One GET on whichever Runtime channel this shell has. An empty body means
/// "no reading", which the caller treats as "leave the strip alone".
async fn runtime_get(app: &tauri::AppHandle, path: &str) -> Vec<u8> {
    if app.state::<RuntimeProcess>().owns() {
        let transport = app.state::<RuntimeTransport>().inner().clone();
        let Ok(request) = http::Request::builder()
            .uri(format!("armadra://localhost{path}"))
            .body(Vec::new())
        else {
            return Vec::new();
        };
        let response = transport::forward(&transport, request).await;
        return if response.status().is_success() {
            response.into_body()
        } else {
            Vec::new()
        };
    }
    // A development Runtime the shell did not start is still on a loopback port.
    let url = external_runtime_health_url().replace("/health", path);
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    else {
        return Vec::new();
    };
    match client.get(url).send().await {
        Ok(response) if response.status().is_success() => response
            .bytes()
            .await
            .map(|body| body.to_vec())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
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
        // Checking for a newer build is a read. Nothing here downloads or
        // installs one, and with no signing key configured `check_for_update`
        // reports "not configured" without contacting anything (§3 S03).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            updates::updates_state,
            updates::updates_check,
            updates::updates_dismiss,
            updates::updates_download,
            updates::updates_install,
            updates::updates_restart_report
        ])
        .manage(updates::UpdatesController::default())
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
        .on_page_load(|webview, _payload| {
            mark_tauri_document(webview);
            diagnostic_bridge(webview);
        })
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
            start_usage_strip(app.handle());
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
