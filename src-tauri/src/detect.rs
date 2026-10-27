use std::path::Path;

use regex::Regex;
use serde::Serialize;

use crate::error::{err, Result};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCommand {
    pub label: String,
    pub command: String,
    pub source: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub name: String,
    pub kind: String,
    pub description: Option<String>,
    pub github_url: Option<String>,
    pub is_git: bool,
    pub commands: Vec<DetectedCommand>,
}

fn cmd(label: &str, command: &str) -> DetectedCommand {
    DetectedCommand { label: label.into(), command: command.into(), source: "auto".into() }
}

fn read(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok()
}

pub fn normalize_github(remote: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches(".git");
    let re = Regex::new(r"^(?:git@|ssh://git@|https?://(?:[^@/]+@)?)(github\.com)[:/](.+)$").ok()?;
    let c = re.captures(r)?;
    Some(format!("https://github.com/{}", &c[2]))
}

fn node(dir: &Path, out: &mut Detected) {
    let Some(text) = read(&dir.join("package.json")) else { return };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    let pm = if dir.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if dir.join("yarn.lock").exists() {
        "yarn"
    } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        "bun"
    } else {
        "npm"
    };
    let has = |name: &str| {
        ["dependencies", "devDependencies"].iter().any(|k| v[k].get(name).is_some())
    };
    let mut kind = "Node.js".to_string();
    for (dep, label) in [
        ("next", "Next.js"),
        ("nuxt", "Nuxt"),
        ("@sveltejs/kit", "SvelteKit"),
        ("astro", "Astro"),
        ("@remix-run/react", "Remix"),
        ("expo", "Expo"),
        ("react-native", "React Native"),
        ("electron", "Electron"),
        ("@tauri-apps/cli", "Tauri"),
        ("vite", "Vite"),
        ("react", "React"),
        ("vue", "Vue"),
        ("express", "Express"),
    ] {
        if has(dep) {
            kind = label.to_string();
            break;
        }
    }
    out.kind = kind;
    if out.name.is_empty() {
        if let Some(n) = v["name"].as_str() {
            out.name = n.to_string();
        }
    }
    if out.description.is_none() {
        out.description = v["description"].as_str().filter(|s| !s.is_empty()).map(String::from);
    }
    out.commands.push(cmd("Install dependencies", &format!("{pm} install")));
    if let Some(scripts) = v["scripts"].as_object() {
        for name in scripts.keys().take(40) {
            out.commands.push(cmd(&pretty(name), &format!("{pm} run {name}")));
        }
    }
}

fn pretty(name: &str) -> String {
    let s = name.replace(['-', '_', ':'], " ");
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => s,
    }
}

fn rust(dir: &Path, out: &mut Detected) {
    let Some(text) = read(&dir.join("Cargo.toml")) else { return };
    let v: toml::Value = text.parse().unwrap_or(toml::Value::Table(Default::default()));
    if out.kind == "Other" || out.kind.is_empty() {
        out.kind = "Rust".into();
    }
    if let Some(p) = v.get("package") {
        if out.name.is_empty() {
            out.name = p.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
        }
        if out.description.is_none() {
            out.description = p.get("description").and_then(|n| n.as_str()).map(String::from);
        }
    }
    for (l, c) in [
        ("Cargo build", "cargo build"),
        ("Cargo build (release)", "cargo build --release"),
        ("Cargo run", "cargo run"),
        ("Cargo test", "cargo test"),
        ("Cargo check", "cargo check"),
        ("Cargo clippy", "cargo clippy"),
        ("Cargo fmt", "cargo fmt"),
    ] {
        out.commands.push(cmd(l, c));
    }
}

fn makefile(dir: &Path, out: &mut Detected) {
    let Some(text) = read(&dir.join("Makefile")).or_else(|| read(&dir.join("makefile"))) else { return };
    let re = Regex::new(r"(?m)^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?:[^=]|$)").unwrap();
    let mut seen = vec![];
    for c in re.captures_iter(&text) {
        let t = c[1].to_string();
        if !seen.contains(&t) && !t.starts_with('.') {
            seen.push(t);
        }
        if seen.len() >= 25 {
            break;
        }
    }
    for t in seen {
        out.commands.push(cmd(&format!("make {t}"), &format!("make {t}")));
    }
}

fn justfile(dir: &Path, out: &mut Detected) {
    let Some(text) = read(&dir.join("justfile")).or_else(|| read(&dir.join("Justfile"))) else { return };
    let re = Regex::new(r"(?m)^([A-Za-z_][A-Za-z0-9_-]*)(?:\s+[^:=\n]*)?:(?:[^=]|$)").unwrap();
    for c in re.captures_iter(&text).take(25) {
        out.commands.push(cmd(&format!("just {}", &c[1]), &format!("just {}", &c[1])));
    }
}

fn python(dir: &Path, out: &mut Detected) {
    let pyproject = read(&dir.join("pyproject.toml"));
    let has_req = dir.join("requirements.txt").exists();
    if pyproject.is_none() && !has_req && !dir.join("setup.py").exists() && !dir.join("manage.py").exists() {
        return;
    }
    out.kind = if dir.join("manage.py").exists() { "Django".into() } else { "Python".into() };
    if let Some(t) = &pyproject {
        if let Ok(v) = t.parse::<toml::Value>() {
            let proj = v.get("project").or_else(|| v.get("tool").and_then(|t| t.get("poetry")));
            if let Some(p) = proj {
                if out.name.is_empty() {
                    out.name = p.get("name").and_then(|n| n.as_str()).unwrap_or("").into();
                }
                if out.description.is_none() {
                    out.description = p.get("description").and_then(|n| n.as_str()).map(String::from);
                }
            }
        }
    }
    let uv = dir.join("uv.lock").exists();
    let poetry = dir.join("poetry.lock").exists();
    if uv {
        out.commands.push(cmd("Sync environment", "uv sync"));
        out.commands.push(cmd("Run tests", "uv run pytest"));
    } else if poetry {
        out.commands.push(cmd("Install dependencies", "poetry install"));
        out.commands.push(cmd("Run tests", "poetry run pytest"));
    } else {
        if has_req {
            out.commands.push(cmd("Install dependencies", "pip install -r requirements.txt"));
        }
        out.commands.push(cmd("Run tests", "pytest"));
    }
    if dir.join("manage.py").exists() {
        out.commands.push(cmd("Run server", "python manage.py runserver"));
        out.commands.push(cmd("Migrate", "python manage.py migrate"));
    }
}

fn go(dir: &Path, out: &mut Detected) {
    let Some(text) = read(&dir.join("go.mod")) else { return };
    out.kind = "Go".into();
    if out.name.is_empty() {
        if let Some(m) = text.lines().find_map(|l| l.strip_prefix("module ")) {
            out.name = m.trim().rsplit('/').next().unwrap_or("").to_string();
        }
    }
    for (l, c) in [("Go build", "go build ./..."), ("Go run", "go run ."), ("Go test", "go test ./..."), ("Go vet", "go vet ./...")] {
        out.commands.push(cmd(l, c));
    }
}

fn jvm(dir: &Path, out: &mut Detected) {
    if dir.join("pom.xml").exists() {
        out.kind = "Java (Maven)".into();
        for (l, c) in [("Maven build", "mvn clean install"), ("Maven test", "mvn test"), ("Maven package", "mvn package")] {
            out.commands.push(cmd(l, c));
        }
        if read(&dir.join("pom.xml")).map(|t| t.contains("spring-boot")).unwrap_or(false) {
            out.commands.push(cmd("Spring Boot run", "mvn spring-boot:run"));
        }
    } else if dir.join("build.gradle").exists() || dir.join("build.gradle.kts").exists() {
        out.kind = "Java/Kotlin (Gradle)".into();
        let g = if cfg!(windows) { "gradlew.bat" } else { "./gradlew" };
        let g = if dir.join("gradlew").exists() { g } else { "gradle" };
        for (l, t) in [("Gradle build", "build"), ("Gradle test", "test"), ("Gradle run", "run")] {
            out.commands.push(cmd(l, &format!("{g} {t}")));
        }
    }
}

fn php(dir: &Path, out: &mut Detected) {
    let Some(text) = read(&dir.join("composer.json")) else { return };
    out.kind = if dir.join("artisan").exists() { "Laravel".into() } else { "PHP".into() };
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
        if out.name.is_empty() {
            out.name = v["name"].as_str().unwrap_or("").rsplit('/').next().unwrap_or("").into();
        }
        if let Some(s) = v["scripts"].as_object() {
            for k in s.keys().take(20) {
                out.commands.push(cmd(&format!("composer {k}"), &format!("composer run {k}")));
            }
        }
    }
    out.commands.push(cmd("Install dependencies", "composer install"));
    if dir.join("artisan").exists() {
        out.commands.push(cmd("Serve", "php artisan serve"));
    }
}

fn misc(dir: &Path, out: &mut Detected) {
    if dir.join("pubspec.yaml").exists() {
        out.kind = "Flutter".into();
        for (l, c) in [("Flutter run", "flutter run"), ("Flutter test", "flutter test"), ("Flutter build", "flutter build"), ("Pub get", "flutter pub get")] {
            out.commands.push(cmd(l, c));
        }
    }
    if dir.join("Package.swift").exists() {
        out.kind = "Swift".into();
        for (l, c) in [("Swift build", "swift build"), ("Swift run", "swift run"), ("Swift test", "swift test")] {
            out.commands.push(cmd(l, c));
        }
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        let names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        if names.iter().any(|n| n.ends_with(".xcodeproj") || n.ends_with(".xcworkspace")) && out.kind == "Other" {
            out.kind = "Xcode".into();
            out.commands.push(cmd("xcodebuild list", "xcodebuild -list"));
        }
        if names.iter().any(|n| n.ends_with(".csproj") || n.ends_with(".sln")) {
            out.kind = ".NET".into();
            for (l, c) in [("dotnet build", "dotnet build"), ("dotnet run", "dotnet run"), ("dotnet test", "dotnet test")] {
                out.commands.push(cmd(l, c));
            }
        }
    }
    if dir.join("Gemfile").exists() {
        out.kind = if dir.join("bin/rails").exists() { "Rails".into() } else { "Ruby".into() };
        out.commands.push(cmd("Bundle install", "bundle install"));
        if dir.join("bin/rails").exists() {
            out.commands.push(cmd("Rails server", "bin/rails server"));
        }
    }
    if dir.join("CMakeLists.txt").exists() {
        out.kind = "C/C++ (CMake)".into();
        out.commands.push(cmd("Configure", "cmake -B build"));
        out.commands.push(cmd("Build", "cmake --build build"));
    }
    for f in ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"] {
        if dir.join(f).exists() {
            out.commands.push(cmd("Docker compose up", "docker compose up"));
            out.commands.push(cmd("Docker compose down", "docker compose down"));
            break;
        }
    }
}

pub fn detect_dir(dir: &Path) -> Detected {
    let mut out = Detected { kind: "Other".into(), ..Default::default() };
    node(dir, &mut out);
    let is_node = out.kind != "Other";
    rust(dir, &mut out);
    if is_node && dir.join("src-tauri").join("tauri.conf.json").exists() {
        out.kind = "Tauri".into();
    } else if is_node && dir.join("Cargo.toml").exists() {
        out.kind = format!("{} + Rust", out.kind);
    }
    python(dir, &mut out);
    go(dir, &mut out);
    jvm(dir, &mut out);
    php(dir, &mut out);
    misc(dir, &mut out);
    makefile(dir, &mut out);
    justfile(dir, &mut out);
    if out.name.is_empty() {
        out.name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    }
    // De-duplicate by command string.
    let mut seen = std::collections::HashSet::new();
    out.commands.retain(|c| seen.insert(c.command.clone()));
    out
}

#[tauri::command]
pub async fn detect_project(path: String) -> Result<Detected> {
    detect_path(&path).await
}

/// Detects type, description, GitHub remote and commands of the project in `path`.
pub async fn detect_path(path: &str) -> Result<Detected> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return err("That folder does not exist");
    }
    let mut d = detect_dir(dir);
    d.is_git = dir.join(".git").exists();
    if d.is_git {
        if let Ok(o) = tokio::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["remote", "get-url", "origin"])
            .output()
            .await
        {
            if o.status.success() {
                d.github_url = normalize_github(String::from_utf8_lossy(&o.stdout).trim());
            }
        }
    }
    Ok(d)
}

/// A bounded snapshot of the repo (tree + key files) used by the AI command scanner.
#[tauri::command]
pub async fn project_snapshot(path: String) -> Result<String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return err("That folder does not exist");
    }
    let mut out = String::new();
    let walker = ignore::WalkBuilder::new(dir).max_depth(Some(2)).hidden(false).require_git(false).build();
    let mut n = 0;
    for e in walker.flatten() {
        let p = e.path();
        if p.components().any(|c| c.as_os_str() == ".git") {
            continue;
        }
        if let Ok(rel) = p.strip_prefix(dir) {
            if !rel.as_os_str().is_empty() {
                out.push_str(&rel.to_string_lossy());
                out.push('\n');
                n += 1;
                if n >= 200 {
                    break;
                }
            }
        }
    }
    for f in [
        "package.json", "Cargo.toml", "Makefile", "justfile", "pyproject.toml", "go.mod", "pom.xml",
        "build.gradle", "build.gradle.kts", "composer.json", "pubspec.yaml", "README.md", "readme.md",
    ] {
        if let Some(t) = read(&dir.join(f)) {
            let t: String = t.chars().take(3000).collect();
            out.push_str(&format!("\n----- {f} -----\n{t}\n"));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_github_remotes() {
        assert_eq!(normalize_github("git@github.com:montanari-luca/BluePhoenix.git").as_deref(), Some("https://github.com/montanari-luca/BluePhoenix"));
        assert_eq!(normalize_github("https://github.com/a/b.git").as_deref(), Some("https://github.com/a/b"));
        assert_eq!(normalize_github("https://gitlab.com/a/b.git"), None);
    }

    #[test]
    fn detects_node_and_make() {
        let dir = std::env::temp_dir().join(format!("bp-detect-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"name":"demo","description":"Demo app","scripts":{"dev":"vite","build":"vite build"},"devDependencies":{"vite":"1"}}"#).unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        std::fs::write(dir.join("Makefile"), "all:\n\techo hi\ntest: all\n\techo t\n.PHONY: all\n").unwrap();
        let d = detect_dir(&dir);
        assert_eq!(d.name, "demo");
        assert_eq!(d.kind, "Vite");
        assert!(d.commands.iter().any(|c| c.command == "pnpm run dev"));
        assert!(d.commands.iter().any(|c| c.command == "make test"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
