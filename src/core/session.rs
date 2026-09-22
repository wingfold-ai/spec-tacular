//! The review session: a cursor over a change's requirement queue, plus the
//! decisions made against it.
//!
//! Pure and I/O-free on purpose. The review loop is the product
//! (docs/problem-analysis.md §3), so its behaviour — what "next" means, what a
//! decision does to the cursor, where you land when you come back — is defined
//! here and tested without a terminal. The TUI only draws the current item.

use super::requirements::ReviewItem;
use super::review::{
    reconcile, set_state, summarize, ChangeReview, DecisionNote, ReviewState, ReviewSummary,
    ReviewedItem,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewSession {
    pub change: String,
    pub items: Vec<ReviewedItem>,
    /// Index into `items`. Always valid when `items` is non-empty.
    pub cursor: usize,
    pub review: ChangeReview,
    pub summary: ReviewSummary,
}

/// Position in the queue, 1-based, for display.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Position {
    pub index: usize,
    pub total: usize,
}

/// A state that means "this requirement still needs you".
fn is_open(item: &ReviewedItem) -> bool {
    matches!(item.state, ReviewState::Pending | ReviewState::Rejected)
}

fn build(change: &str, items: &[ReviewItem], review: ChangeReview, cursor: usize) -> ReviewSession {
    let reviewed = reconcile(items, &review);
    let summary = summarize(&reviewed);
    let cursor = if reviewed.is_empty() {
        0
    } else {
        cursor.min(reviewed.len() - 1)
    };
    ReviewSession {
        change: change.to_owned(),
        items: reviewed,
        cursor,
        review,
        summary,
    }
}

/// Opens a session, resuming where the last one stopped.
///
/// The stored cursor is a requirement id, not an index: an index would silently
/// point at a different requirement as soon as one is added or removed above it,
/// which is exactly when resuming matters most.
pub fn open_session(change: &str, items: &[ReviewItem], review: ChangeReview) -> ReviewSession {
    let reviewed = reconcile(items, &review);
    let stored = review
        .cursor_id()
        .and_then(|id| reviewed.iter().position(|i| i.item.id == id));
    // No stored position (or it points at a requirement that is gone): start at
    // the first thing that needs attention rather than at the top, so reopening
    // a mostly-reviewed change does not make you walk past the accepted ones.
    let start = stored.unwrap_or_else(|| reviewed.iter().position(is_open).unwrap_or(0));
    build(change, items, review, start)
}

pub fn current_item(session: &ReviewSession) -> Option<&ReviewedItem> {
    session.items.get(session.cursor)
}

/// Moves the cursor by `delta`, clamped. Never wraps — see [`move_to`].
pub fn move_by(session: ReviewSession, delta: isize) -> ReviewSession {
    if session.items.is_empty() {
        return session;
    }
    // Clamped rather than wrapping: `n` at the end of the queue jumping to the
    // start would lose your place in a list of forty requirements.
    let last = session.items.len() - 1;
    let next = session.cursor.saturating_add_signed(delta).min(last);
    with_cursor(session, next)
}

pub fn move_to(session: ReviewSession, index: usize) -> ReviewSession {
    if session.items.is_empty() {
        return session;
    }
    let last = session.items.len() - 1;
    with_cursor(session, index.min(last))
}

fn with_cursor(mut session: ReviewSession, cursor: usize) -> ReviewSession {
    let id = session.items.get(cursor).map(|i| i.item.id.clone());
    session.cursor = cursor;
    session.review = session.review.with_cursor(id);
    session
}

/// The next requirement still needing attention, searching forward and then
/// wrapping once.
///
/// Wrapping is right here but wrong for `n`/`p`: this answers "what else needs
/// me?", which has no spatial meaning, whereas `n` is a step through a list.
/// Returns the current index when nothing is open.
pub fn next_open_index(session: &ReviewSession, from: usize) -> usize {
    let n = session.items.len();
    for step in 1..=n {
        let i = (from + step) % n;
        if is_open(&session.items[i]) {
            return i;
        }
    }
    from
}

/// `s` — leave the decision for later and move on.
pub fn skip(session: ReviewSession) -> ReviewSession {
    if session.items.is_empty() {
        return session;
    }
    let next = next_open_index(&session, session.cursor);
    with_cursor(session, next)
}

/// Records a decision and advances to the next open requirement.
///
/// Returns the session unchanged when the queue is empty, so a caller need not
/// special-case it before every keystroke.
pub fn decide(session: ReviewSession, state: ReviewState, extra: &DecisionNote) -> ReviewSession {
    let Some(current) = current_item(&session) else {
        return session;
    };

    let review = set_state(&session.review, &current.item, state, extra);
    let items: Vec<ReviewItem> = session.items.iter().map(|i| i.item.clone()).collect();
    // Rebuilt at the old cursor first so `next_open_index` sees the decision
    // that was just made; otherwise accepting the last open item would loop
    // back to it.
    let updated = build(&session.change, &items, review, session.cursor);
    let next = next_open_index(&updated, updated.cursor);
    with_cursor(updated, next)
}

/// Re-reads the queue from freshly parsed Markdown, keeping your place.
pub fn refresh(session: ReviewSession, items: &[ReviewItem]) -> ReviewSession {
    let id = current_item(&session).map(|i| i.item.id.clone());
    let rebuilt = build(
        &session.change,
        items,
        session.review.clone(),
        session.cursor,
    );
    let at = id.and_then(|id| rebuilt.items.iter().position(|i| i.item.id == id));
    match at {
        Some(at) => with_cursor(rebuilt, at),
        None => rebuilt,
    }
}

pub fn position(session: &ReviewSession) -> Position {
    Position {
        index: if session.items.is_empty() {
            0
        } else {
            session.cursor + 1
        },
        total: session.items.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::requirements::parse_spec_file;
    use crate::core::review::{empty_review, set_state};
    use crate::core::revision::build_revision_bundle;

    const SPEC: &str = "## ADDED Requirements\n\n\
         ### Requirement: Alpha\n\
         SHALL alpha.\n\n\
         #### Scenario: A\n\
         - **WHEN** a\n\
         - **THEN** b\n\n\
         ### Requirement: Beta\n\
         SHALL beta.\n\n\
         ### Requirement: Gamma\n\
         SHALL gamma.\n";

    fn reqs(md: &str) -> Vec<ReviewItem> {
        parse_spec_file(md, "cap", "/p/specs/cap/spec.md").requirements
    }

    fn open_with(review: ChangeReview, md: &str) -> ReviewSession {
        open_session("c", &reqs(md), review)
    }

    fn open() -> ReviewSession {
        open_with(empty_review("c"), SPEC)
    }

    fn name(session: &ReviewSession) -> Option<&str> {
        current_item(session).map(|i| i.item.name.as_str())
    }

    fn accept(session: ReviewSession) -> ReviewSession {
        decide(session, ReviewState::Accepted, &DecisionNote::default())
    }

    #[test]
    fn a_fresh_session_starts_at_the_first_requirement() {
        let s = open();
        let names: Vec<_> = s.items.iter().map(|i| i.item.name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "Beta", "Gamma"]);
        assert_eq!(name(&s), Some("Alpha"));
        assert_eq!(position(&s), Position { index: 1, total: 3 });
    }

    #[test]
    fn resumes_at_the_stored_cursor() {
        let review = empty_review("c").with_cursor(Some("cap#gamma".to_owned()));
        assert_eq!(name(&open_with(review, SPEC)), Some("Gamma"));
    }

    #[test]
    fn with_no_cursor_starts_at_the_first_requirement_still_needing_attention() {
        // Reopening a mostly-reviewed change should not make you walk past the
        // accepted ones to reach the work.
        let items = reqs(SPEC);
        let mut review = set_state(
            &empty_review("c"),
            &items[0],
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        review = set_state(
            &review,
            &items[1],
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        assert_eq!(name(&open_with(review, SPEC)), Some("Gamma"));
    }

    #[test]
    fn a_stored_cursor_pointing_at_a_deleted_requirement_falls_back_safely() {
        let review = empty_review("c").with_cursor(Some("cap#deleted".to_owned()));
        assert_eq!(name(&open_with(review, SPEC)), Some("Alpha"));
    }

    #[test]
    fn an_empty_queue_yields_no_current_item_and_does_not_panic() {
        let s = open_with(empty_review("c"), "# Spec Delta\n");
        assert!(current_item(&s).is_none());
        assert_eq!(position(&s), Position { index: 0, total: 0 });
        assert_eq!(accept(s.clone()), s);
        assert_eq!(skip(s.clone()), s);
        assert_eq!(move_by(s.clone(), 1), s);
    }

    #[test]
    fn navigation_moves_one_step_and_clamps_at_the_ends() {
        let mut s = open();
        s = move_by(s, 1);
        assert_eq!(name(&s), Some("Beta"));
        s = move_by(s, -1);
        assert_eq!(name(&s), Some("Alpha"));
        // Clamped, not wrapped: wrapping loses your place in a long queue.
        s = move_by(s, -1);
        assert_eq!(name(&s), Some("Alpha"));
        s = move_by(s, 99);
        assert_eq!(name(&s), Some("Gamma"));
    }

    #[test]
    fn moving_records_the_cursor_so_the_position_survives_a_restart() {
        let s = move_by(open(), 2);
        assert_eq!(s.review.cursor_id(), Some("cap#gamma"));
        assert_eq!(name(&open_with(s.review, SPEC)), Some("Gamma"));
    }

    #[test]
    fn move_to_clamps_to_the_end_of_the_queue() {
        assert_eq!(name(&move_to(open(), 99)), Some("Gamma"));
    }

    #[test]
    fn accepting_records_the_state_and_advances_to_the_next_open_item() {
        let s = accept(open());
        assert_eq!(s.items[0].state, ReviewState::Accepted);
        assert_eq!(name(&s), Some("Beta"));
        assert_eq!(s.summary.accepted, 1);
    }

    #[test]
    fn a_rejection_carries_its_reason() {
        let s = decide(
            open(),
            ReviewState::Rejected,
            &DecisionNote::note("names an endpoint"),
        );
        assert_eq!(s.items[0].state, ReviewState::Rejected);
        assert_eq!(s.items[0].review.note.as_deref(), Some("names an endpoint"));
    }

    #[test]
    fn a_deferral_carries_its_reason_and_counts_toward_completeness() {
        let mut s = open();
        s = decide(
            s,
            ReviewState::Deferred,
            &DecisionNote::defer_reason("awaiting-deployment"),
        );
        s = accept(s);
        s = accept(s);
        assert_eq!(s.summary.deferred, 1);
        assert_eq!(s.summary.accepted, 2);
        assert!(s.summary.complete);
    }

    #[test]
    fn deciding_the_last_open_item_wraps_to_the_first_still_open_one() {
        // "Next" here means "what else needs me", which has no spatial
        // meaning — unlike n/p, which must not wrap.
        let mut s = open();
        s = move_by(s, 2); // at Gamma
        s = accept(s); // Gamma done; Alpha and Beta still open
        assert_eq!(name(&s), Some("Alpha"));
    }

    #[test]
    fn accepting_the_final_open_item_leaves_the_cursor_put() {
        let mut s = open();
        s = accept(s);
        s = accept(s);
        s = accept(s);
        assert!(s.summary.complete);
        assert_eq!(name(&s), Some("Gamma"));
    }

    #[test]
    fn a_rejected_requirement_is_still_open_so_review_returns_to_it() {
        let mut s = open();
        s = decide(
            s,
            ReviewState::Rejected,
            &DecisionNote::note("too specific"),
        );
        assert_eq!(name(&s), Some("Beta"));
        s = accept(s);
        s = accept(s);
        // Alpha was rejected, so it is the only thing left needing attention.
        assert_eq!(name(&s), Some("Alpha"));
    }

    #[test]
    fn skipping_advances_without_recording_a_decision() {
        let s = skip(open());
        assert_eq!(s.items[0].state, ReviewState::Pending);
        assert_eq!(name(&s), Some("Beta"));
    }

    #[test]
    fn refresh_keeps_your_place_when_the_requirement_still_exists() {
        let mut s = move_by(open(), 1);
        s = refresh(
            s,
            &reqs(&SPEC.replace("SHALL gamma.", "SHALL gamma differently.")),
        );
        assert_eq!(name(&s), Some("Beta"));
    }

    #[test]
    fn refresh_surfaces_drift_on_a_requirement_edited_after_acceptance() {
        let mut s = accept(open());
        s = refresh(
            s,
            &reqs(&SPEC.replace("SHALL alpha.", "SHALL alpha otherwise.")),
        );
        assert!(s.items[0].drifted);
        assert_eq!(s.items[0].state, ReviewState::Pending);
    }

    #[test]
    fn refresh_clamps_the_cursor_when_requirements_disappear() {
        let mut s = move_by(open(), 2);
        s = refresh(
            s,
            &reqs("## ADDED Requirements\n\n### Requirement: Alpha\nSHALL alpha.\n"),
        );
        assert_eq!(position(&s), Position { index: 1, total: 1 });
    }

    #[test]
    fn a_revision_bundle_lists_only_the_rejected_requirements_with_reasons() {
        let mut s = open();
        s = decide(
            s,
            ReviewState::Rejected,
            &DecisionNote::note("names an endpoint that is not decided"),
        );
        s = accept(s);

        let bundle = build_revision_bundle("c", &s.items);
        let names: Vec<_> = bundle
            .rejected
            .iter()
            .map(|r| r.item.name.as_str())
            .collect();
        assert_eq!(names, vec!["Alpha"]);
        assert!(bundle.instruction.contains("Requirement: Alpha"));
        assert!(bundle
            .instruction
            .contains("names an endpoint that is not decided"));
        // The accepted one must not be offered up for rewriting.
        assert!(!bundle.instruction.contains("Requirement: Beta"));
        assert!(bundle
            .instruction
            .contains("leave them byte-for-byte unchanged"));
    }

    #[test]
    fn a_revision_bundle_says_so_plainly_when_nothing_was_rejected() {
        let bundle = build_revision_bundle("c", &open().items);
        assert!(bundle.rejected.is_empty());
        assert!(bundle.instruction.contains("Nothing to revise"));
    }

    #[test]
    fn a_revision_bundle_handles_a_rejection_with_no_reason_given() {
        let s = decide(open(), ReviewState::Rejected, &DecisionNote::default());
        assert!(build_revision_bundle("c", &s.items)
            .instruction
            .contains("(none given)"));
    }
}
