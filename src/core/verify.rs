//! Verifying a pending requirement into the accepted baseline.
//!
//! This is the only place spec-tacular writes to `openspec/specs/`, which the
//! adapter rule otherwise forbids. There is no OpenSpec command for "add this
//! requirement to a main spec" — archive is the only path in, and the whole
//! point of the register is that these requirements missed it.
//!
//! So the write is made as conservative as possible: the requirement block goes
//! in verbatim under the spec's `## Requirements` section, formatted by the
//! same rules the parser reads, and the caller is expected to run
//! `openspec validate` afterwards to confirm OpenSpec still accepts the file.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::core::markdown::{
    build_code_fence_mask, normalize_requirement_name, normalized_lines, REQUIREMENTS_HEADER,
    REQUIREMENT_HEADER, SECTION_HEADER,
};
use crate::core::pending::{find_entry, load_register, save_register, PendingEntry};

/// What became of a verify.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyResult {
    Verified {
        entry: PendingEntry,
        spec_file: PathBuf,
        /// The capability had no spec at all until now.
        created: bool,
    },
    Refused {
        reason: String,
    },
}

/// `<project>/openspec/specs/<capability>/spec.md`.
pub fn spec_file_for(project_root: impl AsRef<Path>, capability: &str) -> PathBuf {
    project_root
        .as_ref()
        .join("openspec")
        .join("specs")
        .join(capability)
        .join("spec.md")
}

/// Moves one register entry into its capability's main spec.
///
/// Removing it from the register only after the spec write succeeds: an entry
/// present in both places is recoverable, one lost from both is not.
pub fn verify_requirement(
    project_root: impl AsRef<Path>,
    capability: &str,
    name: &str,
) -> VerifyResult {
    let project_root = project_root.as_ref();
    let register = load_register(project_root);
    let Some(entry) = find_entry(&register, capability, name).cloned() else {
        return VerifyResult::Refused {
            reason: format!("nothing pending for '{name}' in {capability}"),
        };
    };

    let spec_file = spec_file_for(project_root, capability);
    let existing = std::fs::read_to_string(&spec_file).ok();
    let created = existing.is_none();

    let updated = match &existing {
        None => new_spec(capability, &entry),
        Some(content) => match append_requirement(content, &entry) {
            Ok(updated) => updated,
            Err(reason) => return VerifyResult::Refused { reason },
        },
    };

    if let Some(parent) = spec_file.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            return VerifyResult::Refused {
                reason: format!("could not write {}: {err}", spec_file.display()),
            };
        }
    }
    if let Err(err) = std::fs::write(&spec_file, updated) {
        return VerifyResult::Refused {
            reason: format!("could not write {}: {err}", spec_file.display()),
        };
    }

    let remaining: Vec<PendingEntry> = register
        .into_iter()
        .filter(|e| !(e.capability == entry.capability && e.name == entry.name))
        .collect();
    if let Err(err) = save_register(project_root, &remaining) {
        return VerifyResult::Refused {
            reason: format!("written to the spec, but the register could not be updated: {err}"),
        };
    }

    VerifyResult::Verified {
        entry,
        spec_file,
        created,
    }
}

/// The lines a requirement occupies in a spec, heading included.
fn block(entry: &PendingEntry) -> Vec<String> {
    vec![
        String::new(),
        format!("### Requirement: {}", entry.name),
        String::new(),
        entry.body.clone(),
    ]
}

/// A capability whose spec never existed, because every one of its requirements
/// was deferred. The Purpose is a placeholder a human has to fill in — inventing
/// one would be exactly the guessing this tool exists to stop.
fn new_spec(capability: &str, entry: &PendingEntry) -> String {
    let mut lines = vec![
        format!("# {capability}"),
        String::new(),
        "## Purpose".to_owned(),
        String::new(),
        format!("TBD — describe what {capability} is for. This spec was created by verifying"),
        "a requirement that was deferred when its change closed.".to_owned(),
        String::new(),
        "## Requirements".to_owned(),
    ];
    lines.extend(block(entry));
    lines.push(String::new());
    lines.join("\n")
}

/// Collapses a run of three or more newlines, which an insertion can leave.
fn tidy(text: String) -> String {
    static RUNS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\n{3,}").expect("built-in pattern must compile"));
    RUNS.replace_all(&text, "\n\n").into_owned()
}

/// Inserts the requirement at the end of the spec's Requirements section.
fn append_requirement(content: &str, entry: &PendingEntry) -> Result<String, String> {
    let lines = normalized_lines(content);
    let mask = build_code_fence_mask(&lines);

    let target = normalize_requirement_name(&entry.name);
    for (i, line) in lines.iter().enumerate() {
        if mask[i] {
            continue;
        }
        if let Some(header) = REQUIREMENT_HEADER.captures(line) {
            if normalize_requirement_name(&header[1]) == target {
                return Err(format!(
                    "'{}' is already in the spec — remove it from the register by hand",
                    entry.name
                ));
            }
        }
    }

    let section = lines
        .iter()
        .enumerate()
        .find(|(i, line)| !mask[*i] && REQUIREMENTS_HEADER.is_match(line))
        .map(|(i, _)| i);

    let Some(section) = section else {
        // No Requirements section: append one rather than guessing where it went.
        let mut out = lines;
        out.push(String::new());
        out.push("## Requirements".to_owned());
        out.extend(block(entry));
        out.push(String::new());
        return Ok(tidy(out.join("\n")));
    };

    // Insert at the end of the section, not the end of the file: a spec may
    // have sections after Requirements, and a requirement under them would be
    // lost.
    let mut end = lines
        .iter()
        .enumerate()
        .skip(section + 1)
        .find(|(i, line)| !mask[*i] && SECTION_HEADER.is_match(line))
        .map_or(lines.len(), |(i, _)| i);
    while end > section + 1 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }

    let mut out: Vec<String> = lines[..end].to_vec();
    out.extend(block(entry));
    out.push(String::new());
    out.extend_from_slice(&lines[end..]);
    Ok(tidy(out.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::pending::add_to_register;
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

    fn with_spec(content: &str) -> (TempDir, PathBuf) {
        let dir = TempDir::new().expect("temp dir");
        let file = spec_file_for(dir.path(), "data-export");
        std::fs::create_dir_all(file.parent().expect("parent")).expect("spec dir");
        std::fs::write(&file, content).expect("spec");
        (dir, file)
    }

    #[test]
    fn appends_the_requirement_and_removes_it_from_the_register() {
        let (dir, file) = with_spec(
            "# data-export\n\n## Purpose\n\nExporting.\n\n## Requirements\n\n\
             ### Requirement: Existing\nThe system SHALL already do this.\n",
        );
        add_to_register(dir.path(), &[entry()]).expect("add");

        let result = verify_requirement(dir.path(), "data-export", &entry().name);
        assert!(
            matches!(result, VerifyResult::Verified { .. }),
            "{result:?}"
        );

        let spec = std::fs::read_to_string(&file).expect("read");
        assert!(spec.contains("### Requirement: Existing"));
        assert!(spec.contains("### Requirement: Export completes against a deployed instance"));
        assert!(spec.contains("#### Scenario: Deployed"));
        assert!(load_register(dir.path()).is_empty());
    }

    #[test]
    fn inserts_inside_the_requirements_section_not_at_the_end_of_the_file() {
        // A requirement written under a later section would be lost to the
        // parser.
        let (dir, file) = with_spec(
            "# data-export\n\n## Requirements\n\n### Requirement: Existing\nText.\n\n\
             ## Notes\n\nTrailing prose.\n",
        );
        add_to_register(dir.path(), &[entry()]).expect("add");
        verify_requirement(dir.path(), "data-export", &entry().name);

        let spec = std::fs::read_to_string(&file).expect("read");
        assert!(spec.find("Export completes") < spec.find("## Notes"));
        assert!(spec.contains("Trailing prose."));
    }

    #[test]
    fn creates_the_spec_when_the_capability_has_none_flagging_the_purpose() {
        // Every requirement of a brand-new capability can be deferred, leaving
        // no spec to append to.
        let dir = TempDir::new().expect("temp dir");
        add_to_register(dir.path(), &[entry()]).expect("add");
        let result = verify_requirement(dir.path(), "data-export", &entry().name);
        assert!(
            matches!(result, VerifyResult::Verified { created: true, .. }),
            "{result:?}"
        );

        let spec = std::fs::read_to_string(spec_file_for(dir.path(), "data-export")).expect("read");
        assert!(spec.contains("## Purpose"));
        assert!(spec.contains("TBD"));
        assert!(spec.contains("### Requirement: Export completes against a deployed instance"));
    }

    #[test]
    fn refuses_a_requirement_the_spec_already_has() {
        let (dir, _) = with_spec(&format!(
            "# data-export\n\n## Requirements\n\n### Requirement: {}\nAlready here.\n",
            entry().name
        ));
        add_to_register(dir.path(), &[entry()]).expect("add");
        let result = verify_requirement(dir.path(), "data-export", &entry().name);
        match &result {
            VerifyResult::Refused { reason } => assert!(reason.contains("already in the spec")),
            other => panic!("expected a refusal, got {other:?}"),
        }
        // And the register is untouched, so nothing is lost.
        assert_eq!(load_register(dir.path()).len(), 1);
    }

    #[test]
    fn refuses_an_entry_that_is_not_pending() {
        let dir = TempDir::new().expect("temp dir");
        match verify_requirement(dir.path(), "data-export", "Nothing like this") {
            VerifyResult::Refused { reason } => assert!(reason.contains("nothing pending")),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn appends_a_requirements_section_when_the_spec_has_none() {
        let (dir, file) = with_spec("# data-export\n\n## Purpose\n\nExporting.\n");
        add_to_register(dir.path(), &[entry()]).expect("add");
        assert!(matches!(
            verify_requirement(dir.path(), "data-export", &entry().name),
            VerifyResult::Verified { .. }
        ));
        assert!(std::fs::read_to_string(&file)
            .expect("read")
            .contains("## Requirements"));
    }

    #[test]
    fn the_written_spec_has_no_run_of_blank_lines() {
        // OpenSpec parses it next, and a spec that grew a gap every time a
        // requirement was verified would be unreadable long before it broke.
        let (dir, file) = with_spec(
            "# data-export\n\n## Requirements\n\n### Requirement: Existing\nText.\n\n\n\n## Notes\n",
        );
        add_to_register(dir.path(), &[entry()]).expect("add");
        verify_requirement(dir.path(), "data-export", &entry().name);
        assert!(!std::fs::read_to_string(&file)
            .expect("read")
            .contains("\n\n\n"));
    }
}
