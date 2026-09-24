//! Plain-text rendering of the pipeline.
//!
//! Exists so the overview works without a TTY — in CI, over a pipe, in a remote
//! session — and so the layout can be unit-tested without driving a terminal.
//! The TUI renders the same model; this is the reference output, not a fallback
//! afterthought.

use crate::core::gate::stale_artifacts;
use crate::core::pipeline::{ChangePipeline, Stage, StageState};

/// The mark that leads every stage cell.
fn mark(state: StageState) -> char {
    match state {
        StageState::Accepted => '+', // written AND fully reviewed
        StageState::Written => '*',  // written to disk, review unfinished or unknown
        StageState::Ready => '>',    // actionable now
        StageState::Blocked => 'o',  // prerequisites unmet
    }
}

const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const YELLOW: &str = "\x1b[33m";
const GREEN: &str = "\x1b[32m";
const RESET: &str = "\x1b[0m";

fn paint(s: &str, code: &str, on: bool) -> String {
    if on {
        format!("{code}{s}{RESET}")
    } else {
        s.to_owned()
    }
}

/// What the overview shows besides the pipelines themselves.
#[derive(Debug, Clone, Default)]
pub struct OverviewOptions<'a> {
    /// Emit ANSI colour. Off when not a TTY.
    pub color: bool,
    /// Changes OpenSpec could not load, named rather than silently dropped.
    pub failed: &'a [String],
    /// The project root, printed above the list when known.
    pub root: Option<&'a str>,
}

/// One change as a single line: `* proposal  * specs  > design  o tasks`.
pub fn render_pipeline_bar(pipeline: &ChangePipeline, color: bool) -> String {
    pipeline
        .all_stages()
        .map(|stage| {
            let cell = format!("{} {}", mark(stage.state), stage.id);
            match stage.state {
                StageState::Ready => paint(&cell, BOLD, color),
                StageState::Blocked => paint(&cell, DIM, color),
                StageState::Accepted => paint(&cell, GREEN, color),
                StageState::Written => cell,
            }
        })
        .collect::<Vec<_>>()
        .join("  ")
}

fn describe_blocked(stage: &Stage) -> String {
    format!("{} blocked by {}", stage.id, stage.blocked_by.join(", "))
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

/// The full overview: every change, its pipeline, and anything inconsistent.
pub fn render_overview(pipelines: &[ChangePipeline], opts: &OverviewOptions<'_>) -> String {
    let color = opts.color;
    let mut out: Vec<String> = Vec::new();

    if let Some(root) = opts.root {
        out.push(paint(root, DIM, color));
    }
    out.push(format!(
        "{} change{}",
        pipelines.len(),
        plural(pipelines.len())
    ));
    out.push(String::new());

    let width = pipelines
        .iter()
        .map(|p| p.name.chars().count())
        .max()
        .unwrap_or(0);
    let indent = " ".repeat(width);

    for pipeline in pipelines {
        let name = format!("{:width$}", pipeline.name, width = width);
        out.push(format!(
            "{}  {}",
            paint(&name, BOLD, color),
            render_pipeline_bar(pipeline, color)
        ));

        let next = match pipeline.current_stage() {
            Some(stage) => format!(
                "next: {}{}",
                stage.id,
                if stage.state == StageState::Written {
                    " (review)"
                } else {
                    ""
                }
            ),
            None => "planning complete — ready to apply".to_owned(),
        };
        out.push(format!("{indent}  {}", paint(&next, DIM, color)));

        for stage in &pipeline.stages {
            let Some(review) = stage.review else {
                continue;
            };
            let mut bits = vec![format!("{}/{} accepted", review.accepted, review.total)];
            if review.rejected > 0 {
                bits.push(format!("{} rejected", review.rejected));
            }
            if review.deferred > 0 {
                bits.push(format!("{} deferred", review.deferred));
            }
            if review.pending > 0 {
                bits.push(format!("{} pending", review.pending));
            }
            // Drift is called out separately and in warning colour: it means a
            // decision a human already made is no longer valid.
            let line = format!("{}: {}", stage.id, bits.join(" · "));
            let drift = if review.drifted > 0 {
                paint(
                    &format!("  ! {} changed since review", review.drifted),
                    YELLOW,
                    color,
                )
            } else {
                String::new()
            };
            out.push(format!(
                "{indent}  {}{drift}",
                paint(&line, if review.complete { GREEN } else { DIM }, color)
            ));
        }

        // A downstream artifact written against something that changed since is
        // the precise failure the sequencing fix exists to prevent, and OpenSpec
        // cannot see it: both files still exist, so it reports everything fine.
        for stale in stale_artifacts(pipeline) {
            out.push(format!(
                "{indent}  {}",
                paint(
                    &format!(
                        "! {} may be stale — {}",
                        stale.artifact,
                        stale.because.join("; ")
                    ),
                    YELLOW,
                    color,
                )
            ));
        }

        for gap in &pipeline.gaps {
            // Worded as an observation, not a verdict: an optional artifact that
            // was deliberately skipped looks identical on disk. See
            // `PrerequisiteGap`.
            out.push(format!(
                "{indent}  {}",
                paint(
                    &format!(
                        "? {} exists but {} was never written",
                        gap.artifact,
                        gap.missing.join(", ")
                    ),
                    YELLOW,
                    color,
                )
            ));
        }
        out.push(String::new());
    }

    let blocked: Vec<String> = pipelines
        .iter()
        .flat_map(|p| {
            p.all_stages()
                .filter(|s| s.state == StageState::Blocked)
                .map(describe_blocked)
        })
        .collect();
    let stale = pipelines
        .iter()
        .filter(|p| !stale_artifacts(p).is_empty())
        .count();
    let with_gaps = pipelines.iter().filter(|p| !p.gaps.is_empty()).count();

    out.push(paint(
        &format!(
            "{} blocked stage{} · {} change{} with an unwritten prerequisite · {} with a possibly stale artifact",
            blocked.len(),
            plural(blocked.len()),
            with_gaps,
            plural(with_gaps),
            stale,
        ),
        DIM,
        color,
    ));

    if !opts.failed.is_empty() {
        out.push(paint(
            &format!(
                "{} change(s) failed to load: {}",
                opts.failed.len(),
                opts.failed.join(", ")
            ),
            YELLOW,
            color,
        ));
    }

    out.push(paint(
        "legend: + accepted · * written (review unfinished) · > ready · o blocked.\n\
         A \"?\" marks an artifact whose prerequisite was never written; under\n\
         spec-driven that may be a deliberate skip.",
        DIM,
        color,
    ));

    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::types::OpenSpecChangeStatus;
    use crate::core::pipeline::fixtures::{artifact, reviews};
    use crate::core::pipeline::{build_pipeline, ReviewByArtifact};
    use crate::core::review::ReviewSummary;

    fn status() -> OpenSpecChangeStatus {
        OpenSpecChangeStatus {
            change_name: "add-dark-mode".to_owned(),
            schema_name: "spec-driven".to_owned(),
            change_root: "/tmp/add-dark-mode".to_owned(),
            apply_requires: vec!["tasks".to_owned()],
            artifacts: vec![
                artifact("proposal", "done", &[]),
                artifact("specs", "done", &["proposal"]),
                artifact("design", "ready", &["proposal"]),
                artifact("tasks", "done", &["specs", "design"]),
            ],
            ..OpenSpecChangeStatus::default()
        }
    }

    fn pipeline(reviews: &ReviewByArtifact) -> ChangePipeline {
        build_pipeline(&status(), reviews)
    }

    fn bare() -> ChangePipeline {
        pipeline(&ReviewByArtifact::new())
    }

    fn overview(pipelines: &[ChangePipeline]) -> String {
        render_overview(pipelines, &OverviewOptions::default())
    }

    #[test]
    fn shows_every_stage_plus_apply_in_schema_order() {
        let bar = render_pipeline_bar(&bare(), false);
        assert!(bar.contains("* proposal"));
        assert!(bar.contains("> design"));
        assert!(bar.contains("apply"));
        assert!(bar.find("proposal") < bar.find("design"));
    }

    #[test]
    fn emits_no_ansi_codes_unless_colour_is_requested() {
        assert!(!render_pipeline_bar(&bare(), false).contains('\x1b'));
        assert!(render_pipeline_bar(&bare(), true).contains('\x1b'));
    }

    #[test]
    fn names_the_change_and_its_next_actionable_stage() {
        let out = render_overview(
            &[bare()],
            &OverviewOptions {
                root: Some("/tmp/proj"),
                ..OverviewOptions::default()
            },
        );
        assert!(out.contains("add-dark-mode"));
        assert!(out.contains("next: design"));
        assert!(out.starts_with("/tmp/proj\n"));
    }

    #[test]
    fn surfaces_an_unwritten_prerequisite_by_name() {
        assert!(overview(&[bare()]).contains("tasks exists but design was never written"));
    }

    #[test]
    fn distinguishes_written_from_accepted_in_the_legend() {
        let out = overview(&[bare()]);
        assert!(out.contains("+ accepted"));
        assert!(out.contains("* written (review unfinished)"));
    }

    #[test]
    fn an_artifact_with_no_review_data_is_never_shown_as_accepted() {
        // Absence of review is not evidence of review.
        let bar = render_pipeline_bar(&bare(), false);
        assert!(bar.contains("* specs"));
        assert!(!bar.contains("+ specs"));
    }

    #[test]
    fn shows_review_progress_when_the_artifact_carries_requirements() {
        let out = overview(&[pipeline(&reviews(&[(
            "specs",
            ReviewSummary {
                total: 10,
                accepted: 7,
                rejected: 1,
                deferred: 0,
                pending: 2,
                drifted: 0,
                complete: false,
            },
        )]))]);
        assert!(
            out.contains("specs: 7/10 accepted · 1 rejected · 2 pending"),
            "unexpected overview:\n{out}"
        );
    }

    #[test]
    fn marks_a_fully_reviewed_artifact_accepted_and_calls_out_drift() {
        let accepted = pipeline(&reviews(&[(
            "specs",
            ReviewSummary {
                total: 4,
                accepted: 3,
                rejected: 0,
                deferred: 1,
                pending: 0,
                drifted: 0,
                complete: true,
            },
        )]));
        assert!(render_pipeline_bar(&accepted, false).contains("+ specs"));

        let drifted = overview(&[pipeline(&reviews(&[(
            "specs",
            ReviewSummary {
                total: 4,
                accepted: 3,
                rejected: 0,
                deferred: 0,
                pending: 1,
                drifted: 1,
                complete: false,
            },
        )]))]);
        assert!(drifted.contains("1 changed since review"));
    }

    #[test]
    fn reports_changes_that_failed_to_load() {
        let failed = vec!["broken".to_owned()];
        let out = render_overview(
            &[bare()],
            &OverviewOptions {
                failed: &failed,
                ..OverviewOptions::default()
            },
        );
        assert!(out.contains("failed to load: broken"));
    }

    #[test]
    fn handles_an_empty_project_without_crashing() {
        assert!(overview(&[]).contains("0 changes"));
    }

    #[test]
    fn one_change_is_singular() {
        // The counters read as prose, so they have to agree with themselves.
        assert!(overview(&[bare()]).contains("1 change\n"));
        assert!(overview(&[bare()]).contains("1 change with an unwritten prerequisite"));
    }
}
