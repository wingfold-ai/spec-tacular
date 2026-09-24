//! Marking a flagged value as an example, in place.
//!
//! This writes to a spec file, which the adapter rule otherwise forbids. The
//! exception is deliberate and narrow: that rule exists so spec-tacular never
//! creates, archives or restructures OpenSpec's artifacts behind its back. This
//! is a human editing the prose of one requirement — the same thing `e` does
//! through `$EDITOR`, minus the round trip — and it changes no structure.
//!
//! It is a pure substitution inside one requirement's block. Everything else in
//! the file is left byte-for-byte alone, and if the target cannot be located
//! unambiguously it declines rather than guessing.

use std::fs;

use super::examples::mark_as_example;
use super::markdown::{
    build_code_fence_mask, normalized_lines, REQUIREMENT_HEADER, SECTION_HEADER,
};
use super::requirements::Requirement;

/// Wraps the first occurrence of `value` within `requirement`'s block.
///
/// Scoped to the block rather than the file so marking a value in one
/// requirement cannot silently rewrite an identical word in another.
pub fn mark_example_in_file(requirement: &Requirement, value: &str) -> Result<String, String> {
    let original = fs::read_to_string(&requirement.file)
        .map_err(|err| format!("could not read {}: {err}", requirement.file))?;

    let lines = normalized_lines(&original);
    let mask = build_code_fence_mask(&lines);

    // The requirement's recorded line is 1-based and must still hold the
    // header; if the file moved under us, editing by offset would corrupt it.
    let header_index = requirement.line.wrapping_sub(1);
    let stale = "the file changed since it was read — reopen the change";
    let header = lines.get(header_index).ok_or_else(|| stale.to_owned())?;
    if mask[header_index] || !REQUIREMENT_HEADER.is_match(header) {
        return Err(stale.to_owned());
    }

    let mut end = lines.len();
    for i in (header_index + 1)..lines.len() {
        if !mask[i]
            && (REQUIREMENT_HEADER.is_match(&lines[i]) || SECTION_HEADER.is_match(&lines[i]))
        {
            end = i;
            break;
        }
    }

    let block = lines[header_index..end].join("\n");
    let marked = mark_as_example(&block, value)
        .ok_or_else(|| format!("'{value}' is not in this requirement, or is already an example"))?;

    let mut updated: Vec<&str> = lines[..header_index].iter().map(String::as_str).collect();
    updated.extend(marked.split('\n'));
    updated.extend(lines[end..].iter().map(String::as_str));
    fs::write(&requirement.file, updated.join("\n"))
        .map_err(|err| format!("could not write {}: {err}", requirement.file))?;
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::requirements::{hash_block, parse_spec_file};

    const SPEC: &str = "# Spec Delta\n\n\
         ## ADDED Requirements\n\n\
         ### Requirement: Alpha\n\
         The system SHALL expose POST /v1/export.\n\n\
         #### Scenario: Works\n\
         - **WHEN** called\n\
         - **THEN** it works\n\n\
         ### Requirement: Beta\n\
         The system SHALL also mention POST /v1/export.\n";

    fn spec_file(body: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("a temp dir");
        let file = dir.path().join("spec.md");
        fs::write(&file, body).expect("the spec writes");
        let path = file.to_string_lossy().into_owned();
        (dir, path)
    }

    fn load(file: &str) -> Vec<Requirement> {
        let content = fs::read_to_string(file).expect("the spec reads");
        parse_spec_file(&content, "cap", file).requirements
    }

    #[test]
    fn marks_the_value_and_leaves_the_rest_of_the_file_alone() {
        let (_dir, file) = spec_file(SPEC);
        let alpha = load(&file).remove(0);

        assert_eq!(
            mark_example_in_file(&alpha, "POST /v1/export"),
            Ok("POST /v1/export".to_owned())
        );

        let updated = fs::read_to_string(&file).expect("the spec reads");
        assert!(updated.contains("SHALL expose {{example: POST /v1/export}}."));
        // Scoped to the requirement's own block: an identical value in another
        // requirement must not be rewritten behind the reviewer's back.
        assert!(updated.contains("SHALL also mention POST /v1/export."));
        assert!(updated.contains("#### Scenario: Works"));
    }

    #[test]
    fn marking_changes_the_hash_so_acceptance_resets() {
        // Marking is an edit to what the requirement promises, not a cosmetic
        // one.
        let (_dir, file) = spec_file(SPEC);
        let before = load(&file).remove(0);
        mark_example_in_file(&before, "POST /v1/export").expect("the mark applies");
        let after = load(&file).remove(0);
        assert_ne!(after.hash, before.hash);
        assert_ne!(hash_block("x"), after.hash);
    }

    #[test]
    fn the_second_requirement_can_be_marked_independently() {
        let (_dir, file) = spec_file(SPEC);
        let beta = load(&file).remove(1);
        assert!(mark_example_in_file(&beta, "POST /v1/export").is_ok());
        let updated = fs::read_to_string(&file).expect("the spec reads");
        assert!(updated.contains("SHALL expose POST /v1/export."));
        assert!(updated.contains("SHALL also mention {{example: POST /v1/export}}."));
    }

    #[test]
    fn declines_a_value_that_is_not_in_this_requirement() {
        let (_dir, file) = spec_file(SPEC);
        let result = mark_example_in_file(&load(&file).remove(0), "GET /nope");
        assert!(result
            .as_ref()
            .unwrap_err()
            .contains("not in this requirement"));
        assert_eq!(fs::read_to_string(&file).expect("the spec reads"), SPEC);
    }

    #[test]
    fn refuses_when_the_file_moved_under_it() {
        // Editing by a stale offset would corrupt the spec.
        let (_dir, file) = spec_file(SPEC);
        let stale = load(&file).remove(0);
        fs::write(&file, "# Spec Delta\n\n(replaced)\n").expect("the spec writes");
        let result = mark_example_in_file(&stale, "POST /v1/export");
        assert!(result
            .as_ref()
            .unwrap_err()
            .contains("changed since it was read"));
    }

    #[test]
    fn reports_a_missing_file_instead_of_panicking() {
        let (_dir, file) = spec_file(SPEC);
        let missing = Requirement {
            file: "/nope/missing.md".to_owned(),
            ..load(&file).remove(0)
        };
        assert!(mark_example_in_file(&missing, "POST /v1/export").is_err());
    }
}
