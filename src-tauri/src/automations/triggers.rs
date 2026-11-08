//! Event triggers and their filters: file changes (a glob), branch switches and pushes (an optional
//! branch glob), and fork updates.

use globset::{Glob, GlobSet, GlobSetBuilder};

use super::*;

/// Patterns are separated by commas or new lines: `src/**/*.ts, *.css`.
pub fn patterns(filter: &str) -> Vec<&str> {
    filter.split([',', '\n']).map(str::trim).filter(|p| !p.is_empty()).collect()
}

pub fn build(filter: &str) -> std::result::Result<GlobSet, String> {
    let mut b = GlobSetBuilder::new();
    for p in patterns(filter) {
        b.add(Glob::new(p).map_err(|e| format!("“{p}” is not a valid pattern: {}", e.kind()))?);
    }
    b.build().map_err(|e| e.to_string())
}

/// Whether an event with these values (changed paths, or the branch name) should run `a`.
/// No filter means "always", except for file changes, which need one.
pub fn matches(a: &Automation, values: &[String]) -> bool {
    match a.trigger_filter.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        None => a.trigger != "files",
        Some(_) if a.trigger == "fork" || a.trigger == "commit" => true,
        Some(f) => build(f).is_ok_and(|g| values.iter().any(|v| g.is_match(v))),
    }
}
