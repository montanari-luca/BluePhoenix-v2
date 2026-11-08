use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature, StreamVerifier};
use semver::Version;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{err, AppError, Result};

const VERSION_URL: &str =
    "https://raw.githubusercontent.com/montanari-luca/MintFlow-Releases/refs/heads/main/bluephoenix-v.json";
const DOWNLOAD_URL: &str =
    "https://raw.githubusercontent.com/montanari-luca/MintFlow-Releases/refs/heads/main/bluephoenix-d.json";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub download_url: Option<String>,
}

pub fn platform_key() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

pub fn parse_version(s: &str) -> Option<Version> {
    let t = s.trim().trim_start_matches('v');
    Version::parse(t).ok().or_else(|| {
        // Accept "0.2" style versions.
        let parts = t.split('.').count();
        if parts == 2 { Version::parse(&format!("{t}.0")).ok() } else { None }
    })
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

/// Release installers are signed with minisign; this is the matching public key.
/// Generate it once with `minisign -G` (see docs/updates.md) and commit the `.pub` file here.
const UPDATE_PUBLIC_KEY: &str = include_str!("../keys/update.pub");

const UNSIGNED_UPDATE: &str = "This update has no checksum or signature, so BluePhoenix won't install it. Download the new version manually from the BluePhoenix website.";
const NOT_VERIFIED: &str = "Only an installer that BluePhoenix downloaded and verified can be opened. Download the update again.";

/// A downloaded installer that passed the checksum and signature checks; `install_update` only opens this file.
static VERIFIED: Mutex<Option<(PathBuf, [u8; 32])>> = Mutex::new(None);

fn verified() -> std::sync::MutexGuard<'static, Option<(PathBuf, [u8; 32])>> {
    VERIFIED.lock().unwrap_or_else(|e| e.into_inner())
}

/// What `bluephoenix-d.json` publishes for one platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformEntry {
    pub url: String,
    pub sha256: Option<String>,
    pub signature: Option<String>,
}

/// Reads one platform's entry from `bluephoenix-d.json`. Accepted shapes:
/// - `"macos": {"url": "https://…", "sha256": "…", "signature": "…"}`
/// - `"macos": "https://…", "macos_sha256": "…", "macos_signature": "…"` (also readable by app versions before 0.2.3)
/// - `"macos": "https://…"` (legacy and unsigned: parsed, but never installed)
pub fn platform_entry(manifest: &Value, platform: &str) -> Option<PlatformEntry> {
    let text = |v: &Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    match &manifest[platform] {
        Value::String(url) => Some(PlatformEntry {
            url: url.trim().to_string(),
            sha256: text(&manifest[format!("{platform}_sha256").as_str()]),
            signature: text(&manifest[format!("{platform}_signature").as_str()]),
        }),
        v @ Value::Object(_) => Some(PlatformEntry {
            url: text(&v["url"])?,
            sha256: text(&v["sha256"]),
            signature: text(&v["signature"]),
        }),
        _ => None,
    }
}

/// Refuses anything but an absolute `https://` URL.
pub fn require_https(url: &str) -> Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| AppError::Msg("Invalid download link".into()))?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return err("Refusing to download the update: only https:// links are allowed.");
    }
    Ok(parsed)
}

/// The checksum and signature an installer must match.
pub struct Expected {
    sha256: [u8; 32],
    signature: Signature,
}

impl PlatformEntry {
    pub fn expected(&self) -> Result<Expected> {
        let (Some(sha), Some(sig)) = (&self.sha256, &self.signature) else {
            return err(UNSIGNED_UPDATE);
        };
        Ok(Expected { sha256: parse_sha256(sha)?, signature: parse_signature(sig)? })
    }
}

fn parse_sha256(s: &str) -> Result<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return err("The published update has a malformed SHA-256 checksum, so it won't be installed.");
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Accepts the `.minisig` file's text, or that text base64-encoded on one line.
fn parse_signature(s: &str) -> Result<Signature> {
    let s = s.trim();
    let text = if s.starts_with("untrusted comment:") {
        s.to_string()
    } else {
        base64::engine::general_purpose::STANDARD
            .decode(s)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or_else(|| signature_error(minisign_verify::Error::InvalidEncoding))?
    };
    Signature::decode(&text).map_err(signature_error)
}

fn signature_error(e: minisign_verify::Error) -> AppError {
    use minisign_verify::Error as E;
    let why = match e {
        E::UnexpectedKeyId => "it was signed with a key this app doesn't trust",
        E::InvalidEncoding => "its signature is malformed",
        E::UnexpectedAlgorithm | E::UnsupportedAlgorithm | E::UnsupportedLegacyMode => "its signature uses an unsupported format",
        E::InvalidSignature | E::IoError(_) => "its signature doesn't match the file",
    };
    AppError::Msg(format!("The update failed verification: {why}. It won't be installed."))
}

fn release_public_key() -> Result<PublicKey> {
    PublicKey::decode(UPDATE_PUBLIC_KEY.trim()).map_err(|_| {
        AppError::Msg("This build of BluePhoenix has no update-signing key, so it can't verify updates. Download the new version manually.".into())
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hashes (SHA-256) and signature-checks an installer as its bytes stream in.
pub struct IntegrityCheck<'a> {
    sha: Sha256,
    sig: StreamVerifier<'a>,
    expected_sha: [u8; 32],
}

impl<'a> IntegrityCheck<'a> {
    pub fn new(key: &'a PublicKey, expected: &'a Expected) -> Result<Self> {
        let sig = key.verify_stream(&expected.signature).map_err(signature_error)?;
        Ok(Self { sha: Sha256::new(), sig, expected_sha: expected.sha256 })
    }

    pub fn update(&mut self, chunk: &[u8]) {
        Digest::update(&mut self.sha, chunk);
        self.sig.update(chunk);
    }

    /// Checksum first (clearer message), then the signature. Returns the file's SHA-256.
    pub fn finish(mut self) -> Result<[u8; 32]> {
        let got: [u8; 32] = self.sha.finalize().into();
        if got != self.expected_sha {
            return err(format!(
                "The update failed verification: its SHA-256 checksum doesn't match (expected {}, got {}). It won't be installed.",
                hex(&self.expected_sha),
                hex(&got)
            ));
        }
        self.sig.finalize().map_err(signature_error)?;
        Ok(got)
    }
}

async fn sha256_file(path: &Path) -> Result<[u8; 32]> {
    let mut f = tokio::fs::File::open(path).await?;
    let mut sha = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        Digest::update(&mut sha, &buf[..n]);
    }
    Ok(sha.finalize().into())
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent("BluePhoenix-Updater")
        .https_only(true)
        .timeout(std::time::Duration::from_secs(20))
        .build()?)
}

async fn fetch_json(c: &reqwest::Client, url: &str) -> Result<Value> {
    Ok(c.get(url).send().await?.error_for_status()?.json().await?)
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let c = client()?;
    let v = fetch_json(&c, VERSION_URL).await?;
    let latest = v["latest"].as_str().ok_or("The version file has no \"latest\" field")?.to_string();
    let available = is_newer(&latest, &current);
    let mut download_url = None;
    if available {
        let d = fetch_json(&c, DOWNLOAD_URL).await?;
        download_url = platform_entry(&d, platform_key()).map(|e| e.url).filter(|u| require_https(u).is_ok());
    }
    Ok(UpdateInfo { current, latest, available, download_url })
}

#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn file_name_from(url: &str) -> String {
    let last = url.split(['?', '#']).next().unwrap_or(url).rsplit('/').next().unwrap_or("");
    if last.contains('.') && !last.is_empty() {
        last.to_string()
    } else {
        let ext = match platform_key() {
            "macos" => "dmg",
            "windows" => "exe",
            _ => "AppImage",
        };
        format!("BluePhoenix-update.{ext}")
    }
}

/// Downloads the installer into the user's Downloads folder, streaming progress events, and
/// verifies its SHA-256 and minisign signature against `bluephoenix-d.json` and the embedded key.
/// A file that fails is deleted; only a verified file can be passed to `install_update`.
#[tauri::command]
pub async fn download_update(app: AppHandle, url: String) -> Result<String> {
    require_https(&url)?;
    let url = url.trim().to_string();
    // Re-read the manifest here so the checksum and signature come from the server, not the UI.
    let manifest = fetch_json(&client()?, DOWNLOAD_URL).await?;
    let entry = platform_entry(&manifest, platform_key()).ok_or("No installer has been published for this platform yet.")?;
    if entry.url != url {
        return err("The update link doesn't match the published update. Check for updates again.");
    }
    let expected = entry.expected()?;
    let key = release_public_key()?;
    let mut check = IntegrityCheck::new(&key, &expected)?;
    *verified() = None;

    let dir: PathBuf = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
    let dest = dir.join(file_name_from(&url));
    let downloaded = async {
        let resp = reqwest::Client::builder()
            .user_agent("BluePhoenix-Updater")
            .https_only(true)
            .connect_timeout(std::time::Duration::from_secs(20))
            .build()?
            .get(&url)
            .send()
            .await?
            .error_for_status()?;
        let total = resp.content_length();
        let mut file = tokio::fs::File::create(&dest).await?;
        let mut stream = resp.bytes_stream();
        let mut downloaded = 0u64;
        let mut last_emit = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            check.update(&chunk);
            file.write_all(&chunk).await?;
            downloaded += chunk.len() as u64;
            if downloaded - last_emit > 256 * 1024 {
                last_emit = downloaded;
                let _ = app.emit("update-progress", Progress { downloaded, total });
            }
        }
        file.flush().await?;
        let _ = app.emit("update-progress", Progress { downloaded, total });
        Ok::<_, AppError>(())
    }
    .await;
    let result = downloaded.and_then(|()| check.finish());
    match result {
        Ok(hash) => {
            *verified() = Some((dest.clone(), hash));
            Ok(dest.to_string_lossy().to_string())
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&dest).await;
            Err(e)
        }
    }
}

/// Opens the downloaded installer (or reveals it when it cannot be launched directly).
/// Refuses anything but the file `download_update` verified, and re-hashes it first in case it changed on disk.
#[tauri::command]
pub async fn install_update(app: AppHandle, path: String) -> Result<()> {
    let Some((verified_path, hash)) = verified().clone() else {
        return err(NOT_VERIFIED);
    };
    if Path::new(&path) != verified_path {
        return err(NOT_VERIFIED);
    }
    if sha256_file(&verified_path).await? != hash {
        *verified() = None;
        return err("The downloaded installer changed after it was verified, so it won't be opened. Download the update again.");
    }
    let path = verified_path.to_string_lossy().to_string();
    let lower = path.to_lowercase();
    if lower.ends_with(".appimage") {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
        }
        app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())?;
    } else {
        app.opener().open_path(&path, None::<&str>).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(is_newer("0.3", "0.2.9"));
        assert!(!is_newer("garbage", "0.1.0"));
    }

    #[test]
    fn names_downloads() {
        assert_eq!(file_name_from("https://x.com/a/BluePhoenix_0.2.0.dmg?dl=1"), "BluePhoenix_0.2.0.dmg");
        assert!(file_name_from("https://x.com/download").starts_with("BluePhoenix-update."));
    }

    const TEST_PUB: &str = include_str!("../tests/fixtures/updater/test.pub");
    const OTHER_PUB: &str = include_str!("../tests/fixtures/updater/other.pub");
    const PAYLOAD: &[u8] = include_bytes!("../tests/fixtures/updater/payload.bin");
    const PAYLOAD_SIG: &str = include_str!("../tests/fixtures/updater/payload.bin.minisig");
    const PAYLOAD_SHA: &str = "4192b55dd92a6615036007ba779f2be7f3508e06c58350d5ac4fcdddd31d4f33";

    fn entry(sha256: &str, signature: &str) -> PlatformEntry {
        PlatformEntry { url: "https://example.com/BluePhoenix.dmg".into(), sha256: Some(sha256.into()), signature: Some(signature.into()) }
    }

    fn run_check(key: &str, entry: &PlatformEntry, data: &[u8]) -> Result<[u8; 32]> {
        let key = PublicKey::decode(key.trim()).unwrap();
        let expected = entry.expected()?;
        let mut check = IntegrityCheck::new(&key, &expected)?;
        // Feed it in uneven chunks, as a download would.
        for chunk in data.chunks(7) {
            check.update(chunk);
        }
        check.finish()
    }

    #[test]
    fn refuses_http_urls() {
        assert!(require_https("http://example.com/BluePhoenix.dmg").is_err());
        assert!(require_https("HTTP://example.com/BluePhoenix.dmg").is_err());
        assert!(require_https("ftp://example.com/BluePhoenix.dmg").is_err());
        assert!(require_https("file:///tmp/BluePhoenix.dmg").is_err());
        assert!(require_https("example.com/BluePhoenix.dmg").is_err());
        assert!(require_https("https://example.com/BluePhoenix.dmg").is_ok());
        assert!(require_https(" HTTPS://example.com/BluePhoenix.dmg ").is_ok());
    }

    #[test]
    fn check_update_drops_http_links() {
        let d = serde_json::json!({ "macos": "http://example.com/a.dmg", "windows": { "url": "https://example.com/a.exe" } });
        let https_url = |p| platform_entry(&d, p).map(|e| e.url).filter(|u| require_https(u).is_ok());
        assert_eq!(https_url("macos"), None);
        assert_eq!(https_url("windows").as_deref(), Some("https://example.com/a.exe"));
    }

    #[test]
    fn parses_all_manifest_shapes() {
        let d = serde_json::json!({
            "macos": { "url": "https://x/a.dmg", "sha256": "ab", "signature": "sig" },
            "windows": "https://x/a.exe", "windows_sha256": "cd", "windows_signature": "sig2",
            "linux": "https://x/a.AppImage",
        });
        let full = |u: &str, h: &str, s: &str| PlatformEntry { url: u.into(), sha256: Some(h.into()), signature: Some(s.into()) };
        assert_eq!(platform_entry(&d, "macos"), Some(full("https://x/a.dmg", "ab", "sig")));
        assert_eq!(platform_entry(&d, "windows"), Some(full("https://x/a.exe", "cd", "sig2")));
        assert_eq!(platform_entry(&d, "linux"), Some(PlatformEntry { url: "https://x/a.AppImage".into(), sha256: None, signature: None }));
        assert_eq!(platform_entry(&d, "ios"), None);
    }

    #[test]
    fn refuses_unsigned_entries() {
        let mut e = entry(PAYLOAD_SHA, PAYLOAD_SIG);
        e.signature = None;
        assert!(e.expected().is_err());
        let mut e = entry(PAYLOAD_SHA, PAYLOAD_SIG);
        e.sha256 = None;
        assert!(e.expected().is_err());
        assert!(entry("not-a-hash", PAYLOAD_SIG).expected().is_err());
        assert!(entry(PAYLOAD_SHA, "garbage").expected().is_err());
    }

    #[test]
    fn accepts_valid_signature() {
        let hash = run_check(TEST_PUB, &entry(PAYLOAD_SHA, PAYLOAD_SIG), PAYLOAD).expect("valid payload should verify");
        assert_eq!(hex(&hash), PAYLOAD_SHA);
        // Upper-case checksums and a base64-encoded signature (single line, JSON-friendly) work too.
        let b64 = base64::engine::general_purpose::STANDARD.encode(PAYLOAD_SIG);
        assert!(run_check(TEST_PUB, &entry(&PAYLOAD_SHA.to_uppercase(), &b64), PAYLOAD).is_ok());
    }

    #[test]
    fn rejects_checksum_mismatch() {
        let wrong = "0".repeat(64);
        let e = run_check(TEST_PUB, &entry(&wrong, PAYLOAD_SIG), PAYLOAD).unwrap_err();
        assert!(e.to_string().contains("checksum"), "{e}");
        // A tampered file is caught by the checksum even if the signature is untouched.
        let mut tampered = PAYLOAD.to_vec();
        tampered[0] ^= 1;
        assert!(run_check(TEST_PUB, &entry(PAYLOAD_SHA, PAYLOAD_SIG), &tampered).is_err());
    }

    #[test]
    fn rejects_bad_signature() {
        // Tampered file whose checksum was updated to match: only the signature can catch it.
        let mut tampered = PAYLOAD.to_vec();
        tampered[0] ^= 1;
        let sha = hex(&<[u8; 32]>::from(Sha256::digest(&tampered)));
        let e = run_check(TEST_PUB, &entry(&sha, PAYLOAD_SIG), &tampered).unwrap_err();
        assert!(e.to_string().contains("signature"), "{e}");
        // Right file, signed by a key the app doesn't trust.
        let e = run_check(OTHER_PUB, &entry(PAYLOAD_SHA, PAYLOAD_SIG), PAYLOAD).unwrap_err();
        assert!(e.to_string().contains("key"), "{e}");
    }
}
