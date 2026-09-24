//! Turns rejections into a revision instruction for the agent.
//!
//! Rejecting a requirement has to *do* something, or the review loop is just
//! bookkeeping. The bundle collects every rejection with its reason so the
//! agent rewrites exactly those requirements and leaves the accepted ones
//! alone — which is the whole point of reviewing them individually
//! (docs/problem-analysis.md §3).

use std::collections::BTreeMap;

use super::review::{ReviewState, ReviewedItem};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionBundle {
    pub change: String,
    pub rejected: Vec<ReviewedItem>,
    /// Markdown instruction to hand to the agent.
    pub instruction: String,
}

pub fn build_revision_bundle(change: &str, items: &[ReviewedItem]) -> RevisionBundle {
    let rejected: Vec<ReviewedItem> = items
        .iter()
        .filter(|i| i.state == ReviewState::Rejected)
        .cloned()
        .collect();
    let instruction = render_instruction(change, &rejected);
    RevisionBundle {
        change: change.to_owned(),
        rejected,
        instruction,
    }
}

fn render_instruction(change: &str, rejected: &[ReviewedItem]) -> String {
    if rejected.is_empty() {
        return format!("No requirements were rejected in {change}. Nothing to revise.");
    }

    let plural = if rejected.len() == 1 {
        " was"
    } else {
        "s were"
    };
    let mut lines: Vec<String> = vec![
        format!("# Revision request: {change}"),
        String::new(),
        format!("{} requirement{plural} rejected in review.", rejected.len()),
        "Revise ONLY these. Every other requirement in this change has been".to_owned(),
        "accepted by a human — leave them byte-for-byte unchanged.".to_owned(),
        String::new(),
    ];

    // Grouped by capability so the agent opens each spec file once, and so a
    // reviewer reading this back can see whether one file attracted every
    // rejection. A `BTreeMap` both groups and orders: TypeScript grouped by
    // insertion and sorted afterwards, which comes to the same list.
    let mut by_capability: BTreeMap<&str, Vec<&ReviewedItem>> = BTreeMap::new();
    for item in rejected {
        by_capability
            .entry(item.item.capability.as_str())
            .or_default()
            .push(item);
    }

    for (capability, items) in by_capability {
        lines.push(format!("## {capability}"));
        lines.push(String::new());
        // Every requirement in one capability comes from one spec file, so the
        // first item's path names the file for the whole group.
        if let Some(first) = items.first() {
            lines.push(format!("File: `{}`", first.item.file));
            lines.push(String::new());
        }
        for item in items {
            lines.push(format!("### Requirement: {}", item.item.name));
            lines.push(String::new());
            let reason = item
                .review
                .note
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty());
            lines.push(match reason {
                Some(note) => format!("**Reason for rejection:** {note}"),
                None => "**Reason for rejection:** (none given)".to_owned(),
            });
            lines.push(String::new());
        }
    }

    lines.extend(
        [
            "## Rules",
            "",
            "- Keep each requirement a behaviour contract: what is observable, not how",
            "  it is built.",
            "- Mark any concrete value that is illustrative rather than decided as",
            "  `{{example: ...}}`. Unmarked concrete values read as binding contracts.",
            "- Every requirement keeps at least one `#### Scenario:` with WHEN/THEN.",
            "- Do not rename a requirement unless the reason asks for it. A rename",
            "  discards its review history.",
            "",
        ]
        .into_iter()
        .map(str::to_owned),
    );

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::requirements::parse_spec_file;
    use crate::core::review::{empty_review, reconcile, set_state, DecisionNote};

    fn queue() -> Vec<ReviewedItem> {
        let parsed = parse_spec_file(
            "## ADDED Requirements

### Requirement: Export
The system SHALL export.

#### Scenario: Works
- **WHEN** asked
- **THEN** exports

### Requirement: Import
The system SHALL import.

#### Scenario: Works
- **WHEN** asked
- **THEN** imports
",
            "cap",
            "/p/openspec/changes/c/specs/cap/spec.md",
        );

        let mut review = empty_review("c");
        review = set_state(
            &review,
            &parsed.requirements[0],
            ReviewState::Rejected,
            &DecisionNote::note("  too vague  "),
        );
        review = set_state(
            &review,
            &parsed.requirements[1],
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        reconcile(&parsed.requirements, &review)
    }

    #[test]
    fn collects_only_the_rejected() {
        let bundle = build_revision_bundle("c", &queue());
        assert_eq!(bundle.rejected.len(), 1);
        assert_eq!(bundle.rejected[0].item.name, "Export");
        assert_eq!(bundle.change, "c");
    }

    #[test]
    fn the_instruction_names_the_requirement_its_file_and_the_reason() {
        let instruction = build_revision_bundle("c", &queue()).instruction;
        assert!(instruction.contains("# Revision request: c"));
        assert!(instruction.contains("1 requirement was rejected in review."));
        assert!(instruction.contains("## cap"));
        assert!(instruction.contains("File: `/p/openspec/changes/c/specs/cap/spec.md`"));
        assert!(instruction.contains("### Requirement: Export"));
        assert!(instruction.contains("**Reason for rejection:** too vague"));
        // The accepted one must not be mentioned; naming it invites a rewrite.
        assert!(!instruction.contains("Import"));
    }

    #[test]
    fn a_rejection_with_no_note_still_appears() {
        let parsed = parse_spec_file(
            "## ADDED Requirements\n\n### Requirement: A\nSHALL a.\n",
            "cap",
            "f.md",
        );
        let review = set_state(
            &empty_review("c"),
            &parsed.requirements[0],
            ReviewState::Rejected,
            &DecisionNote::default(),
        );
        let bundle = build_revision_bundle("c", &reconcile(&parsed.requirements, &review));
        assert!(bundle
            .instruction
            .contains("**Reason for rejection:** (none given)"));
    }

    #[test]
    fn nothing_rejected_says_so_rather_than_emitting_an_empty_request() {
        let parsed = parse_spec_file(
            "## ADDED Requirements\n\n### Requirement: A\nSHALL a.\n",
            "cap",
            "f.md",
        );
        let bundle =
            build_revision_bundle("c", &reconcile(&parsed.requirements, &empty_review("c")));
        assert!(bundle.rejected.is_empty());
        assert_eq!(
            bundle.instruction,
            "No requirements were rejected in c. Nothing to revise."
        );
    }

    #[test]
    fn plural_when_more_than_one_is_rejected() {
        let parsed = parse_spec_file(
            "## ADDED Requirements\n\n### Requirement: A\nSHALL a.\n\n### Requirement: B\nSHALL b.\n",
            "cap",
            "f.md",
        );
        let mut review = empty_review("c");
        for requirement in &parsed.requirements {
            review = set_state(
                &review,
                requirement,
                ReviewState::Rejected,
                &DecisionNote::default(),
            );
        }
        let bundle = build_revision_bundle("c", &reconcile(&parsed.requirements, &review));
        assert!(bundle
            .instruction
            .contains("2 requirements were rejected in review."));
    }

    #[test]
    fn capabilities_are_grouped_and_ordered() {
        let mut items: Vec<ReviewedItem> = Vec::new();
        let mut review = empty_review("c");
        for capability in ["zeta", "alpha"] {
            let parsed = parse_spec_file(
                "## ADDED Requirements\n\n### Requirement: R\nSHALL r.\n",
                capability,
                &format!("/p/specs/{capability}/spec.md"),
            );
            review = set_state(
                &review,
                &parsed.requirements[0],
                ReviewState::Rejected,
                &DecisionNote::default(),
            );
            items.extend(reconcile(&parsed.requirements, &review));
        }
        let instruction = build_revision_bundle("c", &items).instruction;
        let alpha = instruction.find("## alpha").expect("alpha section");
        let zeta = instruction.find("## zeta").expect("zeta section");
        assert!(alpha < zeta);
    }

    #[test]
    fn the_rules_block_is_always_present_when_something_was_rejected() {
        let instruction = build_revision_bundle("c", &queue()).instruction;
        assert!(instruction.contains("## Rules"));
        assert!(instruction.contains("`{{example: ...}}`"));
        assert!(instruction.contains("#### Scenario:"));
    }
}
