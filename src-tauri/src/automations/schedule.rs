//! When an automation is due.

use super::*;

/// The earliest time this automation may run again for a project whose last run was `last_run`.
/// `None` means never (manual-only, or a one-off that already ran). `i64::MIN` means "any time".
pub fn next_due(a: &Automation, last_run: Option<i64>) -> Option<i64> {
    if a.trigger == "manual" {
        return None;
    }
    let first = a.run_at;
    match (a.repeat_hours.filter(|h| *h > 0), last_run) {
        (Some(h), Some(l)) => Some((l + h * HOUR_MS).max(first.unwrap_or(i64::MIN))),
        (Some(_), None) => Some(first.unwrap_or(i64::MIN)),
        (None, l) => match (first, l) {
            (Some(f), Some(l)) if l >= f => None,
            (Some(f), _) => Some(f),
            (None, _) => Some(i64::MIN),
        },
    }
}

pub fn is_due(a: &Automation, last_run: Option<i64>, at: i64) -> bool {
    next_due(a, last_run).is_some_and(|n| n <= at)
}
