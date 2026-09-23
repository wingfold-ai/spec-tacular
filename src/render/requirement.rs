//! Renders one requirement for review.
//!
//! One requirement, full width, nothing else competing for attention. The
//! failure mode being fixed is a wall of requirements; recreating that wall in
//! a TUI would fix nothing (docs/tui-design.md).
//!
//! Shared by the TUI and by `--print`, so the two can never disagree about what
//! a requirement looks like.

use crate::core::review::{ReviewState, ReviewSummary, ReviewedItem};

/// How the requirement sits in the queue it is being shown from.
#[derive(Debug, Clone, Copy)]
pub struct RequirementView {
    /// 1-based position in the queue.
    pub index: usize,
    pub total: usize,
    pub summary: ReviewSummary,
    /// Terminal width to wrap prose at.
    pub width: usize,
}

pub const DEFAULT_WIDTH: usize = 76;

impl RequirementView {
    pub fn new(index: usize, total: usize, summary: ReviewSummary) -> Self {
        Self {
            index,
            total,
            summary,
            width: DEFAULT_WIDTH,
        }
    }

    pub fn with_width(mut self, width: usize) -> Self {
        self.width = width;
        self
    }
}

/// Greedy word wrap. Long unbreakable tokens (URLs, paths) overflow rather than
/// split.
///
/// Width is counted in characters, not bytes: a spec written in any language
/// has to wrap where a reader would expect it to.
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for paragraph in text.split('\n') {
        if paragraph.trim().is_empty() {
            out.push(String::new());
            continue;
        }
        let mut line = String::new();
        let mut line_width = 0usize;
        for word in paragraph.split_whitespace() {
            let word_width = word.chars().count();
            if line.is_empty() {
                line.push_str(word);
                line_width = word_width;
            } else if line_width + 1 + word_width <= width {
                line.push(' ');
                line.push_str(word);
                line_width += 1 + word_width;
            } else {
                out.push(std::mem::take(&mut line));
                line.push_str(word);
                line_width = word_width;
            }
        }
        if !line.is_empty() {
            out.push(line);
        }
    }
    out
}

pub const PROGRESS_BAR_WIDTH: usize = 28;

pub fn render_progress_bar(summary: &ReviewSummary, width: usize) -> String {
    if summary.total == 0 {
        return String::new();
    }
    // Each segment is floored, then `pending` absorbs the remainder, so the bar
    // is always exactly `width` wide and never over-reports progress.
    let seg = |n: usize| n * width / summary.total;
    let accepted = seg(summary.accepted);
    let deferred = seg(summary.deferred);
    let rejected = seg(summary.rejected);
    let rest = width.saturating_sub(accepted + deferred + rejected);

    let mut bar = String::with_capacity(width * 3);
    bar.extend(std::iter::repeat_n('█', accepted));
    bar.extend(std::iter::repeat_n('▒', deferred));
    bar.extend(std::iter::repeat_n('▓', rejected));
    bar.extend(std::iter::repeat_n('░', rest));
    bar
}

pub fn render_counts(summary: &ReviewSummary) -> String {
    let mut bits = vec![format!("{} accepted", summary.accepted)];
    if summary.rejected > 0 {
        bits.push(format!("{} rejected", summary.rejected));
    }
    if summary.deferred > 0 {
        bits.push(format!("{} deferred", summary.deferred));
    }
    bits.push(format!("{} pending", summary.pending));
    bits.join(" · ")
}

/// What to call the thing on screen.
///
/// A ground rule and a design decision are both reviewed as bare items, but
/// telling a reviewer they are looking at a "requirement" when they are looking
/// at a Foundation answer is how a tool loses their trust.
pub fn noun(item: &ReviewedItem) -> &'static str {
    if item.item.is_requirement() {
        "requirement"
    } else if item.item.capability.starts_with("foundation/") {
        "ground rule"
    } else {
        "decision"
    }
}

pub fn render_requirement(item: &ReviewedItem, view: &RequirementView) -> String {
    let r = &item.item;
    let noun = noun(item);
    let mut out: Vec<String> = Vec::new();

    let operation = match r.operation() {
        Some(operation) => format!("   [{operation}]"),
        None => String::new(),
    };
    out.push(format!(
        "{}   {noun} {} of {}{operation}",
        r.capability, view.index, view.total
    ));
    out.push(String::new());

    let mut capitalised = noun.to_owned();
    capitalised[..1].make_ascii_uppercase();
    out.push(format!("{capitalised}: {}", r.name));
    out.push(String::new());
    out.extend(wrap(&r.text, view.width));
    out.push(String::new());

    let scenarios = r.scenarios();
    for scenario in scenarios {
        out.push(format!("  Scenario: {}", scenario.name));
        for line in &scenario.body {
            out.push(format!("    {line}"));
        }
        out.push(String::new());
    }
    if r.is_requirement() && scenarios.is_empty() {
        // Worth saying out loud: OpenSpec requires at least one scenario, so
        // none is a defect in the spec, not merely an empty section. A decision
        // has none by nature, so the warning is scoped to requirements.
        out.push("  (no scenarios — every requirement must have at least one)".to_owned());
        out.push(String::new());
    }

    if item.drifted {
        out.push(format!(
            "  ! changed since you marked it {} — review it again",
            item.review.state
        ));
        out.push(String::new());
    } else if item.state != ReviewState::Pending {
        let note = match item.review.note.as_deref() {
            Some(note) => format!(" — {note}"),
            None => String::new(),
        };
        out.push(format!("  state: {}{note}", item.state));
        out.push(String::new());
    }

    out.push(format!(
        "{}  {}",
        render_progress_bar(&view.summary, PROGRESS_BAR_WIDTH),
        render_counts(&view.summary)
    ));
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::requirements::parse_spec_file;
    use crate::core::review::{
        empty_review, reconcile, set_state, summarize, DecisionNote, ReviewState,
    };

    const SPEC: &str = "## ADDED Requirements

### Requirement: Theme selection
The system SHALL let a user choose a theme, and SHALL remember the choice for
the next session so nobody has to set it twice.

#### Scenario: Chooses dark
- **WHEN** the user picks dark
- **THEN** the theme is dark
";

    fn one() -> (ReviewedItem, ReviewSummary) {
        let parsed = parse_spec_file(SPEC, "ui/theme", "/p/specs/ui/theme/spec.md");
        let reviewed = reconcile(&parsed.requirements, &empty_review("c"));
        let summary = summarize(&reviewed);
        (
            reviewed.into_iter().next().expect("one requirement"),
            summary,
        )
    }

    // ---- wrap --------------------------------------------------------------

    #[test]
    fn wraps_at_the_given_width() {
        let lines = wrap("one two three four five six", 9);
        assert_eq!(lines, ["one two", "three", "four five", "six"]);
        assert!(lines.iter().all(|l| l.chars().count() <= 9));
    }

    #[test]
    fn an_unbreakable_token_overflows_rather_than_splitting() {
        // A URL cut in half is a URL nobody can copy.
        assert_eq!(
            wrap("see https://example.com/a/very/long/path now", 10),
            ["see", "https://example.com/a/very/long/path", "now"]
        );
    }

    #[test]
    fn blank_lines_are_kept_so_paragraphs_survive() {
        assert_eq!(wrap("a\n\nb", 10), ["a", "", "b"]);
    }

    #[test]
    fn empty_text_wraps_to_one_blank_line() {
        assert_eq!(wrap("", 10), [""]);
    }

    // ---- the bar and the counts -------------------------------------------

    #[test]
    fn the_bar_is_always_exactly_as_wide_as_asked() {
        let summary = ReviewSummary {
            total: 3,
            accepted: 1,
            rejected: 1,
            deferred: 0,
            pending: 1,
            drifted: 0,
            complete: false,
        };
        assert_eq!(render_progress_bar(&summary, 10).chars().count(), 10);
    }

    #[test]
    fn the_bar_never_over_reports_progress() {
        // Two of three accepted floors to 6 of 10, not 7: rounding up would
        // show a review as further along than it is.
        let summary = ReviewSummary {
            total: 3,
            accepted: 2,
            rejected: 0,
            deferred: 0,
            pending: 1,
            drifted: 0,
            complete: false,
        };
        let bar = render_progress_bar(&summary, 10);
        assert_eq!(bar.chars().filter(|c| *c == '█').count(), 6);
        assert_eq!(bar.chars().filter(|c| *c == '░').count(), 4);
    }

    #[test]
    fn an_empty_queue_has_no_bar() {
        assert_eq!(render_progress_bar(&ReviewSummary::default(), 28), "");
    }

    #[test]
    fn counts_omit_the_categories_that_are_empty() {
        let summary = ReviewSummary {
            total: 4,
            accepted: 3,
            rejected: 0,
            deferred: 0,
            pending: 1,
            drifted: 0,
            complete: false,
        };
        assert_eq!(render_counts(&summary), "3 accepted · 1 pending");
    }

    #[test]
    fn counts_name_rejections_and_deferrals_when_there_are_any() {
        let summary = ReviewSummary {
            total: 4,
            accepted: 1,
            rejected: 1,
            deferred: 1,
            pending: 1,
            drifted: 0,
            complete: false,
        };
        assert_eq!(
            render_counts(&summary),
            "1 accepted · 1 rejected · 1 deferred · 1 pending"
        );
    }

    // ---- the requirement view ---------------------------------------------

    #[test]
    fn shows_the_capability_position_operation_and_scenarios() {
        let (item, summary) = one();
        let out = render_requirement(&item, &RequirementView::new(1, 3, summary));
        assert!(out.starts_with("ui/theme   requirement 1 of 3   [ADDED]"));
        assert!(out.contains("Requirement: Theme selection"));
        assert!(out.contains("  Scenario: Chooses dark"));
        assert!(out.contains("    - **WHEN** the user picks dark"));
        assert!(out.contains("0 accepted · 1 pending"));
    }

    #[test]
    fn prose_is_wrapped_to_the_requested_width() {
        let (item, summary) = one();
        let out = render_requirement(&item, &RequirementView::new(1, 1, summary).with_width(30));
        assert!(out
            .lines()
            .filter(|l| l.starts_with("The system"))
            .all(|l| l.chars().count() <= 30));
    }

    #[test]
    fn a_requirement_with_no_scenarios_says_so() {
        // OpenSpec requires at least one, so none is a defect in the spec.
        let parsed = parse_spec_file(
            "## ADDED Requirements\n\n### Requirement: Bare\nSHALL do a thing.\n",
            "cap",
            "f.md",
        );
        let reviewed = reconcile(&parsed.requirements, &empty_review("c"));
        let summary = summarize(&reviewed);
        let out = render_requirement(&reviewed[0], &RequirementView::new(1, 1, summary));
        assert!(out.contains("(no scenarios — every requirement must have at least one)"));
    }

    #[test]
    fn a_decided_requirement_shows_its_state_and_note() {
        let parsed = parse_spec_file(
            "## ADDED Requirements\n\n### Requirement: Bare\nSHALL do a thing.\n",
            "cap",
            "f.md",
        );
        let review = set_state(
            &empty_review("c"),
            &parsed.requirements[0],
            ReviewState::Rejected,
            &DecisionNote::note("too vague"),
        );
        let reviewed = reconcile(&parsed.requirements, &review);
        let summary = summarize(&reviewed);
        let out = render_requirement(&reviewed[0], &RequirementView::new(1, 1, summary));
        assert!(out.contains("  state: rejected — too vague"));
    }

    #[test]
    fn drift_is_called_out_in_place_of_the_state() {
        // The state has already been forced back to pending; the reviewer
        // needs to know why it moved.
        let parsed = parse_spec_file(
            "## ADDED Requirements\n\n### Requirement: Bare\nSHALL do a thing.\n",
            "cap",
            "f.md",
        );
        let mut review = set_state(
            &empty_review("c"),
            &parsed.requirements[0],
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        if let Some(entry) = review.requirements.get_mut(&parsed.requirements[0].id) {
            entry.hash = Some("sha256:stale".to_owned());
        }
        let reviewed = reconcile(&parsed.requirements, &review);
        let summary = summarize(&reviewed);
        let out = render_requirement(&reviewed[0], &RequirementView::new(1, 1, summary));
        assert!(out.contains("! changed since you marked it accepted — review it again"));
        assert!(!out.contains("state: accepted"));
    }

    #[test]
    fn a_decision_is_called_a_decision_and_a_ground_rule_a_ground_rule() {
        use crate::core::decisions::parse_decisions;

        let decision = parse_decisions("## Decisions\n\n### Use results\nBecause.\n", "d.md")
            .remove(0)
            .item;
        let reviewed = reconcile(std::slice::from_ref(&decision), &empty_review("c"));
        let summary = summarize(&reviewed);
        let out = render_requirement(&reviewed[0], &RequirementView::new(1, 1, summary));
        assert!(out.contains("decision 1 of 1"));
        assert!(out.contains("Decision: Use results"));
        // No operation tag: a decision has no delta.
        assert!(!out.contains('['));

        let mut rule = decision;
        rule.capability = "foundation/stack".to_owned();
        let reviewed = reconcile(&[rule], &empty_review("c"));
        let summary = summarize(&reviewed);
        let out = render_requirement(&reviewed[0], &RequirementView::new(1, 1, summary));
        assert!(out.contains("ground rule 1 of 1"));
        assert!(out.contains("Ground rule: Use results"));
    }
}
