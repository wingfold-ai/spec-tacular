//! Design decisions, and promoting them to project-wide ADRs.
//!
//! A `design.md` holds Decisions with rationale. When one is genuinely
//! architectural — auth strategy, error model, persistence choice — it belongs
//! to the project, but OpenSpec has no project-level decision record, so the
//! next change's design re-decides it, differently
//! (docs/problem-analysis.md §6).
//!
//! Decisions are parsed as [`ReviewItem`]s, so the review loop, the sidecar and
//! drift detection work on them unchanged.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use super::markdown::{build_code_fence_mask, normalized_lines, SECTION_HEADER};
use super::requirements::{hash_block, slugify, ReviewItem};

/// Where a decision applies. Global ones are candidates for promotion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionScope {
    Local,
    Global,
}

impl DecisionScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Global => "global",
        }
    }
}

impl fmt::Display for DecisionScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A design decision: an ordinary review item plus where it applies.
///
/// TypeScript modelled this as an interface extending `ReviewItem` with a
/// duplicate `body` field that always held the same string as `text`; here the
/// item is composed rather than extended, and [`Decision::body`] reads that one
/// string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub item: ReviewItem,
    pub scope: DecisionScope,
}

impl Decision {
    /// The decision's body, header excluded.
    pub fn body(&self) -> &str {
        &self.item.text
    }
}

static DECISIONS_SECTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^##\s+Decisions\s*$").expect("built-in pattern"));
static DECISION_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^###\s+(.+?)\s*$").expect("built-in pattern"));
static SCOPE_MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\*\*Scope:\s*(local|global)\s*\*\*").expect("built-in pattern")
});

/// A decision body's `**Scope: …**` marker; `local` when there is none.
fn scope_of(body: &str) -> DecisionScope {
    SCOPE_MARKER
        .captures(body)
        .map(|caps| match caps[1].to_ascii_lowercase().as_str() {
            "global" => DecisionScope::Global,
            _ => DecisionScope::Local,
        })
        .unwrap_or(DecisionScope::Local)
}

impl Decision {
    /// The decision a review item is, if it is one: a `design` item with no
    /// spec detail. The review queue carries decisions as plain
    /// [`ReviewItem`]s, so the scope is re-read from the body it came with.
    pub fn from_item(item: &ReviewItem) -> Option<Self> {
        (item.capability == "design" && !item.is_requirement()).then(|| Self {
            scope: scope_of(&item.text),
            item: item.clone(),
        })
    }
}

/// Parses the Decisions section of a design document.
///
/// Scope defaults to `local` when unmarked: promoting something project-wide
/// without anyone saying so would be the more damaging guess.
pub fn parse_decisions(content: &str, file: &str) -> Vec<Decision> {
    let lines = normalized_lines(content);
    let mask = build_code_fence_mask(&lines);

    let Some(start) = (0..lines.len())
        .find(|&i| !mask[i] && DECISIONS_SECTION.is_match(&lines[i]))
        .map(|i| i + 1)
    else {
        return Vec::new();
    };

    let end = (start..lines.len())
        .find(|&i| !mask[i] && SECTION_HEADER.is_match(&lines[i]))
        .unwrap_or(lines.len());

    let mut decisions: Vec<Decision> = Vec::new();
    // Two decisions with the same name would otherwise share one id, silently
    // merging their review state.
    let mut seen: HashMap<String, usize> = HashMap::new();

    let mut i = start;
    while i < end {
        let line = &lines[i];
        if mask[i] {
            i += 1;
            continue;
        }
        let Some(header) = DECISION_HEADER.captures(line) else {
            i += 1;
            continue;
        };

        let name = header[1].trim().to_owned();
        let mut body_lines: Vec<&str> = Vec::new();
        let mut j = i + 1;
        while j < end {
            if !mask[j] && DECISION_HEADER.is_match(&lines[j]) {
                break;
            }
            body_lines.push(&lines[j]);
            j += 1;
        }

        let body = body_lines.join("\n").trim().to_owned();
        let scope = scope_of(&body);

        let base = slugify(&name);
        let count = seen.entry(base.clone()).or_insert(0);
        *count += 1;
        let slug = if *count == 1 {
            base
        } else {
            format!("{base}~{count}")
        };

        let mut block = String::with_capacity(line.len());
        block.push_str(line);
        for body_line in &body_lines {
            block.push('\n');
            block.push_str(body_line);
        }

        decisions.push(Decision {
            item: ReviewItem {
                id: format!("design#{slug}"),
                capability: "design".to_owned(),
                name,
                text: body,
                file: file.to_owned(),
                line: i + 1,
                hash: hash_block(&block),
                // A decision carries no scenarios and no delta operation:
                // that absence is exactly what tells it from a requirement.
                spec: None,
            },
            scope,
        });

        i = j;
    }

    decisions
}

/// Reads a change's design decisions, if it has a design yet.
pub fn load_decisions(design_path: impl AsRef<Path>) -> Vec<Decision> {
    let path = design_path.as_ref();
    match fs::read_to_string(path) {
        Ok(content) => parse_decisions(&content, &path.to_string_lossy()),
        // No design yet, or an unreadable one. Neither is an error here: a
        // change without a design simply has no decisions to review.
        Err(_) => Vec::new(),
    }
}

// -----------------------------------------------------------------------------
// The ADR store
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdrStatus {
    Accepted,
    Superseded,
}

impl AdrStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Superseded => "superseded",
        }
    }
}

impl fmt::Display for AdrStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adr {
    pub number: u32,
    pub slug: String,
    pub title: String,
    pub file: PathBuf,
    pub content: String,
    pub status: AdrStatus,
    /// The ADR number that replaced this one, when superseded.
    pub superseded_by: Option<u32>,
}

pub fn decisions_dir(project_root: impl AsRef<Path>) -> PathBuf {
    project_root.as_ref().join("spec-tacular").join("decisions")
}

static ADR_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{4})-(.+)\.md$").expect("built-in pattern"));
static STATUS_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^\*\*Status:\*\*\s*(accepted|superseded(?:\s+by\s+ADR-(\d+))?)\s*$")
        .expect("built-in pattern")
});
static ADR_TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^#\s*(?:ADR-\d+:\s*)?(.+)$").expect("built-in pattern"));

pub fn list_adrs(project_root: impl AsRef<Path>) -> Vec<Adr> {
    let dir = decisions_dir(project_root);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut names: Vec<String> = entries
        .filter_map(|entry| Some(entry.ok()?.file_name().to_string_lossy().into_owned()))
        .collect();
    names.sort();

    let mut adrs: Vec<Adr> = Vec::new();
    for name in names {
        let Some(parts) = ADR_FILE.captures(&name) else {
            continue;
        };
        let Ok(number) = parts[1].parse::<u32>() else {
            continue;
        };
        let slug = parts[2].to_owned();
        let file = dir.join(&name);
        let Ok(content) = fs::read_to_string(&file) else {
            continue;
        };

        let status = STATUS_LINE.captures(&content);
        let superseded = status
            .as_ref()
            .is_some_and(|c| c[1].to_ascii_lowercase().starts_with("superseded"));
        let superseded_by = status
            .as_ref()
            .and_then(|c| c.get(2))
            .and_then(|m| m.as_str().parse::<u32>().ok());
        let title = ADR_TITLE
            .captures(&content)
            .map(|c| c[1].trim().to_owned())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| slug.clone());

        adrs.push(Adr {
            number,
            slug,
            title,
            file,
            content,
            status: if superseded {
                AdrStatus::Superseded
            } else {
                AdrStatus::Accepted
            },
            superseded_by,
        });
    }
    adrs.sort_by_key(|a| a.number);
    adrs
}

/// Only accepted ADRs are binding; superseded ones are history.
pub fn accepted_adrs(project_root: impl AsRef<Path>) -> Vec<Adr> {
    list_adrs(project_root)
        .into_iter()
        .filter(|a| a.status == AdrStatus::Accepted)
        .collect()
}

/// One past the highest number in the store.
///
/// Max rather than count, so a gap in the middle — an ADR deleted by hand —
/// never causes a number to be reused while newer ones still reference it.
///
/// Deleting the *newest* ADR does free its number, and that is not defended
/// against: an ADR is meant to be superseded, not removed. [`mark_superseded`]
/// keeps the record and the number intact, which is why it exists.
fn next_number(project_root: impl AsRef<Path>) -> u32 {
    list_adrs(project_root)
        .iter()
        .map(|a| a.number)
        .max()
        .unwrap_or(0)
        + 1
}

#[derive(Debug, Clone, Default)]
pub struct PromoteOptions {
    pub change: Option<String>,
    pub supersedes: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct PromoteResult {
    pub adr: Adr,
    /// The reference left behind in design.md.
    pub reference: String,
}

/// Lifts a design decision to a project-wide ADR.
///
/// The decision's body is copied into the ADR and a reference is left in
/// `design.md`, so the change still records what it decided while the project
/// gains the durable rule.
pub fn promote_decision(
    project_root: impl AsRef<Path>,
    decision: &Decision,
    options: &PromoteOptions,
) -> std::io::Result<PromoteResult> {
    let root = project_root.as_ref();
    let dir = decisions_dir(root);
    fs::create_dir_all(&dir)?;

    let number = next_number(root);
    let slug = slugify(&decision.item.name);
    let padded = format!("{number:04}");
    let file = dir.join(format!("{padded}-{slug}.md"));

    let mut lines: Vec<String> = vec![
        format!("# ADR-{padded}: {}", decision.item.name),
        String::new(),
        "**Status:** accepted".to_owned(),
        format!("**Date:** {}", chrono::Utc::now().format("%Y-%m-%d")),
    ];
    if let Some(change) = &options.change {
        lines.push(format!("**Origin:** change `{change}`"));
    }
    if let Some(supersedes) = options.supersedes {
        lines.push(format!("**Supersedes:** ADR-{supersedes:04}"));
    }
    lines.push(String::new());
    // The body carries the scope marker, which is meaningless once promoted —
    // an ADR is global by definition.
    lines.push(
        SCOPE_MARKER
            .replace(decision.body(), "")
            .trim_start()
            .to_owned(),
    );
    lines.push(String::new());

    let content = lines.join("\n");
    fs::write(&file, &content)?;

    if let Some(supersedes) = options.supersedes {
        mark_superseded(root, supersedes, number)?;
    }

    Ok(PromoteResult {
        adr: Adr {
            number,
            slug: slug.clone(),
            title: decision.item.name.clone(),
            file,
            content,
            status: AdrStatus::Accepted,
            superseded_by: None,
        },
        reference: format!("See ADR-{padded} (`spec-tacular/decisions/{padded}-{slug}.md`)."),
    })
}

/// Marks an ADR superseded, in place. `false` when there is no such ADR.
pub fn mark_superseded(
    project_root: impl AsRef<Path>,
    number: u32,
    by: u32,
) -> std::io::Result<bool> {
    let Some(adr) = list_adrs(project_root)
        .into_iter()
        .find(|a| a.number == number)
    else {
        return Ok(false);
    };
    let replacement = format!("**Status:** superseded by ADR-{by:04}");
    let updated = if STATUS_LINE.is_match(&adr.content) {
        STATUS_LINE
            .replace(&adr.content, replacement.as_str())
            .into_owned()
    } else {
        // An ADR written by hand with no status line still has to be
        // retirable; appending one is better than refusing.
        format!("{}\n\n{replacement}\n", adr.content)
    };
    fs::write(&adr.file, updated)?;
    Ok(true)
}

/// Replaces a promoted decision's body with a reference to its ADR.
///
/// The change keeps a record of what it decided; the rule itself now lives in
/// one place. Leaving the full text behind would let the two drift, which is
/// the duplication the ADR store exists to end.
pub fn replace_decision_body(decision: &Decision, reference: &str) -> Result<(), String> {
    let original = fs::read_to_string(&decision.item.file)
        .map_err(|err| format!("could not read design.md: {err}"))?;

    let lines = normalized_lines(&original);
    let header_index = decision.item.line.wrapping_sub(1);
    // Editing by a stale offset would corrupt the design document.
    let Some(header) = lines
        .get(header_index)
        .filter(|l| DECISION_HEADER.is_match(l))
    else {
        return Err("design.md changed since it was read — reopen the change".to_owned());
    };

    let end = ((header_index + 1)..lines.len())
        .find(|&i| DECISION_HEADER.is_match(&lines[i]) || SECTION_HEADER.is_match(&lines[i]))
        .unwrap_or(lines.len());

    let mut updated: Vec<&str> = lines[..header_index].iter().map(String::as_str).collect();
    updated.extend([header.as_str(), "", reference, ""]);
    updated.extend(lines[end..].iter().map(String::as_str));

    fs::write(&decision.item.file, updated.join("\n"))
        .map_err(|err| format!("could not write design.md: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DESIGN: &str = r"# Design

## Context

Some context.

## Decisions

### Use result types for errors
**Scope: global**

**Decision:** Errors are values, not exceptions.

**Rationale:** Exceptions escape type checking.

### Cache the parsed schema
**Scope: local**

**Decision:** Parse once per process.

### Unmarked decision

**Decision:** Something.

## Risks / Trade-offs

Nothing much.
";

    fn parse_default() -> Vec<Decision> {
        parse_decisions(DESIGN, "/p/changes/c/design.md")
    }

    // ---- parseDecisions ----------------------------------------------------

    #[test]
    fn reads_each_decision_with_its_scope() {
        let decisions = parse_default();
        let seen: Vec<(&str, DecisionScope)> = decisions
            .iter()
            .map(|d| (d.item.name.as_str(), d.scope))
            .collect();
        assert_eq!(
            seen,
            [
                ("Use result types for errors", DecisionScope::Global),
                ("Cache the parsed schema", DecisionScope::Local),
                ("Unmarked decision", DecisionScope::Local),
            ]
        );
    }

    #[test]
    fn a_review_item_is_read_back_as_the_decision_it_came_from() {
        for decision in parse_default() {
            assert_eq!(Decision::from_item(&decision.item), Some(decision));
        }
        // A requirement is not a decision, whatever its capability.
        let spec = crate::core::requirements::parse_spec_file(
            "## ADDED Requirements\n\n### Requirement: A\nSHALL a.\n",
            "design",
            "/p/specs/design/spec.md",
        );
        assert_eq!(Decision::from_item(&spec.requirements[0]), None);
    }

    #[test]
    fn defaults_an_unmarked_scope_to_local() {
        // Promoting something project-wide without anyone saying so is the
        // more damaging guess.
        assert_eq!(parse_default()[2].scope, DecisionScope::Local);
    }

    #[test]
    fn ids_and_hashes_make_them_reviewable_like_requirements() {
        let first = parse_default().remove(0);
        assert_eq!(first.item.id, "design#use-result-types-for-errors");
        assert_eq!(first.item.capability, "design");
        assert!(first.item.hash.starts_with("sha256:"));
        assert_eq!(first.item.line, 9);
        // A decision is not a requirement: no scenarios, no delta operation.
        assert!(!first.item.is_requirement());
    }

    #[test]
    fn stops_at_the_next_top_level_section() {
        let decisions = parse_default();
        assert!(!decisions
            .iter()
            .any(|d| d.item.name == "Risks / Trade-offs"));
        assert!(!decisions[2].item.text.contains("Nothing much"));
    }

    #[test]
    fn a_design_with_no_decisions_section_yields_nothing() {
        assert!(parse_decisions("# Design\n\n## Context\n\nOnly context.\n", "d.md").is_empty());
    }

    #[test]
    fn ignores_decisions_inside_fenced_code_blocks() {
        let decisions = parse_decisions(
            "## Decisions\n\n### Real\n**Scope: local**\n\n```md\n### Fake\n```\n",
            "d.md",
        );
        assert_eq!(
            decisions
                .iter()
                .map(|d| d.item.name.as_str())
                .collect::<Vec<_>>(),
            ["Real"]
        );
    }

    #[test]
    fn disambiguates_decisions_with_the_same_name() {
        let decisions = parse_decisions("## Decisions\n\n### Same\na\n\n### Same\nb\n", "d.md");
        assert_eq!(
            decisions
                .iter()
                .map(|d| d.item.id.as_str())
                .collect::<Vec<_>>(),
            ["design#same", "design#same~2"]
        );
    }

    // ---- the ADR store -----------------------------------------------------

    fn global_decision() -> Decision {
        parse_default().remove(0)
    }

    fn named(name: &str) -> Decision {
        let mut decision = global_decision();
        decision.item.name = name.to_owned();
        decision
    }

    #[test]
    fn promoting_writes_a_numbered_adr() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        let result = promote_decision(
            root,
            &global_decision(),
            &PromoteOptions {
                change: Some("add-errors".to_owned()),
                supersedes: None,
            },
        )
        .expect("promote");

        assert_eq!(result.adr.number, 1);
        assert!(result
            .adr
            .file
            .ends_with("0001-use-result-types-for-errors.md"));
        assert!(result.reference.contains("ADR-0001"));

        let content = fs::read_to_string(&result.adr.file).expect("read adr");
        assert!(content.contains("# ADR-0001: Use result types for errors"));
        assert!(content.contains("**Status:** accepted"));
        assert!(content.contains("**Origin:** change `add-errors`"));
        assert!(content.contains("Errors are values, not exceptions."));
        // The scope marker is meaningless once promoted: an ADR is global by
        // definition.
        assert!(!content.contains("Scope: global"));
    }

    #[test]
    fn numbers_increase() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        promote_decision(root, &global_decision(), &PromoteOptions::default()).expect("first");
        let second =
            promote_decision(root, &named("Another"), &PromoteOptions::default()).expect("second");
        assert_eq!(second.adr.number, 2);
    }

    #[test]
    fn a_gap_in_the_middle_never_causes_a_reuse() {
        // Newer ADRs may reference the deleted one's neighbours by number.
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        let first =
            promote_decision(root, &global_decision(), &PromoteOptions::default()).expect("first");
        promote_decision(root, &named("Second"), &PromoteOptions::default()).expect("second");
        fs::remove_file(&first.adr.file).expect("remove");
        let third =
            promote_decision(root, &named("Third"), &PromoteOptions::default()).expect("third");
        assert_eq!(third.adr.number, 3);
    }

    #[test]
    fn superseding_keeps_the_record_and_the_number() {
        // The supported way to retire a decision. Deleting the newest ADR does
        // free its number, which is why supersede exists instead.
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        promote_decision(root, &global_decision(), &PromoteOptions::default()).expect("first");
        let replacement = promote_decision(
            root,
            &named("Reversed"),
            &PromoteOptions {
                change: None,
                supersedes: Some(1),
            },
        )
        .expect("second");
        assert_eq!(replacement.adr.number, 2);
        assert_eq!(
            list_adrs(root).iter().map(|a| a.number).collect::<Vec<_>>(),
            [1, 2]
        );
    }

    #[test]
    fn lists_adrs_with_their_status() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        promote_decision(root, &global_decision(), &PromoteOptions::default()).expect("promote");
        let adrs = list_adrs(root);
        assert_eq!(adrs.len(), 1);
        assert_eq!(adrs[0].number, 1);
        assert_eq!(adrs[0].status, AdrStatus::Accepted);
        assert_eq!(adrs[0].title, "Use result types for errors");
    }

    #[test]
    fn superseding_records_which_adr_replaced_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        promote_decision(root, &global_decision(), &PromoteOptions::default()).expect("first");
        let replacement = promote_decision(
            root,
            &named("Use exceptions"),
            &PromoteOptions {
                change: None,
                supersedes: Some(1),
            },
        )
        .expect("second");

        let adrs = list_adrs(root);
        assert_eq!(adrs[0].number, 1);
        assert_eq!(adrs[0].status, AdrStatus::Superseded);
        assert_eq!(adrs[0].superseded_by, Some(2));
        assert_eq!(adrs[1].number, replacement.adr.number);
        assert_eq!(adrs[1].status, AdrStatus::Accepted);
    }

    #[test]
    fn only_accepted_adrs_are_binding() {
        // A superseded one is history; feeding it to an agent as a rule would
        // resurrect a decision the project reversed.
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        promote_decision(root, &global_decision(), &PromoteOptions::default()).expect("first");
        promote_decision(
            root,
            &named("Replacement"),
            &PromoteOptions {
                change: None,
                supersedes: Some(1),
            },
        )
        .expect("second");
        assert_eq!(
            accepted_adrs(root)
                .iter()
                .map(|a| a.number)
                .collect::<Vec<_>>(),
            [2]
        );
    }

    #[test]
    fn superseding_an_adr_that_does_not_exist_is_a_no_op() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(!mark_superseded(dir.path(), 99, 1).expect("no-op"));
    }

    #[test]
    fn an_empty_store_lists_nothing() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(list_adrs(dir.path()).is_empty());
    }

    #[test]
    fn files_that_are_not_adrs_are_ignored() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        fs::create_dir_all(decisions_dir(root)).expect("mkdir");
        fs::write(decisions_dir(root).join("notes.md"), "# Notes").expect("write");
        assert!(list_adrs(root).is_empty());
    }

    // ---- replaceDecisionBody -----------------------------------------------

    fn design_file(dir: &Path) -> PathBuf {
        let file = dir.join("design.md");
        fs::write(&file, DESIGN).expect("write design");
        file
    }

    fn first_decision_of(file: &Path) -> Decision {
        let content = fs::read_to_string(file).expect("read design");
        parse_decisions(&content, &file.to_string_lossy()).remove(0)
    }

    #[test]
    fn leaves_a_reference_behind_and_keeps_the_rest_of_the_document() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = design_file(dir.path());
        let decision = first_decision_of(&file);

        assert_eq!(replace_decision_body(&decision, "See ADR-0001."), Ok(()));

        let updated = fs::read_to_string(&file).expect("read back");
        assert!(updated.contains("### Use result types for errors\n\nSee ADR-0001."));
        // The promoted decision's text is gone — keeping it would let the two
        // drift, which is what the ADR store exists to end.
        assert!(!updated.contains("Errors are values, not exceptions."));
        // Everything else survives.
        assert!(updated.contains("### Cache the parsed schema"));
        assert!(updated.contains("## Risks / Trade-offs"));
        assert!(updated.contains("Nothing much."));
    }

    #[test]
    fn refuses_when_the_document_moved_under_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = design_file(dir.path());
        let stale = first_decision_of(&file);
        fs::write(&file, "# Design\n\n(replaced)\n").expect("overwrite");
        let reason = replace_decision_body(&stale, "See ADR-0001.").expect_err("must refuse");
        assert!(reason.contains("changed since it was read"));
    }

    #[test]
    fn reports_a_missing_file_instead_of_throwing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = design_file(dir.path());
        let mut decision = first_decision_of(&file);
        decision.item.file = "/nope/design.md".to_owned();
        assert!(replace_decision_body(&decision, "x").is_err());
    }
}
