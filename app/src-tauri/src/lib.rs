//! Cadorphin desktop shell. The Rust side only orchestrates: it runs the cadkit engine,
//! watches the project folder and serves files to the UI. All CAD work happens in cadkit.

mod engine;
mod reaper;
mod terminal;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde_json::{json, Value};
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

use engine::{Engine, EngineError, PythonCmd};
use terminal::Terminals;

const BUILD_TIMEOUT: Duration = Duration::from_secs(30);
const EXPORT_TIMEOUT: Duration = Duration::from_secs(120);
const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);
const IGNORED_DIRS: &[&str] = &[".cad", "__pycache__", ".git", ".venv", "node_modules"];

/// Menu items whose enabled state follows the app (e.g. Close Project needs an open project).
struct MenuState {
    close_project: MenuItem<Wry>,
}

fn set_project_menu(app: &AppHandle, open: bool) {
    if let Some(m) = app.try_state::<MenuState>() {
        let _ = m.close_project.set_enabled(open);
    }
}

struct AppState {
    python: PythonCmd,
    engine: Mutex<Option<Engine>>,
    project: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

/// Canonicalize, then drop Windows' `\\?\` prefix so paths stay readable and Python-friendly.
fn clean_path(p: &Path) -> Result<PathBuf, String> {
    let c = p.canonicalize().map_err(|e| format!("{}: {e}", p.display()))?;
    let s = c.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if !rest.starts_with("UNC\\") {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(c)
}

fn project_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.state::<AppState>().project.lock().unwrap().clone().ok_or_else(|| "No project is open".to_string())
}

/// Resolve a project-relative path and refuse anything that escapes the project folder.
fn resolve_in_project(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    let root = project_root(app)?;
    let p = clean_path(&root.join(rel))?;
    if !p.starts_with(&root) {
        return Err(format!("{rel} is outside the project folder"));
    }
    Ok(p)
}

fn failure(op: &str, code: i64, message: String) -> Value {
    json!({"ok": false, "op": op, "exit_code": code, "errors": [message],
           "bodies": [], "problems": [], "notes": [], "files": [], "log": ""})
}

/// Send one request to the engine, starting it if needed. A timeout or crash kills the worker
/// and comes back as a normal cadkit-style result (exit code 3 or 2), so the UI handles it like
/// any other failed build. Only "engine cannot start" is an Err.
fn engine_request(app: &AppHandle, req: Value, timeout: Duration) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let mut guard = state.engine.lock().unwrap();
    if guard.is_none() {
        *guard = Some(Engine::start(&state.python)?);
    }
    let op = req["op"].as_str().unwrap_or("").to_string();
    let result = guard.as_mut().unwrap().request(req, timeout);
    match result {
        Ok(v) => Ok(v),
        Err(EngineError::Failed(msg)) => Ok(failure(&op, 2, format!("cadkit error: {msg}"))),
        Err(EngineError::Timeout) => {
            *guard = None; // kill the stuck worker; the next request starts a fresh one
            Ok(failure(&op, 3, format!("Timed out after {} s (model.py took too long)", timeout.as_secs())))
        }
        Err(EngineError::Dead(tail)) => {
            *guard = None;
            Ok(failure(&op, 2, format!("The CAD engine crashed.\n{tail}")))
        }
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn is_relevant(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if parts.iter().any(|p| IGNORED_DIRS.contains(&p.as_str())) {
        return None;
    }
    let ext = rel.extension().and_then(|e| e.to_str()).unwrap_or("");
    let in_boards = parts.first().map(|p| p == "boards").unwrap_or(false);
    if ext == "py" || ext == "toml" || in_boards {
        Some(parts.join("/"))
    } else {
        None
    }
}

fn start_watcher(app: &AppHandle, root: &Path) -> Result<Debouncer<RecommendedWatcher>, String> {
    let app2 = app.clone();
    let root2 = root.to_path_buf();
    let mut debouncer = new_debouncer(WATCH_DEBOUNCE, move |res: DebounceEventResult| {
        if let Ok(events) = res {
            let mut paths: Vec<String> = events.iter().filter_map(|e| is_relevant(&root2, &e.path)).collect();
            paths.sort();
            paths.dedup();
            if !paths.is_empty() {
                let _ = app2.emit("files-changed", paths);
            }
        }
    })
    .map_err(|e| format!("Could not watch the project folder: {e}"))?;
    debouncer
        .watcher()
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| format!("Could not watch {}: {e}", root.display()))?;
    Ok(debouncer)
}

// ------------------------------------------------------------------ commands

#[tauri::command]
async fn engine_info(app: AppHandle) -> Result<Value, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let mut guard = state.engine.lock().unwrap();
        if guard.is_none() {
            *guard = Some(Engine::start(&state.python)?);
        }
        Ok(guard.as_ref().unwrap().ready.clone())
    })
    .await
}

#[tauri::command]
async fn open_project(app: AppHandle, path: String) -> Result<Value, String> {
    blocking(move || {
        let root = clean_path(Path::new(&path))?;
        let info = engine_request(&app, json!({"op": "info", "project": root}), BUILD_TIMEOUT)?;
        if info["ok"] != json!(true) {
            let msg = info["errors"][0].as_str().unwrap_or("Not a cadkit project").to_string();
            return Err(msg);
        }
        let state = app.state::<AppState>();
        *state.watcher.lock().unwrap() = None; // stop watching the previous project
        *state.project.lock().unwrap() = Some(root.clone());
        *state.watcher.lock().unwrap() = Some(start_watcher(&app, &root)?);
        set_project_menu(&app, true);
        Ok(info)
    })
    .await
}

/// Stops watching the project and forgets it. The UI closes the project's terminals itself.
#[tauri::command]
fn close_project(app: AppHandle) {
    let state = app.state::<AppState>();
    *state.watcher.lock().unwrap() = None;
    *state.project.lock().unwrap() = None;
    set_project_menu(&app, false);
}

/// Project templates for the New Project dialog (`[{id, description}]`).
#[tauri::command]
async fn list_templates(app: AppHandle) -> Result<Value, String> {
    blocking(move || {
        let res = engine_request(&app, json!({"op": "templates"}), BUILD_TIMEOUT)?;
        Ok(res["templates"].clone())
    })
    .await
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// Claude Code's folder name for a working directory's sessions: every character that is not an
/// ASCII letter or digit becomes `-` (D:\a\b becomes D--a-b).
fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Ids of the Claude Code sessions saved for `cwd`, newest first. Claude keeps each one as
/// `<config>/projects/<folder name>/<id>.jsonl`, where the config folder is CLAUDE_CONFIG_DIR or
/// ~/.claude. Read-only. The UI uses it to resume a project's conversation.
#[tauri::command]
fn claude_sessions(app: AppHandle, cwd: String) -> Vec<String> {
    let config = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => match app.path().home_dir() {
            Ok(home) => home.join(".claude"),
            Err(_) => return vec![],
        },
    };
    let want = claude_project_dir_name(cwd.trim_end_matches(['\\', '/']));
    let Ok(dirs) = std::fs::read_dir(config.join("projects")) else { return vec![] };
    // Match the folder name case-insensitively: Windows paths can arrive in either case.
    let Some(dir) = dirs.flatten().map(|d| d.path()).find(|p| {
        p.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case(&want)).unwrap_or(false)
    }) else {
        return vec![];
    };
    let mut sessions: Vec<(std::time::SystemTime, String)> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| {
                    let path = e.path();
                    let id = path.file_stem()?.to_str()?.to_string();
                    if path.extension()? != "jsonl" || !is_uuid(&id) {
                        return None;
                    }
                    Some((e.metadata().ok()?.modified().ok()?, id))
                })
                .collect()
        })
        .unwrap_or_default();
    sessions.sort_by_key(|s| std::cmp::Reverse(s.0));
    sessions.into_iter().map(|(_, id)| id).collect()
}

/// A folder name that is safe to create on every OS: no separators, reserved characters or dots-only.
fn valid_folder_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("Enter a name for the project folder".into());
    }
    if let Some(c) = name.chars().find(|c| r#"\/:*?"<>|"#.contains(*c) || c.is_control()) {
        return Err(format!("A folder name cannot contain '{c}'"));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("A folder name cannot end with a dot or a space".into());
    }
    Ok(name)
}

/// Creates `<parent>/<name>` from a template (`cadkit new`) and returns its path. The UI then opens it.
/// `description`, if given, is added to the agent instruction files as a design brief.
#[tauri::command]
async fn create_project(
    app: AppHandle,
    parent: String,
    name: String,
    template: String,
    profile: String,
    description: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        let parent = clean_path(Path::new(&parent))?;
        let dir = parent.join(valid_folder_name(&name)?);
        let req = json!({"op": "new", "dir": dir, "template": template, "profile": profile, "description": description});
        let res = engine_request(&app, req, BUILD_TIMEOUT)?;
        if res["ok"] != json!(true) {
            return Err(res["errors"][0].as_str().unwrap_or("Could not create the project").to_string());
        }
        Ok(res["path"].as_str().unwrap_or_default().to_string())
    })
    .await
}

#[tauri::command]
async fn project_info(app: AppHandle) -> Result<Value, String> {
    blocking(move || {
        let root = project_root(&app)?;
        engine_request(&app, json!({"op": "info", "project": root}), BUILD_TIMEOUT)
    })
    .await
}

#[tauri::command]
async fn build(app: AppHandle) -> Result<Value, String> {
    blocking(move || {
        let root = project_root(&app)?;
        engine_request(&app, json!({"op": "build", "project": root, "quality": "coarse"}), BUILD_TIMEOUT)
    })
    .await
}

#[tauri::command]
async fn check(app: AppHandle, level: String) -> Result<Value, String> {
    blocking(move || {
        let root = project_root(&app)?;
        // The full check measures walls and draws renders: give it as long as an export.
        let timeout = if level == "full" { EXPORT_TIMEOUT } else { BUILD_TIMEOUT };
        engine_request(&app, json!({"op": "check", "project": root, "level": level}), timeout)
    })
    .await
}

/// `force` exports even when the checks find errors (the export dialog's "Export anyway").
#[tauri::command]
async fn export(app: AppHandle, format: String, out_dir: Option<String>, force: Option<bool>) -> Result<Value, String> {
    blocking(move || {
        let root = project_root(&app)?;
        let req = json!({"op": "export", "project": root, "format": format, "out": out_dir, "cwd": root,
                         "force": force.unwrap_or(false)});
        engine_request(&app, req, EXPORT_TIMEOUT)
    })
    .await
}

/// Shows a folder in the system file manager (the export notice's "Open folder"). Relative paths
/// are inside the project. Only existing folders are opened; nothing is run from them.
#[tauri::command]
fn reveal_folder(app: AppHandle, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    let dir = if p.is_absolute() { p.to_path_buf() } else { project_root(&app)?.join(p) };
    let dir = clean_path(&dir)?;
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    let program = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open {}: {e}", dir.display()))
}

/// Change parameter values in params.toml through cadkit (format-preserving). The file
/// watcher then sees the change and the UI rebuilds, exactly as if an agent had edited it.
#[tauri::command]
async fn write_params(app: AppHandle, values: Value) -> Result<Value, String> {
    blocking(move || {
        let root = project_root(&app)?;
        let res = engine_request(&app, json!({"op": "set_params", "project": root, "values": values}), BUILD_TIMEOUT)?;
        if res["ok"] != json!(true) {
            return Err(res["errors"][0].as_str().unwrap_or("Could not write params.toml").to_string());
        }
        Ok(res)
    })
    .await
}

/// Printer profiles: bundled ones plus the open project's own `profiles/` folder.
#[tauri::command]
async fn list_profiles(app: AppHandle) -> Result<Value, String> {
    blocking(move || {
        let root = project_root(&app).ok();
        let res = engine_request(&app, json!({"op": "profiles", "project": root}), BUILD_TIMEOUT)?;
        if res["ok"] != json!(true) {
            return Err(res["errors"][0].as_str().unwrap_or("Could not list printer profiles").to_string());
        }
        Ok(res["profiles"].clone())
    })
    .await
}

/// Sets the open project's printer (`profile` in project.toml, via cadkit). As with parameters,
/// the watcher sees the file change and the UI refreshes and rebuilds.
#[tauri::command]
async fn set_profile(app: AppHandle, profile: String) -> Result<Value, String> {
    blocking(move || {
        let root = project_root(&app)?;
        let res = engine_request(&app, json!({"op": "set_profile", "project": root, "profile": profile}), BUILD_TIMEOUT)?;
        if res["ok"] != json!(true) {
            return Err(res["errors"][0].as_str().unwrap_or("Could not change the printer").to_string());
        }
        Ok(res["profile"].clone())
    })
    .await
}

/// The native menu bar. Items only emit a `menu` event with their id; the UI decides what to do.
/// Shortcuts must not collide with keys terminal programs use (Ctrl+C, Ctrl+O, Ctrl+Q, ...), since
/// a menu accelerator is taken before the focused terminal sees the key.
fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    let new = MenuItemBuilder::with_id("new", "&New Project…").build(app)?;
    let open = MenuItemBuilder::with_id("open", "&Open Project…").build(app)?;
    let close = MenuItemBuilder::with_id("close", "&Close Project").enabled(false).build(app)?;
    // Shortcuts for these live in the UI (Ctrl+Shift+E, Ctrl+Shift+C), not here: a menu accelerator
    // would take the key from a focused terminal.
    let export = MenuItemBuilder::with_id("export", "&Export…").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "E&xit").build(app)?;
    let prefs = MenuItemBuilder::with_id("preferences", "&Preferences…").accelerator("CmdOrCtrl+,").build(app)?;
    let about = MenuItemBuilder::with_id("about", "&About Cadorphin").build(app)?;
    let file = SubmenuBuilder::new(app, "&File")
        .item(&new)
        .item(&open)
        .item(&close)
        .separator()
        .item(&export)
        .separator()
        .item(&quit)
        .build()?;
    let edit = SubmenuBuilder::new(app, "&Edit");
    // macOS needs the standard edit items for copy/paste to work in text fields. Elsewhere they would
    // grab Ctrl+C/Ctrl+V from the terminal, so they are left out.
    #[cfg(target_os = "macos")]
    let edit = edit.undo().redo().separator().cut().copy().paste().select_all().separator();
    let edit = edit.item(&prefs).build()?;
    let help = SubmenuBuilder::new(app, "&Help").item(&about).build()?;
    let menu = MenuBuilder::new(app).items(&[&file, &edit, &help]).build()?;
    app.set_menu(menu)?;
    app.manage(MenuState { close_project: close });
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "quit" => app.exit(0), // RunEvent::Exit then closes the terminals
        id => {
            let _ = app.emit("menu", id.to_string());
        }
    });
    Ok(())
}

/// Write a file atomically: to `<name>.tmp`, then renamed, so a reader never sees half of it.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Point-and-fix: what the user picked in the viewer, for the agent to read. Writes
/// `.cad/selection.json` and `.cad/selection.png` (a screenshot with the selection highlighted).
/// With no `json`, the selection was cleared and both files are deleted, so an agent never acts on
/// a stale one. `.cad/` is ignored by the file watcher, so this never triggers a rebuild.
#[tauri::command]
fn write_selection(app: AppHandle, json: Option<String>, png: Option<Vec<u8>>) -> Result<(), String> {
    let dir = project_root(&app)?.join(".cad");
    let json_path = dir.join("selection.json");
    let png_path = dir.join("selection.png");
    let Some(json) = json else {
        for p in [&json_path, &png_path] {
            match std::fs::remove_file(p) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("{}: {e}", p.display())),
            }
        }
        return Ok(());
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    match png {
        Some(bytes) => write_atomic(&png_path, &bytes)?,
        None => {
            let _ = std::fs::remove_file(&png_path);
        }
    }
    write_atomic(&json_path, json.as_bytes())
}

/// Opens the user's shell in the project folder. `command`, if given, is typed into it
/// (used by the "+" menu's agent shortcuts); the shell stays open after it exits.
#[tauri::command]
fn open_terminal(app: AppHandle, cwd: Option<String>, command: Option<String>, cols: u16, rows: u16) -> Result<String, String> {
    let dir = match cwd {
        Some(c) if !c.is_empty() => PathBuf::from(c),
        _ => project_root(&app)?,
    };
    // The folder holding the engine's python (a venv's Scripts/ or bin/) also holds `cadkit`.
    let python = app.state::<AppState>().python.program.clone();
    let tools = python.is_absolute().then(|| python.parent().map(Path::to_path_buf)).flatten();
    app.state::<Terminals>().open(&app, &dir, command, tools.as_deref(), cols, rows)
}

#[tauri::command]
fn write_terminal(app: AppHandle, id: String, data: String) -> Result<(), String> {
    app.state::<Terminals>().write(&id, &data)
}

#[tauri::command]
fn resize_terminal(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    app.state::<Terminals>().resize(&id, cols, rows)
}

#[tauri::command]
fn close_terminal(app: AppHandle, id: String) {
    app.state::<Terminals>().close(&id);
}

/// What to open at startup. `--no-project` or CADORPHIN_NO_PROJECT=1 starts on the start screen
/// (and doesn't reopen the last project); otherwise a folder given as the first argument or in
/// CADORPHIN_PROJECT; otherwise the UI reopens the last project.
#[tauri::command]
fn initial_project() -> Value {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |v: Result<String, std::env::VarError>| v.map(|s| !s.is_empty() && s != "0").unwrap_or(false);
    if args.iter().any(|a| a == "--no-project") || flag(std::env::var("CADORPHIN_NO_PROJECT")) {
        return json!({"path": null, "restore": false});
    }
    let path = args
        .into_iter()
        .find(|a| !a.starts_with('-'))
        .or_else(|| std::env::var("CADORPHIN_PROJECT").ok())
        .filter(|p| Path::new(p).is_dir());
    json!({"path": path, "restore": true})
}

#[tauri::command]
fn read_file(app: AppHandle, path: String) -> Result<String, String> {
    let p = resolve_in_project(&app, &path)?;
    std::fs::read_to_string(&p).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn load_asset(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let p = resolve_in_project(&app, &path)?;
    let bytes = std::fs::read(&p).map_err(|e| format!("{path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    reaper::kill_children_with_app(); // before anything starts a child process
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            python: PythonCmd::discover(),
            engine: Mutex::new(None),
            project: Mutex::new(None),
            watcher: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            engine_info,
            initial_project,
            open_project,
            close_project,
            list_templates,
            create_project,
            claude_sessions,
            project_info,
            build,
            check,
            export,
            read_file,
            load_asset,
            write_params,
            write_selection,
            reveal_folder,
            list_profiles,
            set_profile,
            open_terminal,
            write_terminal,
            resize_terminal,
            close_terminal
        ])
        .manage(Terminals::default())
        .setup(|app| {
            build_menu(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Cadorphin")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Terminals>().close_all(); // don't leave shells (or agents) running
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{claude_project_dir_name, is_uuid, valid_folder_name};

    #[test]
    fn claude_folder_names() {
        assert_eq!(
            claude_project_dir_name(r"D:\development\projects\cadprojects\XiaoEnclosure\XiaoEnclosure"),
            "D--development-projects-cadprojects-XiaoEnclosure-XiaoEnclosure"
        );
        assert_eq!(claude_project_dir_name("/home/me/my_case.v2"), "-home-me-my-case-v2");
    }

    #[test]
    fn uuids() {
        assert!(is_uuid("8851c40f-41d0-4e8e-b379-03b91ebfb1b1"));
        for bad in ["", "8851c40f41d04e8eb37903b91ebfb1b1", "../../../../etc/passwd-000000000000000", "8851c40f-41d0-4e8e-b379-03b91ebfb1bz"] {
            assert!(!is_uuid(bad), "{bad:?}");
        }
    }

    #[test]
    fn folder_names() {
        assert_eq!(valid_folder_name("  my-case ").unwrap(), "my-case");
        for bad in ["", " ", ".", "..", "a/b", r"a\b", "a:b", "what?", "x.", "tab\there"] {
            assert!(valid_folder_name(bad).is_err(), "{bad:?} should be rejected");
        }
    }
}
