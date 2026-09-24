//! The pipeline model: OpenSpec's artifact list turned into the stage view that
//! is always on screen.
//!
//! Deliberately schema-agnostic. Stages are derived from whatever artifacts the
//! change's schema declares, in dependency order, so this works unchanged with
//! `spec-driven`, with spec-tacular's own schema, and with any custom schema a
//! project forks.
//!
//! Two different truths live here and must not be confused. `written` is
//! OpenSpec's: the file exists. `accepted` is spec-tacular's: a human reviewed
//! every requirement in it. An artifact with no review data can only ever reach
//! `written`, never `accepted` — absence of review is never evidence of review.

use std::collections::{BTreeMap, HashSet};

use crate::adapter::types::{OpenSpecArtifact, OpenSpecArtifactStatus, OpenSpecChangeStatus};

use super::review::ReviewSummary;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageState {
    /// Prerequisites unmet — cannot be started.
    Blocked,
    /// Prerequisites met, not yet written.
    Ready,
    /// Written to disk. Reviewed? Unknown, or known to be unfinished.
    Written,
    /// Written AND every requirement accepted or deferred, with no drift.
    Accepted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stage {
    pub id: String,
    pub state: StageState,
    pub requires: Vec<String>,
    /// Why this stage is blocked: the prerequisite IDs that are not yet written.
    pub blocked_by: Vec<String>,
    /// Review progress, when this artifact carries reviewable requirements.
    pub review: Option<ReviewSummary>,
}

/// An artifact that exists although a prerequisite of it does not.
///
/// Related to docs/problem-analysis.md §1, but it is NOT proof of a defect, and
/// must not be presented as one. OpenSpec has no way for a schema to mark an
/// artifact optional — yet `spec-driven` documents `design` as exactly that
/// ("create only if any apply"). So a deliberately skipped optional artifact and
/// one that was forgotten produce identical data, and nothing on disk tells them
/// apart.
///
/// It is therefore reported as something worth a human's glance, never as an
/// error. Under spec-tacular's own schema, where every artifact is mandatory and
/// `design` requires `specs`, a gap here does mean the order was violated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrerequisiteGap {
    pub artifact: String,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangePipeline {
    pub name: String,
    pub schema: String,
    pub root: String,
    pub stages: Vec<Stage>,
    /// Appended after the schema's artifacts; gated by the schema's
    /// `apply.requires`.
    pub apply: Stage,
    pub gaps: Vec<PrerequisiteGap>,
    /// The stage a human should look at next, as an index into `stages`, or
    /// `None` when planning is finished.
    ///
    /// An index rather than a copy of the stage, so there is exactly one
    /// authority on a stage's state and no chance of the two disagreeing.
    pub current: Option<usize>,
    pub written: usize,
    pub accepted: usize,
    pub total: usize,
}

impl ChangePipeline {
    pub fn current_stage(&self) -> Option<&Stage> {
        self.current.and_then(|i| self.stages.get(i))
    }

    /// Every stage the schema declares, plus `apply`.
    pub fn all_stages(&self) -> impl Iterator<Item = &Stage> {
        self.stages.iter().chain(std::iter::once(&self.apply))
    }
}

fn to_state(
    artifact: &OpenSpecArtifact,
    written: &HashSet<&str>,
    review: Option<ReviewSummary>,
) -> Stage {
    let blocked_by: Vec<String> = artifact
        .requires
        .iter()
        .filter(|r| !written.contains(r.as_str()))
        .cloned()
        .collect();
    // OpenSpec's own status is trusted for done/blocked, but `blocked_by` is
    // recomputed here: its `ready` and `blocked` do not carry the reason, and
    // the reason is the whole point of showing a blocked stage in the UI.
    let state = if artifact.status == OpenSpecArtifactStatus::Done {
        if review.is_some_and(|r| r.complete) {
            StageState::Accepted
        } else {
            StageState::Written
        }
    } else if blocked_by.is_empty() {
        StageState::Ready
    } else {
        StageState::Blocked
    };

    Stage {
        id: artifact.id.clone(),
        state,
        requires: artifact.requires.clone(),
        blocked_by,
        review,
    }
}

/// Review summaries keyed by artifact id. Only `specs` carries one today.
pub type ReviewByArtifact = BTreeMap<String, ReviewSummary>;

pub fn build_pipeline(status: &OpenSpecChangeStatus, reviews: &ReviewByArtifact) -> ChangePipeline {
    let written: HashSet<&str> = status
        .artifacts
        .iter()
        .filter(|a| a.status == OpenSpecArtifactStatus::Done)
        .map(|a| a.id.as_str())
        .collect();

    let stages: Vec<Stage> = status
        .artifacts
        .iter()
        .map(|a| to_state(a, &written, reviews.get(&a.id).copied()))
        .collect();

    let apply_blocked_by: Vec<String> = status
        .apply_requires
        .iter()
        .filter(|r| !written.contains(r.as_str()))
        .cloned()
        .collect();
    let apply = Stage {
        id: "apply".to_owned(),
        // `apply` is never `written`: whether implementation is finished is a
        // question about tasks.md checkboxes, not about a file existing. That
        // lands with the task parser in M8.
        state: if apply_blocked_by.is_empty() {
            StageState::Ready
        } else {
            StageState::Blocked
        },
        requires: status.apply_requires.clone(),
        blocked_by: apply_blocked_by,
        review: None,
    };

    let mut gaps: Vec<PrerequisiteGap> = Vec::new();
    for a in &status.artifacts {
        if a.status != OpenSpecArtifactStatus::Done {
            continue;
        }
        let missing: Vec<String> = a
            .requires
            .iter()
            .filter(|r| !written.contains(r.as_str()))
            .cloned()
            .collect();
        if !missing.is_empty() {
            gaps.push(PrerequisiteGap {
                artifact: a.id.clone(),
                missing,
            });
        }
    }

    // The first stage a human can act on. A blocked stage is skipped (acting on
    // it is impossible), but a written-and-unreviewed one is NOT: reviewing it
    // is exactly the work this tool exists for, and it comes before writing the
    // next artifact.
    let current = stages
        .iter()
        .position(|s| s.state == StageState::Written && s.review.is_some())
        .or_else(|| stages.iter().position(|s| s.state == StageState::Ready));

    let accepted = stages
        .iter()
        .filter(|s| s.state == StageState::Accepted)
        .count();

    ChangePipeline {
        name: status.change_name.clone(),
        schema: status.schema_name.clone(),
        root: status.change_root.clone(),
        stages,
        apply,
        gaps,
        current,
        written: written.len(),
        accepted,
        total: status.artifacts.len(),
    }
}

/// Sorted least-complete first, so what needs attention is at the top.
pub fn sort_by_progress(pipelines: &[ChangePipeline]) -> Vec<ChangePipeline> {
    // A change with no artifacts counts as finished rather than dividing by
    // zero; there is nothing left to do to it either way.
    fn ratio(p: &ChangePipeline) -> f64 {
        if p.total == 0 {
            1.0
        } else {
            p.written as f64 / p.total as f64
        }
    }

    let mut sorted = pipelines.to_vec();
    sorted.sort_by(|a, b| {
        ratio(a)
            .partial_cmp(&ratio(b))
            .unwrap_or(std::cmp::Ordering::Equal)
            // Case-insensitive first, then exact, standing in for JavaScript's
            // `localeCompare`: a plain byte comparison would file every
            // capitalised change name ahead of every lower-case one, which is
            // not the order anyone reading the list expects.
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    sorted
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    /// An artifact, as OpenSpec's `--json` reports one.
    pub fn artifact(id: &str, status: &str, requires: &[&str]) -> OpenSpecArtifact {
        OpenSpecArtifact {
            id: id.to_owned(),
            output_path: format!("{id}.md"),
            status: match status {
                "done" => OpenSpecArtifactStatus::Done,
                "ready" => OpenSpecArtifactStatus::Ready,
                "blocked" => OpenSpecArtifactStatus::Blocked,
                other => panic!("no such artifact status: {other}"),
            },
            requires: requires.iter().map(|r| (*r).to_owned()).collect(),
        }
    }

    pub fn change(
        name: &str,
        artifacts: Vec<OpenSpecArtifact>,
        apply_requires: &[&str],
    ) -> OpenSpecChangeStatus {
        OpenSpecChangeStatus {
            change_name: name.to_owned(),
            schema_name: "spec-driven".to_owned(),
            change_root: format!("/tmp/{name}"),
            apply_requires: apply_requires.iter().map(|r| (*r).to_owned()).collect(),
            artifacts,
            ..OpenSpecChangeStatus::default()
        }
    }

    /// A review summary that is complete unless a test says otherwise.
    pub fn summary() -> ReviewSummary {
        ReviewSummary {
            total: 10,
            accepted: 10,
            rejected: 0,
            deferred: 0,
            pending: 0,
            drifted: 0,
            complete: true,
        }
    }

    pub fn reviews(entries: &[(&str, ReviewSummary)]) -> ReviewByArtifact {
        entries
            .iter()
            .map(|(id, s)| ((*id).to_owned(), *s))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    fn pipeline(artifacts: Vec<OpenSpecArtifact>) -> ChangePipeline {
        build_pipeline(
            &change("c", artifacts, &["tasks"]),
            &ReviewByArtifact::new(),
        )
    }

    #[test]
    fn maps_openspec_statuses_onto_stage_states() {
        let p = pipeline(vec![
            artifact("proposal", "done", &[]),
            artifact("specs", "ready", &["proposal"]),
            artifact("design", "blocked", &["specs"]),
        ]);
        assert_eq!(
            p.stages.iter().map(|s| s.state).collect::<Vec<_>>(),
            vec![StageState::Written, StageState::Ready, StageState::Blocked]
        );
    }

    #[test]
    fn records_why_a_stage_is_blocked() {
        let p = pipeline(vec![
            artifact("proposal", "ready", &[]),
            artifact("tasks", "blocked", &["specs", "design"]),
        ]);
        assert_eq!(p.stages[1].blocked_by, vec!["specs", "design"]);
    }

    #[test]
    fn current_stage_is_the_first_actionable_one_skipping_blocked_stages() {
        let p = pipeline(vec![
            artifact("proposal", "done", &[]),
            artifact("specs", "ready", &["proposal"]),
            artifact("design", "blocked", &["specs"]),
        ]);
        assert_eq!(p.current_stage().map(|s| s.id.as_str()), Some("specs"));
    }

    #[test]
    fn current_is_none_once_every_artifact_is_written() {
        let p = pipeline(vec![
            artifact("proposal", "done", &[]),
            artifact("specs", "done", &[]),
        ]);
        assert!(p.current_stage().is_none());
    }

    #[test]
    fn a_written_but_unreviewed_artifact_is_the_current_stage() {
        // Reviewing it is the work this tool exists for; it comes before
        // writing the next artifact.
        let p = build_pipeline(
            &change(
                "c",
                vec![
                    artifact("specs", "done", &[]),
                    artifact("design", "ready", &["specs"]),
                ],
                &["tasks"],
            ),
            &reviews(&[(
                "specs",
                ReviewSummary {
                    pending: 2,
                    accepted: 8,
                    complete: false,
                    ..summary()
                },
            )]),
        );
        assert_eq!(p.current_stage().map(|s| s.id.as_str()), Some("specs"));
    }

    #[test]
    fn apply_is_gated_by_the_schema_apply_requires_never_written() {
        let blocked = pipeline(vec![artifact("tasks", "ready", &[])]);
        assert_eq!(blocked.apply.state, StageState::Blocked);
        assert_eq!(blocked.apply.blocked_by, vec!["tasks"]);

        let ready = pipeline(vec![artifact("tasks", "done", &[])]);
        assert_eq!(ready.apply.state, StageState::Ready);
    }

    #[test]
    fn apply_with_no_requirements_is_ready() {
        let p = build_pipeline(
            &change("c", vec![artifact("proposal", "ready", &[])], &[]),
            &ReviewByArtifact::new(),
        );
        assert_eq!(p.apply.state, StageState::Ready);
    }

    #[test]
    fn flags_an_artifact_whose_prerequisite_was_never_written() {
        // The real shape seen in OpenSpec's own repo: tasks.md written while
        // design.md does not exist.
        let p = pipeline(vec![
            artifact("proposal", "done", &[]),
            artifact("specs", "done", &["proposal"]),
            artifact("design", "ready", &["proposal"]),
            artifact("tasks", "done", &["specs", "design"]),
        ]);
        assert_eq!(
            p.gaps,
            vec![PrerequisiteGap {
                artifact: "tasks".to_owned(),
                missing: vec!["design".to_owned()],
            }]
        );
    }

    #[test]
    fn a_consistent_change_has_no_gaps() {
        let p = pipeline(vec![
            artifact("proposal", "done", &[]),
            artifact("specs", "done", &["proposal"]),
        ]);
        assert!(p.gaps.is_empty());
    }

    #[test]
    fn an_unwritten_artifact_with_missing_prerequisites_is_blocked_not_a_gap() {
        let p = pipeline(vec![
            artifact("proposal", "ready", &[]),
            artifact("specs", "blocked", &["proposal"]),
        ]);
        assert!(p.gaps.is_empty());
        assert_eq!(p.stages[1].state, StageState::Blocked);
    }

    #[test]
    fn an_artifact_with_no_review_data_is_never_accepted() {
        // Absence of review is not evidence of review.
        let p = pipeline(vec![artifact("specs", "done", &[])]);
        assert_eq!(p.stages[0].state, StageState::Written);
        assert_eq!(p.accepted, 0);
    }

    #[test]
    fn sort_by_progress_puts_the_least_complete_first_ties_broken_by_name() {
        let far = pipeline_named("far", &[("p", "done"), ("s", "done")]);
        let near = pipeline_named("near", &[("p", "done"), ("s", "ready")]);
        let bbb = pipeline_named("bbb", &[("p", "done"), ("s", "done")]);
        let sorted = sort_by_progress(&[far, near, bbb]);
        assert_eq!(
            sorted.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["near", "bbb", "far"]
        );
    }

    #[test]
    fn sort_by_progress_does_not_mutate_its_input() {
        let input = vec![
            pipeline_named("two", &[("p", "done")]),
            pipeline_named("one", &[("p", "ready")]),
        ];
        sort_by_progress(&input);
        assert_eq!(
            input.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["two", "one"]
        );
    }

    #[test]
    fn a_change_with_no_artifacts_is_complete_not_divided_by_zero() {
        let empty = pipeline_named("empty", &[]);
        let partial = pipeline_named("partial", &[("p", "ready")]);
        let sorted = sort_by_progress(&[empty, partial]);
        assert_eq!(
            sorted.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["partial", "empty"]
        );
    }

    fn pipeline_named(name: &str, artifacts: &[(&str, &str)]) -> ChangePipeline {
        build_pipeline(
            &change(
                name,
                artifacts
                    .iter()
                    .map(|(id, status)| artifact(id, status, &[]))
                    .collect(),
                &["tasks"],
            ),
            &ReviewByArtifact::new(),
        )
    }
}
