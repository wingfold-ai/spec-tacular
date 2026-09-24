//! The job pane.
//!
//! An overlay rather than a screen: you pull it up with ctrl+j to glance at a
//! running agent and drop it again without losing your place. That is the
//! whole point of running agents in the background — reviewing and
//! implementing at once, in one terminal (docs/problem-analysis.md §7).
//!
//! Its keys are handled in [`super::app`]; this draws it.

use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::Frame;

use super::app::{App, Hits, Target};
use super::theme;
use super::widgets::{dim, Flow};
use crate::core::jobs::{Job, JobStatus};

fn status_color(status: JobStatus) -> Color {
    match status {
        JobStatus::Running => theme::ACCENT,
        JobStatus::Succeeded => theme::OK,
        JobStatus::Failed => theme::ERR,
        JobStatus::Cancelled => theme::DIM,
        JobStatus::Interrupted => theme::WARN,
    }
}

fn status_mark(status: JobStatus) -> &'static str {
    match status {
        JobStatus::Running => "◉",
        JobStatus::Succeeded => "✓",
        JobStatus::Failed => "✗",
        JobStatus::Cancelled => "−",
        JobStatus::Interrupted => "?",
    }
}

/// A compact summary for the header: `1 running · 2 failed`.
///
/// Running first — it is the only status anyone is waiting on.
pub fn summarize_jobs(jobs: &[Job]) -> String {
    const ORDER: [JobStatus; 5] = [
        JobStatus::Running,
        JobStatus::Failed,
        JobStatus::Interrupted,
        JobStatus::Succeeded,
        JobStatus::Cancelled,
    ];
    ORDER
        .iter()
        .filter_map(|status| {
            let n = jobs.iter().filter(|j| j.status == *status).count();
            (n > 0).then(|| format!("{n} {status}"))
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Draws the pane into the inside of its panel.
pub fn render_job_pane(frame: &mut Frame<'_>, area: Rect, app: &App, hits: &mut Hits) {
    // One more column of padding than the panel gives, as the TypeScript's
    // `paddingLeft: 1` inside the panel's own did.
    let inner = Rect {
        x: area.x.saturating_add(1),
        width: area.width.saturating_sub(2),
        height: area.height.saturating_sub(1),
        ..area
    };
    let footer = Rect::new(
        inner.x,
        area.y.saturating_add(area.height.saturating_sub(1)),
        inner.width,
        1,
    );
    let mut flow = Flow::new(inner);

    // Two lines, as the TypeScript's header box stacked its two texts: its
    // flex direction was the default column.
    let summary = summarize_jobs(&app.jobs);
    flow.line(
        frame,
        Line::from(Span::styled("jobs", Style::default().fg(theme::ACCENT))),
    );
    flow.line(
        frame,
        dim(format!(
            "  {}",
            if summary.is_empty() {
                "none yet"
            } else {
                &summary
            }
        )),
    );

    if app.jobs.is_empty() {
        flow.blank();
        flow.line(
            frame,
            dim(" Nothing has been dispatched yet. Run one with: spectacular run <artifact> -c <change>"),
        );
    } else {
        for (i, job) in app.jobs.iter().enumerate() {
            let selected = i == app.job_index;
            let y = flow.y;
            flow.line(
                frame,
                Line::from(vec![
                    Span::styled(
                        format!("{} ", if selected { "›" } else { " " }),
                        Style::default().fg(if selected { theme::TEXT } else { theme::DIM }),
                    ),
                    Span::styled(
                        status_mark(job.status),
                        Style::default().fg(status_color(job.status)),
                    ),
                    Span::styled(
                        format!(" {}/{}  {}", job.change, job.artifact, job.status),
                        Style::default().fg(if selected { theme::TEXT } else { theme::DIM }),
                    ),
                ]),
            );
            if y < inner.y.saturating_add(inner.height) {
                hits.push((Rect::new(inner.x, y, inner.width, 1), Target::JobRow(i)));
            }
        }
        flow.blank();
        if app.job_lines.is_empty() {
            flow.line(frame, dim("(no output yet)"));
        } else {
            // A log is read from its end: show the newest lines that fit.
            let room = usize::from(flow.remaining());
            let start = app.job_lines.len().saturating_sub(room);
            for line in &app.job_lines[start..] {
                flow.line(
                    frame,
                    Line::from(Span::styled(line.clone(), Style::default().fg(theme::TEXT))),
                );
            }
        }
    }

    let hint = if app.confirm_cancel {
        let job = app.jobs.get(app.job_index);
        Line::from(Span::styled(
            format!(
                "Cancel {}/{}? Its work in progress is lost.  y / any other key",
                job.map_or("", |j| j.change.as_str()),
                job.map_or("", |j| j.artifact.as_str()),
            ),
            Style::default().fg(theme::WARN),
        ))
    } else {
        dim("j/k move · x cancel job · p clear finished · q close")
    };
    frame.render_widget(ratatui::widgets::Paragraph::new(hint), footer);
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn job(id: &str, status: JobStatus) -> Job {
        Job {
            id: id.to_owned(),
            change: "add-dark-mode".to_owned(),
            artifact: "design".to_owned(),
            driver: "claude".to_owned(),
            command: "claude".to_owned(),
            args: Vec::new(),
            cwd: "/p".to_owned(),
            status,
            started_at: "2026-09-21T10:00:00.000Z".to_owned(),
            ended_at: None,
            exit_code: None,
            pid: None,
            log_path: "/p/.spec-tacular/jobs/j1.log".to_owned(),
        }
    }

    #[test]
    fn running_comes_first_it_is_the_only_status_anyone_waits_on() {
        assert_eq!(
            summarize_jobs(&[
                job("a", JobStatus::Running),
                job("b", JobStatus::Succeeded),
                job("c", JobStatus::Failed),
            ]),
            "1 running · 1 failed · 1 succeeded"
        );
    }

    #[test]
    fn no_jobs_is_an_empty_summary() {
        assert_eq!(summarize_jobs(&[]), "");
    }
}
