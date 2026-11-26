//! Cadorphin desktop shell. The Rust side only orchestrates: it runs the cadkit engine,
//! watches the project folder and serves files to the UI. All CAD work happens in cadkit.

mod engine;
mod terminal;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use engine::{Engine, EngineError, PythonCmd};
use terminal::Terminals;

const BUILD_TIMEOUT: Duration = Duration::from_secs(30);
const EXPORT_TIMEOUT: Duration = Duration::from_secs(120);
const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);
const IGNORED_DIRS: &[&str] = &[".cad", "__pycache__", ".git", ".venv", "node_modules"];

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
        Ok(info)
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
        engine_request(&app, json!({"op": "check", "project": root, "level": level}), BUILD_TIMEOUT)
    })
    .await
}

#[tauri::command]
async fn export(app: AppHandle, format: String, out_dir: Option<String>) -> Result<Value, String> {
    blocking(move || {
        let root = project_root(&app)?;
        let req = json!({"op": "export", "project": root, "format": format, "out": out_dir, "cwd": root});
        engine_request(&app, req, EXPORT_TIMEOUT)
    })
    .await
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

/// Project to open at startup: first command-line argument, else CADORPHIN_PROJECT.
#[tauri::command]
fn initial_project() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .or_else(|| std::env::var("CADORPHIN_PROJECT").ok())
        .filter(|p| Path::new(p).is_dir())
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
            project_info,
            build,
            check,
            export,
            read_file,
            load_asset,
            write_params,
            open_terminal,
            write_terminal,
            resize_terminal,
            close_terminal
        ])
        .manage(Terminals::default())
        .build(tauri::generate_context!())
        .expect("error while building Cadorphin")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Terminals>().close_all(); // don't leave shells (or agents) running
            }
        });
}
