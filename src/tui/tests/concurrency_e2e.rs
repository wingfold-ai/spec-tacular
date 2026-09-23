//! Reviewing while a job runs — the review half of the TypeScript
//! `concurrency-e2e` suite. Its other half (two changes may run at once, one
//! change may not run twice, cancelling one leaves the other) is about the
//! job runner alone and lives with it, in `core::jobs`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::agent::driver::AgentCommand;
use crate::core::jobs::{cancel_job, get_job, start_job, Job, JobStatus, StartJobOptions};
use crate::tui::app::Screen;
use crate::tui::fake::job;

use super::Ui;

/// Cancels the job when dropped — a failed assertion must not leave a
/// `sleep 30` behind — and waits for it to be gone.
struct Running {
    root: PathBuf,
    job: Job,
}

impl Drop for Running {
    fn drop(&mut self) {
        cancel_job(&self.root, &self.job.id);
        let Some(pid) = self.job.pid.and_then(|p| i32::try_from(p).ok()) else {
            return;
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        // SAFETY: signal 0 only asks whether the pid exists; it sends nothing.
        while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(15));
        }
    }
}

fn start_slow(root: &Path, change: &str) -> Running {
    let job = start_job(StartJobOptions {
        project_root: root,
        change,
        artifact: "apply",
        driver: "test",
        command: AgentCommand::new("sh", ["-c", "echo starting; sleep 30"]),
        cwd: root,
    })
    .expect("start");
    Running {
        root: root.to_path_buf(),
        job,
    }
}

const SPEC: &str = "## ADDED Requirements

### Requirement: Alpha
SHALL alpha.

### Requirement: Beta
SHALL beta.
";

#[test]
fn a_long_job_on_change_a_does_not_block_reviewing_change_b() {
    let mut ui = Ui::reviewing("change-b", &[("cap", SPEC)], None);
    let root = ui.ports.path();

    // A slow agent on change A: a real detached subprocess.
    let running = start_slow(&root, "change-a");
    assert_eq!(running.job.status, JobStatus::Running);

    // Meanwhile, review change B end to end.
    ui.char('a');
    ui.char('a');
    let summary = ui.session().summary;
    assert_eq!(summary.accepted, 2);
    assert!(summary.complete);
    // And the job is still going, untouched by any of it.
    assert_eq!(
        get_job(&root, &running.job.id).map(|j| j.status),
        Some(JobStatus::Running)
    );
}

#[test]
fn a_job_that_finishes_mid_review_is_noticed_without_pulling_you_out() {
    let mut ui = Ui::reviewing("change-b", &[("cap", SPEC)], None);
    ui.ports
        .add_job(job("j1", "change-a", "design", JobStatus::Running), &[]);
    // A glance at the pane, and back — the review is where it was.
    ui.ctrl('j');
    ui.ctrl('j');
    ui.expect("jobs: 1 running");
    ui.char('a');

    ui.ports.set_job_status("j1", JobStatus::Succeeded);
    ui.poll();
    ui.expect("✦ The design of change-a is drafted");
    assert_eq!(
        ui.app.screen,
        Screen::Review,
        "a draft never interrupts a review"
    );
    ui.expect("requirement 2 of 2");
    ui.char('a');
    assert!(ui.session().summary.complete);
}
