//! The context bundle handed to an agent with every call.
//!
//! Two jobs. It carries the project's ground rules, so generated specs and
//! designs are constrained by decisions already made rather than re-deciding
//! them per change (docs/problem-analysis.md §6, §9). And it states which
//! requirements a human has actually accepted, so an agent writing a design
//! knows what is settled and what is not.
//!
//! Foundation documents and ADRs are read if present and skipped if not, so
//! this works the moment those files exist rather than needing to be revisited.

use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use super::decisions::accepted_adrs;
use super::review::{ReviewState, ReviewedItem};

/// One document carried into the prompt: its heading, and its text verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextDoc {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContextBundle {
    /// What the project is for, in the developer's words — greenfield only.
    pub vision: String,
    /// Ground rules: stack, architecture, conventions.
    pub foundation: Vec<ContextDoc>,
    /// Accepted architectural decision records.
    pub decisions: Vec<ContextDoc>,
    pub accepted: Vec<ReviewedItem>,
    pub deferred: Vec<ReviewedItem>,
    /// What could not be included, so the prompt can say so rather than imply
    /// completeness.
    pub missing: Vec<String>,
}

impl ContextBundle {
    /// Nothing to say: [`render_context`] renders the empty string, and
    /// [`build_prompt`] then hands the instructions through untouched.
    fn is_empty(&self) -> bool {
        self.vision.is_empty()
            && self.foundation.is_empty()
            && self.decisions.is_empty()
            && self.accepted.is_empty()
            && self.deferred.is_empty()
            && self.missing.is_empty()
    }
}

fn read_markdown_dir(dir: &Path) -> Vec<ContextDoc> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| Some(entry.ok()?.file_name().to_string_lossy().into_owned()))
        .collect();
    names.sort();

    let mut out = Vec::new();
    for name in names {
        let path = dir.join(&name);
        if !name.ends_with(".md") || path.is_dir() {
            continue;
        }
        // An unreadable file: better to proceed with less context than to fail
        // the job.
        if let Ok(content) = fs::read_to_string(&path) {
            out.push(ContextDoc { name, content });
        }
    }
    out
}

pub fn build_context(project_root: impl AsRef<Path>, reviewed: &[ReviewedItem]) -> ContextBundle {
    let project_root = project_root.as_ref();
    let foundation = read_markdown_dir(&project_root.join("spec-tacular").join("foundation"));

    // Only accepted ADRs are binding. A superseded one is history, and feeding
    // it to an agent as a rule would resurrect a decision the project reversed.
    let decisions: Vec<ContextDoc> = accepted_adrs(project_root)
        .into_iter()
        .map(|adr| ContextDoc {
            name: format!("ADR-{:04}: {}", adr.number, adr.title),
            content: adr.content,
        })
        .collect();

    // No vision: a project that did not start from one. Nothing is missing.
    let vision = fs::read_to_string(project_root.join("spec-tacular").join("vision.md"))
        .map(|text| text.trim().to_owned())
        .unwrap_or_default();

    let mut missing: Vec<String> = Vec::new();
    if foundation.is_empty() {
        missing.push("no foundation documents yet".to_owned());
    }
    if decisions.is_empty() {
        missing.push("no architectural decision records yet".to_owned());
    }

    ContextBundle {
        vision,
        foundation,
        decisions,
        accepted: reviewed
            .iter()
            .filter(|r| r.state == ReviewState::Accepted)
            .cloned()
            .collect(),
        deferred: reviewed
            .iter()
            .filter(|r| r.state == ReviewState::Deferred)
            .cloned()
            .collect(),
        missing,
    }
}

static LEADING_HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#[^\n]*\n+").expect("built-in pattern"));

/// Renders the bundle as the prompt preamble.
///
/// Accepted requirements are listed by name, not in full: the agent can read
/// the spec files, and pasting them wholesale would crowd out the instructions
/// that follow. What matters is which ones are settled.
pub fn render_context(bundle: &ContextBundle) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut push = |line: &str| out.push(line.to_owned());

    if !bundle.vision.is_empty() {
        push("# Product vision");
        push("");
        push("What the developer is building, in their words. Every change serves it.");
        push("");
        push(&LEADING_HEADING.replacen(&bundle.vision, 1, ""));
        push("");
    }

    if !bundle.foundation.is_empty() {
        push("# Project ground rules");
        push("");
        push("These are settled. Conform to them, or say explicitly why you cannot.");
        push("");
        for doc in &bundle.foundation {
            push(&format!("## {}", doc.name));
            push("");
            push(doc.content.trim());
            push("");
        }
    }

    if !bundle.decisions.is_empty() {
        push("# Accepted architectural decisions");
        push("");
        push("Follow these. To depart from one, propose superseding it by number and");
        push("say why — never diverge silently.");
        push("");
        for doc in &bundle.decisions {
            push(&format!("## {}", doc.name));
            push("");
            push(doc.content.trim());
            push("");
        }
    }

    if !bundle.accepted.is_empty() {
        push("# Requirements a human has accepted");
        push("");
        push("These were reviewed and agreed one by one. Treat them as fixed input.");
        push("If one turns out to be wrong or ambiguous, stop and say so — do not");
        push("edit it and do not design around it.");
        push("");
        for item in &bundle.accepted {
            push(&format!("- {}: {}", item.item.capability, item.item.name));
        }
        push("");
    }

    if !bundle.deferred.is_empty() {
        push("# Requirements deferred for later verification");
        push("");
        push("Accepted in principle, but not verifiable yet. Do not treat them as done.");
        push("");
        for item in &bundle.deferred {
            let why = item
                .review
                .defer_reason
                .as_ref()
                .map(|reason| format!(" ({reason})"))
                .unwrap_or_default();
            push(&format!(
                "- {}: {}{why}",
                item.item.capability, item.item.name
            ));
        }
        push("");
    }

    if !bundle.missing.is_empty() {
        // Said out loud so the agent does not read an absent section as "there
        // are no constraints" — it means nobody has written them down yet.
        push(&format!(
            "(Context not available: {}.)",
            bundle.missing.join("; ")
        ));
        push("");
    }

    out.join("\n")
}

/// The full prompt: context bundle, then OpenSpec's own instructions.
pub fn build_prompt(bundle: &ContextBundle, instructions: &str) -> String {
    if bundle.is_empty() {
        return instructions.to_owned();
    }
    let context = render_context(bundle);
    if context.is_empty() {
        return instructions.to_owned();
    }
    format!("{context}\n---\n\n{instructions}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::decisions::{parse_decisions, promote_decision, PromoteOptions};
    use crate::core::requirements::parse_spec_file;
    use crate::core::review::{empty_review, reconcile, set_state, DecisionNote, ReviewState};
    use tempfile::TempDir;

    const SPEC: &str = "## ADDED Requirements\n\n### Requirement: Alpha\nSHALL alpha.\n\n### Requirement: Beta\nSHALL beta.\n\n### Requirement: Gamma\nSHALL gamma.\n";

    fn reviewed() -> Vec<ReviewedItem> {
        let all = parse_spec_file(SPEC, "cap", "/p/specs/cap/spec.md").requirements;
        let items: Vec<_> = all.clone();
        let mut review = set_state(
            &empty_review("c"),
            &items[0],
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        review = set_state(
            &review,
            &items[1],
            ReviewState::Deferred,
            &DecisionNote::defer_reason("awaiting-deployment"),
        );
        review = set_state(
            &review,
            &items[2],
            ReviewState::Rejected,
            &DecisionNote::note("too specific"),
        );
        reconcile(&items, &review)
    }

    fn names(items: &[ReviewedItem]) -> Vec<&str> {
        items.iter().map(|r| r.item.name.as_str()).collect()
    }

    #[test]
    fn separates_accepted_from_deferred_and_excludes_rejected() {
        // A rejected requirement is not something to build against.
        let dir = TempDir::new().expect("temp dir");
        let bundle = build_context(dir.path(), &reviewed());
        assert_eq!(names(&bundle.accepted), vec!["Alpha"]);
        assert_eq!(names(&bundle.deferred), vec!["Beta"]);
    }

    #[test]
    fn reads_foundation_documents_and_adrs_when_they_exist() {
        let dir = TempDir::new().expect("temp dir");
        let root = dir.path();
        fs::create_dir_all(root.join("spec-tacular/foundation")).expect("mkdir");
        fs::create_dir_all(root.join("spec-tacular/decisions")).expect("mkdir");
        fs::write(
            root.join("spec-tacular/foundation/stack.md"),
            "# Stack\nTypeScript.",
        )
        .expect("write");
        fs::write(
            root.join("spec-tacular/decisions/0001-errors.md"),
            "# ADR 1\nResult types.",
        )
        .expect("write");

        let bundle = build_context(root, &[]);
        assert_eq!(
            bundle
                .foundation
                .iter()
                .map(|d| d.name.as_str())
                .collect::<Vec<_>>(),
            vec!["stack.md"]
        );
        assert!(bundle.decisions[0].content.contains("Result types"));
        assert!(bundle.missing.is_empty());
    }

    #[test]
    fn says_what_is_missing_rather_than_implying_there_are_no_rules() {
        // An absent section must not read as "there are no constraints".
        let dir = TempDir::new().expect("temp dir");
        assert_eq!(
            build_context(dir.path(), &[]).missing,
            vec![
                "no foundation documents yet",
                "no architectural decision records yet"
            ]
        );
    }

    #[test]
    fn ignores_non_markdown_files() {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join("spec-tacular/foundation")).expect("mkdir");
        fs::write(
            dir.path().join("spec-tacular/foundation/notes.txt"),
            "ignored",
        )
        .expect("write");
        assert!(build_context(dir.path(), &[]).foundation.is_empty());
    }

    #[test]
    fn lists_accepted_requirements_and_tells_the_agent_to_treat_them_as_fixed() {
        let dir = TempDir::new().expect("temp dir");
        let out = render_context(&build_context(dir.path(), &reviewed()));
        assert!(out.contains("Requirements a human has accepted"));
        assert!(out.contains("cap: Alpha"));
        assert!(out.contains("do not design around it"));
    }

    #[test]
    fn marks_deferred_requirements_with_their_reason_and_warns_they_are_not_done() {
        let dir = TempDir::new().expect("temp dir");
        let out = render_context(&build_context(dir.path(), &reviewed()));
        assert!(out.contains("cap: Beta (awaiting-deployment)"));
        assert!(out.contains("Do not treat them as done"));
    }

    #[test]
    fn never_includes_a_rejected_requirement() {
        let dir = TempDir::new().expect("temp dir");
        assert!(!render_context(&build_context(dir.path(), &reviewed())).contains("Gamma"));
    }

    #[test]
    fn tells_the_agent_not_to_diverge_from_an_adr_silently() {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join("spec-tacular/decisions")).expect("mkdir");
        fs::write(dir.path().join("spec-tacular/decisions/0001-x.md"), "# ADR").expect("write");
        assert!(render_context(&build_context(dir.path(), &[])).contains("never diverge silently"));
    }

    #[test]
    fn states_what_context_was_unavailable() {
        let dir = TempDir::new().expect("temp dir");
        assert!(render_context(&build_context(dir.path(), &[])).contains("Context not available"));
    }

    #[test]
    fn the_vision_leads_the_prompt_without_repeating_its_heading() {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join("spec-tacular")).expect("mkdir");
        fs::write(
            dir.path().join("spec-tacular/vision.md"),
            "# Vision\n\nA tool for reviewing specs.\n",
        )
        .expect("write");
        let out = render_context(&build_context(dir.path(), &[]));
        assert!(out.starts_with("# Product vision\n"));
        assert!(out.contains("A tool for reviewing specs."));
        assert!(!out.contains("# Vision"));
    }

    #[test]
    fn carries_the_foundation_once_it_exists() {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join("spec-tacular/foundation")).expect("mkdir");
        fs::write(
            dir.path().join("spec-tacular/foundation/stack.md"),
            "# Stack\n\nRuntime is `Bun`.\n",
        )
        .expect("write");

        let bundle = build_context(dir.path(), &[]);
        assert_eq!(
            bundle
                .foundation
                .iter()
                .map(|d| d.name.as_str())
                .collect::<Vec<_>>(),
            vec!["stack.md"]
        );
        assert!(render_context(&bundle).contains("Runtime is `Bun`."));
        assert_eq!(
            bundle.missing,
            vec!["no architectural decision records yet"]
        );
    }

    #[test]
    fn carries_accepted_adrs_but_not_superseded_ones() {
        let dir = TempDir::new().expect("temp dir");
        let decision = parse_decisions(
            "## Decisions\n\n### Errors\n**Scope: global**\n\nErrors are values.\n",
            "/p/design.md",
        )
        .remove(0);
        promote_decision(dir.path(), &decision, &PromoteOptions::default()).expect("promote");

        let mut reversed = decision.clone();
        reversed.item.name = "Errors reversed".to_owned();
        reversed.item.text = "Errors are exceptions.".to_owned();
        promote_decision(
            dir.path(),
            &reversed,
            &PromoteOptions {
                supersedes: Some(1),
                ..PromoteOptions::default()
            },
        )
        .expect("promote");

        let rendered = render_context(&build_context(dir.path(), &[]));
        assert!(rendered.contains("Errors are exceptions."));
        assert!(!rendered.contains("Errors are values."));
    }

    #[test]
    fn puts_context_before_the_instructions() {
        let dir = TempDir::new().expect("temp dir");
        let prompt = build_prompt(&build_context(dir.path(), &reviewed()), "INSTRUCTIONS HERE");
        assert!(prompt.find("Alpha") < prompt.find("INSTRUCTIONS HERE"));
        assert!(prompt.contains("INSTRUCTIONS HERE"));
    }

    #[test]
    fn is_just_the_instructions_when_there_is_no_context_at_all() {
        assert_eq!(
            build_prompt(&ContextBundle::default(), "ONLY THIS"),
            "ONLY THIS"
        );
    }
}
