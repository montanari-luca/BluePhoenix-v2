//! One background loop for every periodic job (cloud sync, scheduled automations, fork checks,
//! git watcher upkeep). Each subsystem only says *what* to run and how often; this module owns the
//! timing. A job runs in its own task, so a slow sync never delays automations, and a job never
//! overlaps itself: if it is still running when it comes due again, that turn is skipped.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::time::Instant;

/// How often the loop wakes up to look for due jobs.
const RESOLUTION: Duration = Duration::from_secs(1);

type JobFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type JobFn = Arc<dyn Fn(AppHandle) -> JobFuture + Send + Sync>;

pub struct Job {
    pub name: &'static str,
    /// Delay after app start before the first run.
    pub first_after: Duration,
    /// Time between runs; `None` runs the job once.
    pub every: Option<Duration>,
    run: JobFn,
}

impl Job {
    pub fn every<F, Fut>(name: &'static str, first_after: Duration, every: Duration, f: F) -> Self
    where
        F: Fn(AppHandle) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        Job { name, first_after, every: Some(every), run: Arc::new(move |app| Box::pin(f(app))) }
    }

    pub fn once<F, Fut>(name: &'static str, after: Duration, f: F) -> Self
    where
        F: Fn(AppHandle) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        Job { name, first_after: after, every: None, run: Arc::new(move |app| Box::pin(f(app))) }
    }
}

struct Slot {
    job: Job,
    next: Option<Instant>,
    running: Arc<AtomicBool>,
}

/// Decides which slots are due at `now` and moves their next time forward. Pure, so it is testable.
fn take_due(slots: &mut [Slot], now: Instant) -> Vec<usize> {
    let mut due = vec![];
    for (i, s) in slots.iter_mut().enumerate() {
        let Some(next) = s.next else { continue };
        if now < next {
            continue;
        }
        s.next = s.job.every.map(|every| {
            // Skip missed turns (after sleep, for example) instead of running them back to back.
            let mut n = next + every;
            while n <= now {
                n += every;
            }
            n
        });
        if s.running.load(Ordering::SeqCst) {
            continue; // still busy with the previous turn
        }
        due.push(i);
    }
    due
}

/// Starts the loop with the given jobs. Call once from `setup`.
pub fn start(app: AppHandle, jobs: Vec<Job>) {
    tauri::async_runtime::spawn(async move {
        let start = Instant::now();
        let mut slots: Vec<Slot> = jobs
            .into_iter()
            .map(|job| Slot { next: Some(start + job.first_after), job, running: Arc::new(AtomicBool::new(false)) })
            .collect();
        loop {
            for i in take_due(&mut slots, Instant::now()) {
                let s = &slots[i];
                let running = s.running.clone();
                let run = s.job.run.clone();
                let app = app.clone();
                running.store(true, Ordering::SeqCst);
                #[cfg(debug_assertions)]
                eprintln!("[scheduler] {}", s.job.name);
                tauri::async_runtime::spawn(async move {
                    run(app).await;
                    running.store(false, Ordering::SeqCst);
                });
            }
            tokio::time::sleep(RESOLUTION).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(first: u64, every: Option<u64>, t0: Instant) -> Slot {
        let job = match every {
            Some(e) => Job::every("t", Duration::from_secs(first), Duration::from_secs(e), |_| async {}),
            None => Job::once("t", Duration::from_secs(first), |_| async {}),
        };
        Slot { next: Some(t0 + job.first_after), job, running: Arc::new(AtomicBool::new(false)) }
    }

    #[test]
    fn runs_after_first_delay_then_every_interval() {
        let t0 = Instant::now();
        let mut s = [slot(5, Some(60), t0)];
        assert!(take_due(&mut s, t0 + Duration::from_secs(4)).is_empty());
        assert_eq!(take_due(&mut s, t0 + Duration::from_secs(5)), vec![0]);
        assert!(take_due(&mut s, t0 + Duration::from_secs(30)).is_empty());
        assert_eq!(take_due(&mut s, t0 + Duration::from_secs(65)), vec![0]);
    }

    #[test]
    fn once_jobs_run_a_single_time() {
        let t0 = Instant::now();
        let mut s = [slot(1, None, t0)];
        assert_eq!(take_due(&mut s, t0 + Duration::from_secs(1)), vec![0]);
        assert!(take_due(&mut s, t0 + Duration::from_secs(1000)).is_empty());
    }

    #[test]
    fn missed_turns_collapse_into_one() {
        let t0 = Instant::now();
        let mut s = [slot(0, Some(10), t0)];
        assert_eq!(take_due(&mut s, t0 + Duration::from_secs(95)), vec![0]);
        assert_eq!(s[0].next, Some(t0 + Duration::from_secs(100)));
    }

    #[test]
    fn busy_jobs_skip_their_turn() {
        let t0 = Instant::now();
        let mut s = [slot(0, Some(10), t0)];
        s[0].running.store(true, Ordering::SeqCst);
        assert!(take_due(&mut s, t0).is_empty());
        s[0].running.store(false, Ordering::SeqCst);
        assert_eq!(take_due(&mut s, t0 + Duration::from_secs(10)), vec![0]);
    }
}
