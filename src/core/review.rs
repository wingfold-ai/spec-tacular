//! Review state — the thing OpenSpec does not have.
//!
//! OpenSpec decides an artifact is complete by checking that its file exists
//! (`artifact-graph/state.ts`). That cannot answer "which specs have been
//! finished off and accepted", so spec-tacular keeps acceptance in a sidecar
//! OpenSpec never reads.
//!
//! The sidecar is never trusted on its own. Every requirement carries the hash
//! of the text that was accepted, and every load re-hashes the Markdown and
//! compares. Files get edited outside this tool — by you, by an agent — and a
//! review tool that keeps claiming "accepted" for text nobody accepted is worse
//! than having no review tool at all.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::requirements::{slugify, Rename, ReviewItem};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewState {
    #[default]
    Pending,
    Accepted,
    Rejected,
    Deferred,
}

impl ReviewState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Deferred => "deferred",
        }
    }
}

impl fmt::Display for ReviewState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Bumped only on a breaking change to the on-disk shape.
pub const REVIEW_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementReview {
    pub state: ReviewState,
    /// Hash of the text that was reviewed. Null while still pending.
    pub hash: Option<String>,
    pub reviewed_at: Option<String>,
    /// Why it was rejected — fed back to the agent as a revision instruction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Why it was deferred, e.g. `awaiting-deployment` (problem-analysis §8).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defer_reason: Option<String>,
}

impl Default for RequirementReview {
    fn default() -> Self {
        Self {
            state: ReviewState::Pending,
            hash: None,
            reviewed_at: None,
            note: None,
            defer_reason: None,
        }
    }
}

/// Extra context attached to a decision: why it was rejected, or deferred.
#[derive(Debug, Clone, Default)]
pub struct DecisionNote {
    pub note: Option<String>,
    pub defer_reason: Option<String>,
}

impl DecisionNote {
    pub fn note(reason: impl Into<String>) -> Self {
        Self {
            note: Some(reason.into()),
            defer_reason: None,
        }
    }

    pub fn defer_reason(reason: impl Into<String>) -> Self {
        Self {
            note: None,
            defer_reason: Some(reason.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeReview {
    pub change: String,
    pub schema_version: u32,
    /// Sorted, so a sidecar that is committed to git diffs by what changed
    /// rather than by map iteration order.
    pub requirements: BTreeMap<String, RequirementReview>,
    /// Where the last review session stopped, as a requirement id.
    ///
    /// An id rather than an index: an index silently points at a different
    /// requirement as soon as one is inserted above it, and resuming matters
    /// most exactly when the specs have been revised.
    ///
    /// The doubled `Option` keeps the sidecar byte-compatible with the
    /// TypeScript writer, which distinguishes an absent `cursor` (a review
    /// that was never walked) from an explicit `null` (one that was, and
    /// stopped nowhere).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Option<String>>,
}

impl ChangeReview {
    /// The stored cursor, flattened: absent and null both mean "nowhere".
    pub fn cursor_id(&self) -> Option<&str> {
        self.cursor.as_ref()?.as_deref()
    }

    pub fn with_cursor(mut self, id: Option<String>) -> Self {
        self.cursor = Some(id);
        self
    }
}

/// A review item joined with its state, as the UI consumes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewedItem {
    pub item: ReviewItem,
    pub state: ReviewState,
    pub review: RequirementReview,
    /// The text changed since it was reviewed. `state` is already forced back
    /// to `pending`; this flag is what lets the UI say *why* it went back.
    pub drifted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ReviewSummary {
    pub total: usize,
    pub accepted: usize,
    pub rejected: usize,
    pub deferred: usize,
    pub pending: usize,
    pub drifted: usize,
    /// Every requirement is accepted or deferred, and nothing has drifted.
    /// This — not file existence — is what gates the next stage.
    pub complete: bool,
}

pub fn empty_review(change: &str) -> ChangeReview {
    ChangeReview {
        change: change.to_owned(),
        schema_version: REVIEW_SCHEMA_VERSION,
        requirements: BTreeMap::new(),
        cursor: None,
    }
}

pub fn review_path(project_root: impl AsRef<Path>, change: &str) -> PathBuf {
    project_root
        .as_ref()
        .join(".spec-tacular")
        .join("review")
        .join(format!("{change}.json"))
}

/// Loads the sidecar. A missing, unreadable or malformed file yields an empty
/// review rather than failing: losing review state is annoying, but refusing
/// to open the project at all is worse, and the state rebuilds by re-reviewing.
pub fn load_review(project_root: impl AsRef<Path>, change: &str) -> ChangeReview {
    let Ok(raw) = fs::read_to_string(review_path(project_root, change)) else {
        return empty_review(change);
    };

    let Ok(parsed) = serde_json::from_str::<StoredReview>(&raw) else {
        return empty_review(change);
    };

    let Some(schema_version) = parsed.schema_version else {
        return empty_review(change);
    };
    if schema_version > REVIEW_SCHEMA_VERSION {
        // Written by a newer spec-tacular. Its extra fields would be silently
        // dropped on the next save, so it is left untouched and ignored.
        return empty_review(change);
    }

    // Per entry, not all-or-nothing. The sidecar is committed JSON that people
    // hand-edit; one entry with a typo in its `state` must not throw away every
    // other requirement's acceptance. A bad entry reads as pending, which is
    // the same thing a missing entry means.
    let requirements = parsed
        .requirements
        .unwrap_or_default()
        .into_iter()
        .map(|(id, raw)| {
            (
                id,
                serde_json::from_value::<RequirementReview>(raw).unwrap_or_default(),
            )
        })
        .collect();

    ChangeReview {
        change: change.to_owned(),
        schema_version,
        requirements,
        cursor: Some(parsed.cursor.flatten()),
    }
}

/// The on-disk shape as it is *read*: every field optional, because the file
/// may have been hand-edited and a missing key must degrade rather than throw.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredReview {
    schema_version: Option<u32>,
    /// Read as raw JSON so a single malformed entry can be isolated rather
    /// than failing the whole file — see [`load_review`].
    requirements: Option<BTreeMap<String, serde_json::Value>>,
    #[serde(default)]
    cursor: Option<Option<String>>,
}

/// Writes atomically, so an interrupted save cannot truncate the sidecar.
pub fn save_review(project_root: impl AsRef<Path>, review: &ChangeReview) -> io::Result<()> {
    let path = review_path(project_root, &review.change);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let body = serde_json::to_string_pretty(review).map_err(io::Error::other)?;
    fs::write(&tmp, format!("{body}\n"))?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Carries review state across an explicit rename.
///
/// OpenSpec's `RENAMED Requirements` delta states the rename outright, so it
/// need not be guessed from similarity: without this the old id looks deleted
/// and the new one unreviewed, silently discarding an acceptance.
pub fn apply_renames(review: ChangeReview, renames: &[Rename]) -> ChangeReview {
    if renames.is_empty() {
        return review;
    }

    let mut review = review;
    for rename in renames {
        let from_id = id_for(&rename.capability, &rename.from);
        let to_id = id_for(&rename.capability, &rename.to);
        // An existing entry at the destination wins: it was reviewed under the
        // new name, which is more recent than whatever the old name held.
        if review.requirements.contains_key(&to_id) {
            continue;
        }
        if let Some(carried) = review.requirements.remove(&from_id) {
            review.requirements.insert(to_id, carried);
        }
    }
    review
}

fn id_for(capability: &str, name: &str) -> String {
    format!("{capability}#{}", slugify(name))
}

/// Joins parsed requirements with stored state, resetting anything that drifted.
///
/// Note the direction: the Markdown is the source of truth and the sidecar is
/// an annotation on it. A requirement the parser no longer sees simply
/// disappears from the queue, and its stale entry is dropped on the next save.
pub fn reconcile(items: &[ReviewItem], review: &ChangeReview) -> Vec<ReviewedItem> {
    items
        .iter()
        .map(|item| {
            let stored = review
                .requirements
                .get(&item.id)
                .cloned()
                .unwrap_or_default();
            // A pending entry has no hash and cannot have drifted — only a
            // decision can be invalidated by an edit.
            let drifted = stored.state != ReviewState::Pending
                && stored.hash.as_deref().is_some_and(|h| h != item.hash);

            ReviewedItem {
                item: item.clone(),
                state: if drifted {
                    ReviewState::Pending
                } else {
                    stored.state
                },
                review: stored,
                drifted,
            }
        })
        .collect()
}

pub fn summarize(reviewed: &[ReviewedItem]) -> ReviewSummary {
    let count = |s: ReviewState| reviewed.iter().filter(|r| r.state == s).count();
    let accepted = count(ReviewState::Accepted);
    let deferred = count(ReviewState::Deferred);

    ReviewSummary {
        total: reviewed.len(),
        accepted,
        rejected: count(ReviewState::Rejected),
        deferred,
        pending: count(ReviewState::Pending),
        drifted: reviewed.iter().filter(|r| r.drifted).count(),
        // An empty queue is not complete: a specs artifact with no parseable
        // requirements is a problem to surface, not a stage to wave through.
        complete: !reviewed.is_empty() && accepted + deferred == reviewed.len(),
    }
}

/// Records a decision, stamping the hash of the exact text that was reviewed.
pub fn set_state(
    review: &ChangeReview,
    item: &ReviewItem,
    state: ReviewState,
    extra: &DecisionNote,
) -> ChangeReview {
    let pending = state == ReviewState::Pending;
    let entry = RequirementReview {
        state,
        hash: (!pending).then(|| item.hash.clone()),
        reviewed_at: (!pending).then(now_iso8601),
        // An empty reason is no reason: it is left out entirely rather than
        // written as `""`, which is what the TypeScript writer did and what
        // keeps a sidecar byte-identical across the two.
        note: extra.note.clone().filter(|n| !n.is_empty()),
        defer_reason: extra.defer_reason.clone().filter(|r| !r.is_empty()),
    };
    let mut next = review.clone();
    next.requirements.insert(item.id.clone(), entry);
    next
}

/// `2026-09-22T10:12:00.000Z` — the same shape JavaScript's `toISOString`
/// writes, so a sidecar moved between the two implementations reads the same.
fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::requirements::parse_spec_file;

    const SPEC: &str = "## ADDED Requirements\n\n\
         ### Requirement: Alpha\n\
         The system SHALL alpha.\n\n\
         ### Requirement: Beta\n\
         The system SHALL beta.\n";

    fn reqs(md: &str) -> Vec<ReviewItem> {
        parse_spec_file(md, "cap", "/p/specs/cap/spec.md").requirements
    }

    fn accept(review: &ChangeReview, item: &ReviewItem) -> ChangeReview {
        set_state(
            review,
            item,
            ReviewState::Accepted,
            &DecisionNote::default(),
        )
    }

    #[test]
    fn round_trips_through_the_sidecar() {
        let root = tempfile::tempdir().expect("a temp dir");
        let items = reqs(SPEC);
        let review = accept(&empty_review("c"), &items[0]);
        save_review(root.path(), &review).expect("the sidecar writes");

        let loaded = load_review(root.path(), "c");
        let alpha = loaded.requirements.get("cap#alpha").expect("alpha's entry");
        assert_eq!(alpha.state, ReviewState::Accepted);
        assert_eq!(alpha.hash.as_deref(), Some(items[0].hash.as_str()));
        assert_eq!(loaded.schema_version, REVIEW_SCHEMA_VERSION);
    }

    #[test]
    fn a_hand_edited_state_file_is_honoured() {
        // M2's exit criterion: the sidecar is plain JSON a human can edit.
        let root = tempfile::tempdir().expect("a temp dir");
        let path = review_path(root.path(), "c");
        fs::create_dir_all(path.parent().expect("a parent")).expect("the review dir");
        let items = reqs(SPEC);
        fs::write(
            &path,
            format!(
                r#"{{"change":"c","schemaVersion":1,"requirements":{{"cap#alpha":{{"state":"deferred","hash":"{}","reviewedAt":null,"deferReason":"awaiting-deployment"}}}}}}"#,
                items[0].hash
            ),
        )
        .expect("the sidecar writes");

        let reviewed = reconcile(&items, &load_review(root.path(), "c"));
        assert_eq!(reviewed[0].state, ReviewState::Deferred);
        assert_eq!(
            reviewed[0].review.defer_reason.as_deref(),
            Some("awaiting-deployment")
        );
    }

    #[test]
    fn one_unparseable_entry_does_not_discard_the_others() {
        // The sidecar is committed JSON people hand-edit. Throwing away every
        // acceptance because one entry has a typo in its state is a far worse
        // outcome than treating that one entry as unreviewed.
        let root = tempfile::tempdir().expect("a temp dir");
        let path = review_path(root.path(), "c");
        fs::create_dir_all(path.parent().expect("a parent")).expect("the review dir");
        let items = reqs(SPEC);
        fs::write(
            &path,
            format!(
                r#"{{"change":"c","schemaVersion":1,"requirements":{{"cap#alpha":{{"state":"accepted","hash":"{}"}},"cap#beta":{{"state":"maybe"}}}}}}"#,
                items[0].hash
            ),
        )
        .expect("the sidecar writes");

        let reviewed = reconcile(&items, &load_review(root.path(), "c"));
        assert_eq!(reviewed[0].state, ReviewState::Accepted);
        assert_eq!(reviewed[1].state, ReviewState::Pending);
    }

    #[test]
    fn an_empty_reason_is_left_out_rather_than_written_as_an_empty_string() {
        let items = reqs(SPEC);
        let review = set_state(
            &empty_review("c"),
            &items[0],
            ReviewState::Rejected,
            &DecisionNote::note(""),
        );
        assert!(review.requirements[&items[0].id].note.is_none());
        let json = serde_json::to_string(&review).expect("serialises");
        assert!(!json.contains("note"));
    }

    #[test]
    fn a_missing_file_is_an_empty_review_not_an_error() {
        let root = tempfile::tempdir().expect("a temp dir");
        assert!(load_review(root.path(), "nope").requirements.is_empty());
    }

    #[test]
    fn malformed_json_degrades_to_an_empty_review() {
        let root = tempfile::tempdir().expect("a temp dir");
        let path = review_path(root.path(), "c");
        fs::create_dir_all(path.parent().expect("a parent")).expect("the review dir");
        fs::write(&path, "{not json").expect("the sidecar writes");
        assert!(load_review(root.path(), "c").requirements.is_empty());
    }

    #[test]
    fn a_file_from_a_newer_spec_tacular_is_ignored_not_silently_rewritten() {
        let root = tempfile::tempdir().expect("a temp dir");
        let path = review_path(root.path(), "c");
        fs::create_dir_all(path.parent().expect("a parent")).expect("the review dir");
        fs::write(
            &path,
            format!(
                r#"{{"change":"c","schemaVersion":{},"requirements":{{"x":{{"state":"accepted","hash":null,"reviewedAt":null}}}}}}"#,
                REVIEW_SCHEMA_VERSION + 1
            ),
        )
        .expect("the sidecar writes");
        assert!(load_review(root.path(), "c").requirements.is_empty());
    }

    #[test]
    fn leaves_no_temp_file_behind() {
        let root = tempfile::tempdir().expect("a temp dir");
        save_review(root.path(), &empty_review("c")).expect("the sidecar writes");
        let path = review_path(root.path(), "c");
        let written = fs::read_to_string(&path).expect("the sidecar reads back");
        assert!(written.contains("\"change\""));

        let leftovers: Vec<_> = fs::read_dir(path.parent().expect("a parent"))
            .expect("the review dir lists")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn the_sidecar_is_written_in_the_shape_the_typescript_wrote() {
        let root = tempfile::tempdir().expect("a temp dir");
        save_review(root.path(), &empty_review("c")).expect("the sidecar writes");
        assert_eq!(
            fs::read_to_string(review_path(root.path(), "c")).expect("the sidecar reads back"),
            "{\n  \"change\": \"c\",\n  \"schemaVersion\": 1,\n  \"requirements\": {}\n}\n"
        );
    }

    #[test]
    fn an_edit_after_acceptance_resets_the_state_to_pending() {
        let items = reqs(SPEC);
        let review = accept(&empty_review("c"), &items[0]);

        let edited = reqs(&SPEC.replace("SHALL alpha.", "SHALL alpha differently."));
        let reviewed = reconcile(&edited, &review);

        assert_eq!(reviewed[0].state, ReviewState::Pending);
        assert!(reviewed[0].drifted);
        // The stored decision is preserved so the UI can say what it *was*.
        assert_eq!(reviewed[0].review.state, ReviewState::Accepted);
    }

    #[test]
    fn reformatting_does_not_count_as_drift() {
        let items = reqs(SPEC);
        let review = accept(&empty_review("c"), &items[0]);
        let reformatted =
            reqs(&SPEC.replace("The system SHALL alpha.", "The  system   SHALL alpha.\n"));
        let reviewed = reconcile(&reformatted, &review);
        assert_eq!(reviewed[0].state, ReviewState::Accepted);
        assert!(!reviewed[0].drifted);
    }

    #[test]
    fn a_pending_requirement_can_never_be_drifted() {
        let reviewed = reconcile(&reqs(SPEC), &empty_review("c"));
        assert_eq!(reviewed[0].state, ReviewState::Pending);
        assert!(!reviewed[0].drifted);
    }

    #[test]
    fn a_requirement_no_longer_in_the_markdown_drops_out_of_the_queue() {
        let items = reqs(SPEC);
        let review = accept(&empty_review("c"), &items[0]);
        let reduced =
            reqs("## ADDED Requirements\n\n### Requirement: Beta\nThe system SHALL beta.\n");
        let ids: Vec<_> = reconcile(&reduced, &review)
            .into_iter()
            .map(|r| r.item.id)
            .collect();
        assert_eq!(ids, vec!["cap#beta"]);
    }

    #[test]
    fn a_rename_carries_state_from_the_old_id_to_the_new_one() {
        let items = reqs(SPEC);
        let review = accept(&empty_review("c"), &items[0]);
        let migrated = apply_renames(
            review,
            &[Rename {
                from: "Alpha".to_owned(),
                to: "Alpha renamed".to_owned(),
                capability: "cap".to_owned(),
            }],
        );

        assert!(!migrated.requirements.contains_key("cap#alpha"));
        assert_eq!(
            migrated
                .requirements
                .get("cap#alpha-renamed")
                .map(|r| r.state),
            Some(ReviewState::Accepted)
        );
    }

    #[test]
    fn a_rename_does_not_overwrite_state_already_held_under_the_new_name() {
        let items = reqs(SPEC);
        let mut review = accept(&empty_review("c"), &items[0]);
        review = set_state(
            &review,
            &items[1],
            ReviewState::Rejected,
            &DecisionNote::default(),
        );
        let migrated = apply_renames(
            review,
            &[Rename {
                from: "Alpha".to_owned(),
                to: "Beta".to_owned(),
                capability: "cap".to_owned(),
            }],
        );
        assert_eq!(
            migrated.requirements.get("cap#beta").map(|r| r.state),
            Some(ReviewState::Rejected)
        );
    }

    #[test]
    fn no_renames_is_a_no_op() {
        let review = accept(&empty_review("c"), &reqs(SPEC)[0]);
        assert_eq!(apply_renames(review.clone(), &[]), review);
    }

    #[test]
    fn summarize_counts_each_state_and_reports_completeness() {
        let items = reqs(SPEC);
        let mut review = accept(&empty_review("c"), &items[0]);
        let summary = summarize(&reconcile(&items, &review));
        assert_eq!(summary.total, 2);
        assert_eq!(summary.accepted, 1);
        assert_eq!(summary.pending, 1);
        assert!(!summary.complete);

        review = set_state(
            &review,
            &items[1],
            ReviewState::Deferred,
            &DecisionNote::defer_reason("awaiting-deployment"),
        );
        // Deferred counts toward completeness — that is what lets a change
        // close with deployment-dependent work outstanding (§8).
        let summary = summarize(&reconcile(&items, &review));
        assert_eq!(summary.deferred, 1);
        assert_eq!(summary.pending, 0);
        assert!(summary.complete);
    }

    #[test]
    fn a_rejected_requirement_blocks_completeness() {
        let items = reqs(SPEC);
        let mut review = accept(&empty_review("c"), &items[0]);
        review = set_state(
            &review,
            &items[1],
            ReviewState::Rejected,
            &DecisionNote::note("too specific"),
        );
        assert!(!summarize(&reconcile(&items, &review)).complete);
    }

    #[test]
    fn drift_makes_a_complete_change_incomplete_again() {
        let items = reqs(SPEC);
        let mut review = accept(&empty_review("c"), &items[0]);
        review = accept(&review, &items[1]);
        assert!(summarize(&reconcile(&items, &review)).complete);

        let edited = reqs(&SPEC.replace("SHALL beta.", "SHALL beta more."));
        let after = summarize(&reconcile(&edited, &review));
        assert!(!after.complete);
        assert_eq!(after.drifted, 1);
    }

    #[test]
    fn an_empty_queue_is_not_complete() {
        // A specs artifact with no parseable requirements is a problem to
        // show, not a stage to wave through.
        let summary = summarize(&[]);
        assert_eq!(summary.total, 0);
        assert!(!summary.complete);
    }
}
