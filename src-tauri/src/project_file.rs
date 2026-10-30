//! The `.bluephoenix` file kept in a project's folder. It stores what BluePhoenix knows about the
//! project (name, description, picked commands, default editor and terminal) so that removing a
//! project and adding the folder again restores it. It is meant to be committed, so BluePhoenix
//! never adds it to `.gitignore`.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{err, Result};

pub const FILE_NAME: &str = ".bluephoenix";

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileCommand {
    pub label: String,
    pub command: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub github_url: Option<String>,
    #[serde(default)]
    pub website_url: Option<String>,
    #[serde(default)]
    pub default_editor: Option<String>,
    #[serde(default)]
    pub default_terminal: Option<String>,
    #[serde(default)]
    pub commands: Vec<ProjectFileCommand>,
}

/// The project's `.bluephoenix` file, or `None` when it is missing or cannot be understood.
pub fn read(dir: &Path) -> Option<ProjectFile> {
    let text = std::fs::read_to_string(dir.join(FILE_NAME)).ok()?;
    let file: ProjectFile = serde_json::from_str(&text).ok()?;
    (!file.name.trim().is_empty()).then_some(file)
}

pub fn write(dir: &Path, file: &ProjectFile) -> Result<()> {
    let mut text = serde_json::to_string_pretty(file)?;
    text.push('\n');
    std::fs::write(dir.join(FILE_NAME), text)?;
    Ok(())
}

#[tauri::command]
pub fn project_file_read(path: String) -> Option<ProjectFile> {
    read(Path::new(&path))
}

#[tauri::command]
pub fn project_file_write(path: String, file: ProjectFile) -> Result<()> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return err("Project folder not found");
    }
    write(dir, &file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ProjectFile {
        ProjectFile {
            name: "App".into(),
            description: Some("Does things".into()),
            kind: Some("Rust".into()),
            github_url: Some("https://github.com/me/app".into()),
            website_url: None,
            default_editor: Some("vscode".into()),
            default_terminal: Some("embedded".into()),
            commands: vec![ProjectFileCommand {
                label: "Test".into(),
                command: "cargo test".into(),
                cwd: None,
                source: Some("auto".into()),
            }],
        }
    }

    #[test]
    fn round_trips_through_the_folder() {
        let dir = std::env::temp_dir().join(format!("bp-project-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read(&dir), None);
        write(&dir, &sample()).unwrap();
        assert_eq!(read(&dir), Some(sample()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ignores_unreadable_or_nameless_files() {
        let dir = std::env::temp_dir().join(format!("bp-project-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), "not json").unwrap();
        assert_eq!(read(&dir), None);
        std::fs::write(dir.join(FILE_NAME), r#"{"name":"  "}"#).unwrap();
        assert_eq!(read(&dir), None);
        std::fs::write(dir.join(FILE_NAME), r#"{"name":"Old","extra":1}"#).unwrap();
        assert_eq!(read(&dir).map(|f| f.name), Some("Old".into()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
