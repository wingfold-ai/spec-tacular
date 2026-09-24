//! The pending-validation register.
//!
//! OpenSpec's archive counts unchecked boxes in `tasks.md` and blocks, offering
//! only `--yes` (archive anyway, losing the record of what was never verified)
//! or `--skip-specs` (archive without merging specs at all). Both are
//! all-or-nothing: there is no way to say *these requirements are verified,
//! that one waits for a deployed environment* (docs/problem-analysis.md §8).
//!
//! The register is that missing middle. A deferred requirement leaves the
//! change but does not enter the accepted baseline — it waits here, in full,
//! with what would verify it, until someone can.
//!
//! It is markdown rather than a data file on purpose: the register is meant to
//! be read, reviewed and committed like any other document in the project.

use std::io;
use std::path::{Path, PathBuf};

use crate::core::markdown::{
    build_code_fence_mask, normalize_requirement_name, normalized_lines, pattern,
    REQUIREMENT_HEADER, SECTION_HEADER,
};

pattern!(
    /// `**Change:** …`, `**Deferred:** …`, `**Needs:** …` — the register's own
    /// bookkeeping, which never becomes part of a requirement's body.
    META,
    r"^\*\*(Change|Deferred|Needs):\*\*\s*(.*)$"
);

/// One requirement waiting on validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingEntry {
    pub capability: String,
    pub name: String,
    /// The requirement block verbatim, metadata lines excluded.
    pub body: String,
    /// The change it was deferred from.
    pub change: String,
    /// ISO date it was deferred.
    pub deferred: String,
    /// What would verify it — the reason given at review time.
    pub needs: String,
}

/// `<project>/spec-tacular/pending-validation.md`.
pub fn register_path(project_root: impl AsRef<Path>) -> PathBuf {
    project_root
        .as_ref()
        .join("spec-tacular")
        .join("pending-validation.md")
}

/// The preamble every written register carries, so the file explains itself to
/// whoever opens it in the repository rather than in this tool.
const HEADER: &[&str] = &[
    "# Pending validation",
    "",
    "Requirements that were accepted in principle but could not be verified when",
    "their change closed — typically because they need a deployed environment.",
    "",
    "They are **not** part of the accepted baseline in `openspec/specs/`. Verify",
    "one and it moves there:",
    "",
    "```",
    "spectacular verify \"<capability>\" --requirement \"<name>\"",
    "```",
    "",
];

/// Reads the register. A missing file is an empty register, not an error.
pub fn load_register(project_root: impl AsRef<Path>) -> Vec<PendingEntry> {
    let Ok(content) = std::fs::read_to_string(register_path(project_root)) else {
        return Vec::new();
    };
    parse_register(&content)
}

/// The register's entries, in the order the file lists them.
fn parse_register(content: &str) -> Vec<PendingEntry> {
    let lines = normalized_lines(content);
    let mask = build_code_fence_mask(&lines);
    let mut entries: Vec<PendingEntry> = Vec::new();
    let mut capability = String::new();

    let mut i = 0;
    while i < lines.len() {
        let line = &lines[i];
        if mask[i] {
            i += 1;
            continue;
        }

        if SECTION_HEADER.is_match(line) {
            capability = line
                .trim_start_matches('#')
                .trim_start()
                .trim_end()
                .to_owned();
            i += 1;
            continue;
        }

        let Some(header) = REQUIREMENT_HEADER.captures(line) else {
            i += 1;
            continue;
        };
        let name = normalize_requirement_name(&header[1]);

        let mut body: Vec<&str> = Vec::new();
        let mut change = String::new();
        let mut deferred = String::new();
        let mut needs = String::new();

        let mut j = i + 1;
        while j < lines.len() {
            let next = &lines[j];
            if !mask[j] && (REQUIREMENT_HEADER.is_match(next) || SECTION_HEADER.is_match(next)) {
                break;
            }
            // Metadata is kept out of the body so verifying writes the
            // requirement into the spec exactly as it was reviewed, with no
            // register bookkeeping.
            match META.captures(next) {
                Some(meta) => {
                    let value = meta[2].trim().to_owned();
                    match &meta[1] {
                        "Change" => change = value,
                        "Deferred" => deferred = value,
                        _ => needs = value,
                    }
                }
                None => body.push(next),
            }
            j += 1;
        }

        entries.push(PendingEntry {
            capability: capability.clone(),
            name,
            body: body.join("\n").trim().to_owned(),
            change,
            deferred,
            needs,
        });
        i = j;
    }

    entries
}

/// Rewrites the register, grouped by capability.
pub fn save_register(project_root: impl AsRef<Path>, entries: &[PendingEntry]) -> io::Result<()> {
    let path = register_path(project_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, render_register(entries))
}

/// The register's text, so the writer is testable without a filesystem.
fn render_register(entries: &[PendingEntry]) -> String {
    let mut out: Vec<String> = HEADER.iter().map(|l| (*l).to_owned()).collect();

    if entries.is_empty() {
        out.push("_Nothing is waiting on validation._".to_owned());
        out.push(String::new());
        return out.join("\n");
    }

    // Grouped and sorted by capability, so a register that grew over a dozen
    // changes still reads as one document per capability.
    let mut capabilities: Vec<&str> = Vec::new();
    for entry in entries {
        if !capabilities.contains(&entry.capability.as_str()) {
            capabilities.push(&entry.capability);
        }
    }
    capabilities.sort_unstable();

    for capability in capabilities {
        out.push(format!("## {capability}"));
        out.push(String::new());
        for entry in entries.iter().filter(|e| e.capability == capability) {
            out.push(format!("### Requirement: {}", entry.name));
            out.push(String::new());
            if !entry.body.is_empty() {
                out.push(entry.body.clone());
                out.push(String::new());
            }
            out.push(format!("**Change:** {}", entry.change));
            out.push(format!("**Deferred:** {}", entry.deferred));
            out.push(format!("**Needs:** {}", entry.needs));
            out.push(String::new());
        }
    }
    out.join("\n")
}

/// Adds entries, replacing any that match an existing capability and name.
pub fn add_to_register(
    project_root: impl AsRef<Path>,
    incoming: &[PendingEntry],
) -> io::Result<Vec<PendingEntry>> {
    let project_root = project_root.as_ref();
    let mut merged: Vec<PendingEntry> = load_register(project_root)
        .into_iter()
        .filter(|existing| {
            !incoming
                .iter()
                .any(|i| i.capability == existing.capability && i.name == existing.name)
        })
        .collect();
    merged.extend_from_slice(incoming);
    save_register(project_root, &merged)?;
    Ok(merged)
}

/// Case- and spacing-insensitive, because the name is typed on a command line.
fn fold(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// One entry by capability and name.
pub fn find_entry<'a>(
    entries: &'a [PendingEntry],
    capability: &str,
    name: &str,
) -> Option<&'a PendingEntry> {
    let target = fold(name);
    entries
        .iter()
        .find(|e| e.capability == capability && fold(&e.name) == target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn entry() -> PendingEntry {
        PendingEntry {
            capability: "data-export".to_owned(),
            name: "Export completes against a deployed instance".to_owned(),
            body: "The system SHALL complete an export end to end.\n\n\
                   #### Scenario: Deployed\n\
                   - **WHEN** run against a deployment\n\
                   - **THEN** a file is produced"
                .to_owned(),
            change: "add-export".to_owned(),
            deferred: "2026-09-21".to_owned(),
            needs: "a deployed instance".to_owned(),
        }
    }

    #[test]
    fn round_trips_an_entry_with_its_metadata() {
        let dir = TempDir::new().expect("temp dir");
        save_register(dir.path(), &[entry()]).expect("save");
        let loaded = load_register(dir.path());

        assert_eq!(loaded, [entry()]);
        // The scenario survives, because verifying must write back exactly
        // what was reviewed.
        assert!(loaded[0].body.contains("#### Scenario: Deployed"));
    }

    #[test]
    fn metadata_is_kept_out_of_the_body() {
        let dir = TempDir::new().expect("temp dir");
        save_register(dir.path(), &[entry()]).expect("save");
        assert!(!load_register(dir.path())[0].body.contains("**Needs:**"));
        let text = std::fs::read_to_string(register_path(dir.path())).expect("read");
        assert!(text.contains("**Needs:** a deployed instance"));
    }

    #[test]
    fn groups_by_capability() {
        let dir = TempDir::new().expect("temp dir");
        let other = PendingEntry {
            capability: "auth".to_owned(),
            name: "Login works".to_owned(),
            ..entry()
        };
        save_register(dir.path(), &[entry(), other]).expect("save");

        let text = std::fs::read_to_string(register_path(dir.path())).expect("read");
        assert!(text.find("## auth") < text.find("## data-export"));
        assert_eq!(
            load_register(dir.path())
                .iter()
                .map(|e| e.capability.clone())
                .collect::<Vec<_>>(),
            ["auth", "data-export"]
        );
    }

    #[test]
    fn an_empty_register_says_so_rather_than_being_blank() {
        let dir = TempDir::new().expect("temp dir");
        save_register(dir.path(), &[]).expect("save");
        let text = std::fs::read_to_string(register_path(dir.path())).expect("read");
        assert!(text.contains("Nothing is waiting on validation"));
        assert!(load_register(dir.path()).is_empty());
    }

    #[test]
    fn a_missing_register_is_empty_not_an_error() {
        let dir = TempDir::new().expect("temp dir");
        assert!(load_register(dir.path()).is_empty());
    }

    #[test]
    fn adding_replaces_a_matching_entry_rather_than_duplicating_it() {
        let dir = TempDir::new().expect("temp dir");
        add_to_register(dir.path(), &[entry()]).expect("add");
        add_to_register(
            dir.path(),
            &[PendingEntry {
                needs: "a staging deployment".to_owned(),
                ..entry()
            }],
        )
        .expect("add again");

        let all = load_register(dir.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].needs, "a staging deployment");
    }

    #[test]
    fn find_entry_ignores_case_and_spacing() {
        let entries = [entry()];
        assert!(find_entry(
            &entries,
            "data-export",
            "export  completes Against a deployed instance"
        )
        .is_some());
        assert!(find_entry(&entries, "other", &entry().name).is_none());
    }

    #[test]
    fn a_requirement_shown_inside_a_code_fence_is_not_an_entry() {
        // The header's own example block contains a `spectacular verify` line;
        // a fenced `### Requirement:` anywhere else must be equally inert.
        let register = format!(
            "{}\n## cap\n\n### Requirement: Real\nBody.\n\n```\n### Requirement: Illustrative\n```\n",
            HEADER.join("\n")
        );
        let entries = parse_register(&register);
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["Real"]
        );
    }
}
