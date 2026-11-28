//! The CAD engine: one long-lived `python -m cadkit serve` process.
//!
//! Importing build123d takes seconds, so we keep one worker alive and send it JSON-lines
//! requests. A request that runs past its timeout kills the worker; the next request starts
//! a fresh one. See cadkit/src/cadkit/serve.py for the protocol.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
const STDERR_TAIL: usize = 6000;

/// How to run Python. Release builds ship their own (scripts/bundle_python.py); dev builds
/// use the repo's .venv; otherwise the user's Python with cadkit installed.
#[derive(Clone, Debug)]
pub struct PythonCmd {
    pub program: PathBuf,
    /// Folder put first on the terminals' PATH, so `cadkit` there is the app's own.
    pub tools: Option<PathBuf>,
    /// The app's own Python: keep the user's PYTHON* variables and site-packages out of it.
    pub bundled: bool,
}

impl PythonCmd {
    /// CADORPHIN_PYTHON wins; then the repo's .venv (dev builds), the Python bundled under
    /// `resources` (release builds), and finally `python` on PATH.
    pub fn discover(resources: Option<&Path>) -> Self {
        if let Ok(p) = std::env::var("CADORPHIN_PYTHON") {
            if !p.trim().is_empty() {
                return Self::user(PathBuf::from(p));
            }
        }
        #[cfg(debug_assertions)]
        {
            let venv = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join(".venv");
            let py = if cfg!(windows) { venv.join("Scripts").join("python.exe") } else { venv.join("bin").join("python") };
            if py.exists() {
                return Self::user(py);
            }
        }
        if let Some(root) = resources.map(|r| r.join("python")) {
            let py = if cfg!(windows) { root.join("python.exe") } else { root.join("bin").join("python3") };
            if py.exists() {
                return Self { program: py, tools: Some(root.join("shims")), bundled: true };
            }
        }
        Self::user(PathBuf::from(if cfg!(windows) { "python" } else { "python3" }))
    }

    /// A Python the user set up. Its scripts folder (a venv's Scripts/ or bin/) also holds `cadkit`.
    fn user(program: PathBuf) -> Self {
        let tools = program.is_absolute().then(|| program.parent().map(Path::to_path_buf)).flatten();
        Self { program, tools, bundled: false }
    }
}

pub enum EngineError {
    Timeout,
    Dead(String),
    Failed(String),
}

pub struct Engine {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    stderr: Arc<Mutex<String>>,
    next_id: u64,
    pub ready: Value,
}

fn setup_hint(python: &PythonCmd) -> String {
    if python.bundled {
        return format!(
            "Cadorphin's built-in Python did not start; reinstalling Cadorphin should fix it. Tried: {}",
            python.program.display()
        );
    }
    format!(
        "Cadorphin needs Python 3.11–3.12 with cadkit installed, \
         or set CADORPHIN_PYTHON to a Python that has it. Tried: {}",
        python.program.display()
    )
}

impl Engine {
    pub fn start(python: &PythonCmd) -> Result<Self, String> {
        let mut cmd = Command::new(&python.program);
        if python.bundled {
            cmd.args(["-E", "-s"]); // ignore PYTHONPATH/PYTHONHOME and the user's site-packages
        }
        cmd.args(["-m", "cadkit", "serve"])
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start the CAD engine: {e}. {}", setup_hint(python)))?;

        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let mut stderr_pipe = child.stderr.take().expect("piped stderr");

        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Keep the tail of stderr for error messages (tracebacks, missing modules).
        let stderr = Arc::new(Mutex::new(String::new()));
        let sink = stderr.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = stderr_pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut s = sink.lock().unwrap();
                s.push_str(&String::from_utf8_lossy(&buf[..n]));
                if s.len() > STDERR_TAIL * 2 {
                    let cut = s.len() - STDERR_TAIL;
                    let cut = (cut..s.len()).find(|&i| s.is_char_boundary(i)).unwrap_or(cut);
                    *s = s[cut..].to_string();
                }
            }
        });

        let mut engine = Self { child, stdin, lines, stderr, next_id: 1, ready: Value::Null };
        match engine.lines.recv_timeout(STARTUP_TIMEOUT) {
            Ok(line) => match serde_json::from_str::<Value>(&line) {
                Ok(v) if v.get("ready") == Some(&Value::Bool(true)) => {
                    engine.ready = v;
                    engine.ready["python"] = json!(python.program.display().to_string());
                    Ok(engine)
                }
                _ => Err(format!("The CAD engine sent an unexpected first line: {line}")),
            },
            Err(RecvTimeoutError::Timeout) => Err("The CAD engine did not start within 120 s.".into()),
            Err(RecvTimeoutError::Disconnected) => {
                std::thread::sleep(Duration::from_millis(200)); // let stderr drain
                let tail = engine.stderr_tail();
                Err(format!("The CAD engine exited during startup. {}\n\n{tail}", setup_hint(python)))
            }
        }
    }

    pub fn stderr_tail(&self) -> String {
        let s = self.stderr.lock().unwrap();
        let start = s.len().saturating_sub(STDERR_TAIL);
        let start = (start..s.len()).find(|&i| s.is_char_boundary(i)).unwrap_or(start);
        s[start..].trim().to_string()
    }

    pub fn request(&mut self, mut req: Value, timeout: Duration) -> Result<Value, EngineError> {
        let id = self.next_id;
        self.next_id += 1;
        req["id"] = json!(id);
        let line = format!("{req}\n");
        if self.stdin.write_all(line.as_bytes()).and_then(|_| self.stdin.flush()).is_err() {
            return Err(EngineError::Dead(self.stderr_tail()));
        }
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.lines.recv_timeout(left) {
                Ok(line) => {
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                    if msg.get("id") != Some(&json!(id)) {
                        continue; // a late answer to a request that already timed out
                    }
                    if let Some(err) = msg.get("error") {
                        return Err(EngineError::Failed(err.as_str().unwrap_or("engine error").to_string()));
                    }
                    return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
                }
                Err(RecvTimeoutError::Timeout) => return Err(EngineError::Timeout),
                Err(RecvTimeoutError::Disconnected) => return Err(EngineError::Dead(self.stderr_tail())),
            }
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
