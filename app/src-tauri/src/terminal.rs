//! Terminal tabs: the user's own shell in a PTY, started in the project folder.
//! Cadorphin does not assume any particular agent; the user runs whatever they like here.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    map: Mutex<HashMap<String, Term>>,
    next: AtomicU64,
}

#[derive(Clone, Serialize)]
struct DataEvent {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: String,
    code: Option<u32>,
}

/// The user's shell: $SHELL (login) on macOS/Linux; PowerShell 7, Windows PowerShell or cmd on Windows.
fn default_shell() -> CommandBuilder {
    if cfg!(windows) {
        let on_path = |exe: &str| {
            std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).any(|d| d.join(exe).is_file()))
                .unwrap_or(false)
        };
        if on_path("pwsh.exe") {
            CommandBuilder::new("pwsh.exe")
        } else if on_path("powershell.exe") {
            CommandBuilder::new("powershell.exe")
        } else {
            CommandBuilder::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()))
        }
    } else {
        let mut cmd = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()));
        cmd.arg("-l"); // login shell, so GUI-launched apps still get the user's PATH
        cmd
    }
}

/// Decode a byte stream as UTF-8 without splitting multi-byte characters across chunks.
fn take_utf8(carry: &mut Vec<u8>) -> String {
    match std::str::from_utf8(carry) {
        Ok(s) => {
            let out = s.to_string();
            carry.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            // incomplete sequence at the end: keep it for the next chunk
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&carry[..valid]).into_owned();
            carry.drain(..valid);
            out
        }
        Err(_) => {
            let out = String::from_utf8_lossy(carry).into_owned();
            carry.clear();
            out
        }
    }
}

impl Terminals {
    /// `tools_dir` (the engine's Python scripts folder) is put first on PATH so `cadkit` in the
    /// terminal is the same one the app uses; agents are told to run `cadkit check`.
    pub fn open(
        &self,
        app: &AppHandle,
        cwd: &Path,
        command: Option<String>,
        tools_dir: Option<&Path>,
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        let size = PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 };
        let pair = native_pty_system().openpty(size).map_err(|e| format!("Could not open a terminal: {e}"))?;
        let mut cmd = default_shell();
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if let Some(dir) = tools_dir {
            let mut paths = vec![dir.to_path_buf()];
            if let Some(old) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&old));
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                cmd.env("PATH", joined);
            }
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("Could not start the shell: {e}"))?;
        drop(pair.slave);

        let id = format!("t{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();

        let (app_r, id_r) = (app.clone(), id.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            let mut carry = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        carry.extend_from_slice(&buf[..n]);
                        let data = take_utf8(&mut carry);
                        if !data.is_empty() {
                            let _ = app_r.emit("terminal-data", DataEvent { id: id_r.clone(), data });
                        }
                    }
                }
            }
        });

        let (app_w, id_w) = (app.clone(), id.clone());
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            let _ = app_w.emit("terminal-exit", ExitEvent { id: id_w, code });
        });

        if let Some(c) = command.filter(|c| !c.trim().is_empty()) {
            let _ = writer.write_all(format!("{c}\r").as_bytes());
        }
        self.map.lock().unwrap().insert(id.clone(), Term { master: pair.master, writer, killer });
        Ok(id)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut map = self.map.lock().unwrap();
        let t = map.get_mut(id).ok_or("No such terminal")?;
        t.writer.write_all(data.as_bytes()).and_then(|_| t.writer.flush()).map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.map.lock().unwrap();
        let t = map.get(id).ok_or("No such terminal")?;
        t.master
            .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    pub fn close(&self, id: &str) {
        if let Some(mut t) = self.map.lock().unwrap().remove(id) {
            let _ = t.killer.kill();
        }
    }

    pub fn close_all(&self) {
        for (_, mut t) in self.map.lock().unwrap().drain() {
            let _ = t.killer.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{default_shell, take_utf8};
    use portable_pty::{native_pty_system, PtySize};
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// The real path: the user's default shell in a PTY runs a command we type and echoes output.
    #[test]
    fn default_shell_runs_typed_commands() {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 100, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut child = pair.slave.spawn_command(default_shell()).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(String::from_utf8_lossy(&buf[..n]).into_owned()).is_err() {
                    break;
                }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut seen = String::new();
        let mut typed = false;
        while Instant::now() < deadline && !seen.contains("cadorphin-42-ok") {
            if let Ok(s) = rx.recv_timeout(Duration::from_millis(200)) {
                // Windows ConPTY asks for the cursor position and waits for the answer,
                // which a real terminal (xterm.js in the app) sends automatically.
                if s.contains("\x1b[6n") {
                    writer.write_all(b"\x1b[1;1R").unwrap();
                    writer.flush().unwrap();
                }
                seen.push_str(&s);
            } else if !typed && !seen.is_empty() {
                typed = true;
                writer.write_all(b"echo cadorphin-$((6*7))-ok\r").unwrap(); // bash/zsh arithmetic
                writer.write_all(b"echo cadorphin-$(6*7)-ok\r").unwrap(); // PowerShell subexpression
                writer.flush().unwrap();
            }
        }
        let _ = child.kill();
        assert!(seen.contains("cadorphin-42-ok"), "shell output was:\n{seen}");
    }

    #[test]
    fn utf8_split_across_chunks_is_reassembled() {
        let bytes = "✓ ok".as_bytes();
        let mut carry = bytes[..2].to_vec(); // half of the 3-byte check mark
        assert_eq!(take_utf8(&mut carry), "");
        carry.extend_from_slice(&bytes[2..]);
        assert_eq!(take_utf8(&mut carry), "✓ ok");
        assert!(carry.is_empty());
    }
}
