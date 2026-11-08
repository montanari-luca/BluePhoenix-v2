use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{LockExt, Result};

pub struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

#[derive(Default)]
pub struct PtyState(Mutex<HashMap<String, Arc<PtySession>>>);

#[derive(Serialize, Clone)]
struct PtyData {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: String,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 }
}

#[tauri::command]
pub async fn pty_open(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: String,
    command: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    let mut cmd = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut c = CommandBuilder::new(shell);
        c.arg("-l");
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        let exe = if which::which("pwsh").is_ok() { "pwsh.exe" } else { "powershell.exe" };
        let mut c = CommandBuilder::new(exe);
        c.arg("-NoLogo");
        c
    };
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    if let Some(c) = command.filter(|c| !c.trim().is_empty()) {
        writer.write_all(format!("{c}\r").as_bytes())?;
    }

    let id = uuid::Uuid::new_v4().to_string();
    let session = Arc::new(PtySession {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
    });
    state.0.lock_ok().insert(id.clone(), session);

    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app2.emit("pty-data", PtyData { id: id2.clone(), data });
                }
            }
        }
        let _ = app2.emit("pty-exit", PtyExit { id: id2 });
    });
    Ok(id)
}

fn get(state: &State<'_, PtyState>, id: &str) -> Result<Arc<PtySession>> {
    state.0.lock_ok().get(id).cloned().ok_or_else(|| "Terminal session not found".into())
}

#[tauri::command]
pub async fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<()> {
    let s = get(&state, &id)?;
    let mut w = s.writer.lock_ok();
    w.write_all(data.as_bytes())?;
    w.flush()?;
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) -> Result<()> {
    let s = get(&state, &id)?;
    s.master.lock_ok().resize(size(cols, rows)).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn pty_close(state: State<'_, PtyState>, id: String) -> Result<()> {
    let removed = state.0.lock_ok().remove(&id);
    if let Some(s) = removed {
        let _ = s.child.lock_ok().kill();
    }
    Ok(())
}
