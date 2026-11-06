//! Turns one square-ish source image into the icon files every platform expects (Tauri bundles,
//! favicons, Xcode asset catalogs, Android mipmaps, Expo, Flutter ...). Files are written into an
//! existing project, so each target only touches what the template actually created.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use base64::Engine;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use serde::Serialize;

use crate::error::{err, Result};

/// Loads the source and pads it to a square (never crops), so the whole artwork stays visible.
pub fn load_square(path: &Path) -> Result<RgbaImage> {
    let img = image::open(path).map_err(|e| format!("Could not read the icon image: {e}"))?.to_rgba8();
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return err("The icon image is empty.");
    }
    if w == h {
        return Ok(img);
    }
    let side = w.max(h);
    let mut canvas = RgbaImage::from_pixel(side, side, Rgba([0, 0, 0, 0]));
    image::imageops::overlay(&mut canvas, &img, ((side - w) / 2) as i64, ((side - h) / 2) as i64);
    Ok(canvas)
}

fn resized(src: &RgbaImage, px: u32) -> RgbaImage {
    if src.width() == px {
        src.clone()
    } else {
        image::imageops::resize(src, px, px, FilterType::Lanczos3)
    }
}

/// Opaque copy on a white background (App Store icons must not have transparency).
fn flattened(img: &RgbaImage) -> RgbaImage {
    let mut bg = RgbaImage::from_pixel(img.width(), img.height(), Rgba([255, 255, 255, 255]));
    image::imageops::overlay(&mut bg, img, 0, 0);
    bg
}

fn png_bytes(img: &RgbaImage) -> Result<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(img.clone()).write_to(&mut out, ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, bytes)?;
    Ok(())
}

fn write_png(path: &Path, src: &RgbaImage, px: u32, opaque: bool) -> Result<()> {
    let img = resized(src, px);
    write(path, &png_bytes(&if opaque { flattened(&img) } else { img })?)
}

/// Windows `.ico` with PNG-compressed frames.
pub fn ico_bytes(src: &RgbaImage, sizes: &[u32]) -> Result<Vec<u8>> {
    let frames: Vec<(u32, Vec<u8>)> =
        sizes.iter().map(|&s| Ok((s, png_bytes(&resized(src, s))?))).collect::<Result<_>>()?;
    let mut out = Vec::new();
    out.extend_from_slice(&[0, 0, 1, 0]);
    out.extend_from_slice(&(frames.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * frames.len() as u32;
    for (s, data) in &frames {
        let dim = if *s >= 256 { 0 } else { *s as u8 };
        out.extend_from_slice(&[dim, dim, 0, 0]);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        offset += data.len() as u32;
    }
    for (_, data) in frames {
        out.extend_from_slice(&data);
    }
    Ok(out)
}

/// macOS `.icns` built from PNG entries.
pub fn icns_bytes(src: &RgbaImage) -> Result<Vec<u8>> {
    const ENTRIES: [(&[u8; 4], u32); 11] = [
        (b"icp4", 16),
        (b"icp5", 32),
        (b"icp6", 64),
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
        (b"ic10", 1024),
        (b"ic11", 32),
        (b"ic12", 64),
        (b"ic13", 256),
        (b"ic14", 512),
    ];
    let mut body = Vec::new();
    for (kind, px) in ENTRIES {
        let data = png_bytes(&resized(src, px))?;
        body.extend_from_slice(kind);
        body.extend_from_slice(&(data.len() as u32 + 8).to_be_bytes());
        body.extend_from_slice(&data);
    }
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(b"icns");
    out.extend_from_slice(&(body.len() as u32 + 8).to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

// ---------- targets ----------

fn tauri(src: &RgbaImage, root: &Path, wrote: &mut Vec<PathBuf>) -> Result<()> {
    let dir = root.join("src-tauri").join("icons");
    if !root.join("src-tauri").is_dir() {
        return Ok(());
    }
    for (name, px) in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 512), ("StoreLogo.png", 50)] {
        write_png(&dir.join(name), src, px, false)?;
        wrote.push(dir.join(name));
    }
    for px in [30, 44, 71, 89, 107, 142, 150, 284, 310] {
        let name = format!("Square{px}x{px}Logo.png");
        write_png(&dir.join(&name), src, px, false)?;
        wrote.push(dir.join(name));
    }
    write(&dir.join("icon.ico"), &ico_bytes(src, &[16, 24, 32, 48, 64, 128, 256])?)?;
    write(&dir.join("icon.icns"), &icns_bytes(src)?)?;
    wrote.push(dir.join("icon.ico"));
    wrote.push(dir.join("icon.icns"));
    // The master image, the same file `tauri icon` expects, so icons can be regenerated later.
    write_png(&root.join("app-icon.png"), src, 1024, false)?;
    wrote.push(root.join("app-icon.png"));
    Ok(())
}

fn web_dir(root: &Path) -> PathBuf {
    ["public", "static"].iter().map(|d| root.join(d)).find(|p| p.is_dir()).unwrap_or_else(|| root.join("public"))
}

/// A `favicon.svg` that just embeds the PNG, for templates whose layout links an SVG favicon.
fn svg_wrapper(src: &RgbaImage) -> Result<Vec<u8>> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(png_bytes(&resized(src, 128))?);
    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 128 128\"><image width=\"128\" height=\"128\" href=\"data:image/png;base64,{b64}\"/></svg>\n"
    )
    .into_bytes())
}

fn web(src: &RgbaImage, root: &Path, wrote: &mut Vec<PathBuf>) -> Result<()> {
    let dir = web_dir(root);
    let ico = ico_bytes(src, &[16, 32, 48])?;
    write(&dir.join("favicon.ico"), &ico)?;
    wrote.push(dir.join("favicon.ico"));
    for (name, px) in [("favicon-16x16.png", 16), ("favicon-32x32.png", 32), ("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)] {
        write_png(&dir.join(name), src, px, name == "apple-touch-icon.png")?;
        wrote.push(dir.join(name));
    }
    // Framework starters ship their own favicon in places a layout already points at.
    for rel in ["app/favicon.ico", "src/app/favicon.ico"] {
        let p = root.join(rel);
        if p.is_file() {
            write(&p, &ico)?;
            wrote.push(p);
        }
    }
    for rel in ["public/favicon.svg", "static/favicon.svg", "src/lib/assets/favicon.svg"] {
        let p = root.join(rel);
        if p.is_file() {
            write(&p, &svg_wrapper(src)?)?;
            wrote.push(p);
        }
    }
    let png = root.join("static").join("favicon.png");
    if png.is_file() {
        write_png(&png, src, 64, false)?;
        wrote.push(png);
    }
    Ok(())
}

fn find_dirs(root: &Path, suffix: &str, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(suffix) {
            out.push(p);
        } else if !matches!(name.as_str(), "node_modules" | "Pods" | ".git" | "target" | "build" | ".build" | "DerivedData" | ".dart_tool") {
            find_dirs(&p, suffix, depth - 1, out);
        }
    }
}

/// Fills every `AppIcon.appiconset` found: each image named in its `Contents.json` gets the right size.
fn apple(src: &RgbaImage, root: &Path, wrote: &mut Vec<PathBuf>) -> Result<()> {
    let mut sets = Vec::new();
    find_dirs(root, ".appiconset", 7, &mut sets);
    for set in sets {
        let Ok(text) = std::fs::read_to_string(set.join("Contents.json")) else { continue };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        for img in json["images"].as_array().into_iter().flatten() {
            let Some(file) = img["filename"].as_str() else { continue };
            let size: f32 = img["size"].as_str().and_then(|s| s.split('x').next()).and_then(|s| s.parse().ok()).unwrap_or(1024.0);
            let scale: f32 = img["scale"].as_str().and_then(|s| s.trim_end_matches('x').parse().ok()).unwrap_or(1.0);
            let px = (size * scale).round().max(1.0) as u32;
            let mac = img["idiom"].as_str() == Some("mac") || img["platform"].as_str() == Some("macos");
            write_png(&set.join(file), src, px, !mac)?;
            wrote.push(set.join(file));
        }
    }
    Ok(())
}

fn android(src: &RgbaImage, root: &Path, wrote: &mut Vec<PathBuf>) -> Result<()> {
    let res = root.join("android").join("app").join("src").join("main").join("res");
    if !res.is_dir() {
        return Ok(());
    }
    for (density, px) in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)] {
        let dir = res.join(format!("mipmap-{density}"));
        for name in ["ic_launcher.png", "ic_launcher_round.png"] {
            write_png(&dir.join(name), src, px, false)?;
            wrote.push(dir.join(name));
        }
    }
    Ok(())
}

/// Expo keeps its icons in `assets` or `assets/images`; only files the template created are replaced.
fn expo(src: &RgbaImage, root: &Path, wrote: &mut Vec<PathBuf>) -> Result<()> {
    let dir = ["assets/images", "assets"].iter().map(|d| root.join(d)).find(|p| p.is_dir());
    let Some(dir) = dir else { return Ok(()) };
    for (name, px, opaque) in [
        ("icon.png", 1024, true),
        ("adaptive-icon.png", 1024, false),
        ("android-icon-foreground.png", 1024, false),
        ("splash-icon.png", 1024, false),
        ("favicon.png", 48, false),
    ] {
        let p = dir.join(name);
        if p.is_file() || name == "icon.png" {
            write_png(&p, src, px, opaque)?;
            wrote.push(p);
        }
    }
    Ok(())
}

fn windows(src: &RgbaImage, root: &Path, wrote: &mut Vec<PathBuf>) -> Result<()> {
    let p = root.join("windows").join("runner").join("resources").join("app_icon.ico");
    if p.is_file() {
        write(&p, &ico_bytes(src, &[16, 24, 32, 48, 64, 128, 256])?)?;
        wrote.push(p);
    }
    Ok(())
}

fn flutter_web(src: &RgbaImage, root: &Path, wrote: &mut Vec<PathBuf>) -> Result<()> {
    let web = root.join("web");
    if !web.is_dir() {
        return Ok(());
    }
    for (rel, px) in [("favicon.png", 32), ("icons/Icon-192.png", 192), ("icons/Icon-512.png", 512), ("icons/Icon-maskable-192.png", 192), ("icons/Icon-maskable-512.png", 512)] {
        let p = web.join(rel);
        if p.is_file() {
            write_png(&p, src, px, false)?;
            wrote.push(p);
        }
    }
    Ok(())
}

/// Generates the icons for `targets`; returns the files written (relative to `root`).
pub fn generate(source: &Path, root: &Path, targets: &[String]) -> Result<Vec<String>> {
    let src = load_square(source)?;
    let mut wrote = Vec::new();
    for t in targets {
        match t.as_str() {
            "tauri" => tauri(&src, root, &mut wrote)?,
            "web" => web(&src, root, &mut wrote)?,
            "apple" => apple(&src, root, &mut wrote)?,
            "android" => android(&src, root, &mut wrote)?,
            "expo" => expo(&src, root, &mut wrote)?,
            "windows" => windows(&src, root, &mut wrote)?,
            "flutter-web" => flutter_web(&src, root, &mut wrote)?,
            other => return err(format!("Unknown icon target “{other}”")),
        }
    }
    Ok(wrote.into_iter().map(|p| p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/")).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconInfo {
    pub width: u32,
    pub height: u32,
    pub data_url: String,
}

/// Validates an icon image and returns a small preview for the wizard.
#[tauri::command]
pub async fn init_icon_info(path: String) -> Result<IconInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let img = image::open(&path).map_err(|e| format!("Could not read that image: {e}"))?;
        let (width, height) = (img.width(), img.height());
        let square = load_square(Path::new(&path))?;
        let preview = png_bytes(&resized(&square, 128))?;
        Ok(IconInfo {
            width,
            height,
            data_url: format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(preview)),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba([10, 120, 240, 255]))
    }

    #[test]
    fn pads_non_square_images() {
        let dir = std::env::temp_dir().join(format!("bp-icon-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("wide.png");
        sample(40, 20).save(&p).unwrap();
        let sq = load_square(&p).unwrap();
        assert_eq!(sq.dimensions(), (40, 40));
        assert_eq!(sq.get_pixel(0, 0)[3], 0);
        assert_eq!(sq.get_pixel(20, 20)[3], 255);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn ico_and_icns_have_valid_headers() {
        let src = sample(256, 256);
        let ico = ico_bytes(&src, &[16, 32, 256]).unwrap();
        assert_eq!(&ico[..6], &[0, 0, 1, 0, 3, 0]);
        let icns = icns_bytes(&src).unwrap();
        assert_eq!(&icns[..4], b"icns");
        assert_eq!(u32::from_be_bytes(icns[4..8].try_into().unwrap()) as usize, icns.len());
    }

    #[test]
    fn fills_an_asset_catalog_and_flattens_ios_icons() {
        let dir = std::env::temp_dir().join(format!("bp-xcassets-{}", std::process::id()));
        let set = dir.join("App/Assets.xcassets/AppIcon.appiconset");
        std::fs::create_dir_all(&set).unwrap();
        std::fs::write(
            set.join("Contents.json"),
            r#"{"images":[{"filename":"ios.png","idiom":"universal","platform":"ios","size":"1024x1024"},{"filename":"mac_16@2x.png","idiom":"mac","scale":"2x","size":"16x16"}]}"#,
        )
        .unwrap();
        let mut transparent = sample(64, 64);
        transparent.put_pixel(0, 0, Rgba([0, 0, 0, 0]));
        let src = dir.join("src.png");
        transparent.save(&src).unwrap();
        let wrote = generate(&src, &dir, &["apple".into()]).unwrap();
        assert_eq!(wrote.len(), 2);
        let ios = image::open(set.join("ios.png")).unwrap().to_rgba8();
        assert_eq!(ios.dimensions(), (1024, 1024));
        assert_eq!(ios.get_pixel(0, 0)[3], 255);
        let mac = image::open(set.join("mac_16@2x.png")).unwrap().to_rgba8();
        assert_eq!(mac.dimensions(), (32, 32));
        std::fs::remove_dir_all(dir).ok();
    }
}
