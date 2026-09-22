//! Cross-implementation compatibility: Rust must agree with the TypeScript
//! original, value for value.
//!
//! The port is only safe if a repository can be opened by either
//! implementation. Two things have to match exactly for that to hold:
//!
//! - **Identity.** A requirement's id is what keys its review state, so a
//!   different slug means a different sidecar entry and an acceptance silently
//!   lost.
//! - **The hash.** Drift detection compares a stored hash against a freshly
//!   computed one. A hash that differs by a single byte marks every
//!   requirement in the project as "changed since you accepted it".
//!
//! The expected values below are not hand-written. They were produced by
//! running the TypeScript `parseSpecFile`, `slugify`, `hashBlock` and
//! `saveReview` over `tests/fixtures/compat-spec.md` — the same file this test
//! parses — and pasting the output. `tests/fixtures/compat-review.json` is
//! literally the sidecar the TypeScript writer emitted. When one of these
//! assertions fails, the Rust side is wrong.

use std::fs;

use super::requirements::{capability_from_path, hash_block, parse_spec_file, slugify};
use super::review::{load_review, reconcile, save_review, summarize, ReviewState};

/// The spec both implementations parse.
const SPEC: &str = include_str!("../../tests/fixtures/compat-spec.md");

/// The sidecar the TypeScript `saveReview` wrote for it.
const SIDECAR: &str = include_str!("../../tests/fixtures/compat-review.json");

/// The path the TypeScript run was given, so `capability_from_path` sees the
/// same input.
const SPEC_PATH: &str = "/p/openspec/changes/compat/specs/export/spec.md";

#[test]
fn the_capability_is_read_from_the_path_the_same_way() {
    assert_eq!(capability_from_path(SPEC_PATH), "export");
}

#[test]
fn requirement_ids_names_operations_and_lines_match_typescript() {
    let parsed = parse_spec_file(SPEC, &capability_from_path(SPEC_PATH), SPEC_PATH);
    let seen: Vec<(&str, &str, String, usize)> = parsed
        .requirements
        .iter()
        .map(|r| {
            (
                r.id.as_str(),
                r.name.as_str(),
                r.operation()
                    .expect("a requirement has an operation")
                    .to_string(),
                r.line,
            )
        })
        .collect();

    assert_eq!(
        seen,
        [
            ("export#data-export", "Data export", "ADDED".to_owned(), 5),
            (
                "export#export-notification",
                "Export notification",
                "ADDED".to_owned(),
                17
            ),
            ("export#import", "Import", "MODIFIED".to_owned(), 28),
        ]
    );
}

#[test]
fn the_hashes_are_byte_identical_to_typescript() {
    let parsed = parse_spec_file(SPEC, &capability_from_path(SPEC_PATH), SPEC_PATH);
    let hashes: Vec<&str> = parsed
        .requirements
        .iter()
        .map(|r| r.hash.as_str())
        .collect();
    assert_eq!(
        hashes,
        [
            "sha256:24b5cf68c3ace0a9d72e38271e2651db",
            "sha256:a9bca925ea24a988956e9587328359d2",
            "sha256:a8ad2cc699058a06cab0e4282fd2060c",
        ]
    );
}

#[test]
fn hash_block_agrees_on_the_awkward_inputs() {
    // Empty, minimal, and one whose whitespace the normalizer has to collapse
    // exactly as JavaScript's `trim()` and `/\s+/g` did.
    assert_eq!(hash_block(""), "sha256:e3b0c44298fc1c149afbf4c8996fb924");
    assert_eq!(hash_block("a"), "sha256:ca978112ca1bbdcafac231b39a23dc4d");
    assert_eq!(
        hash_block("### Requirement: X\n\n  SHALL   do   a thing.  \n\n"),
        "sha256:de6ccfdf654424b1c08b9829bdf5d3a6"
    );
}

#[test]
fn slugs_agree_including_punctuation_and_non_ascii() {
    for (name, expected) in [
        ("Data export", "data-export"),
        ("Export notification", "export-notification"),
        ("Import", "import"),
        ("Theme selection!", "theme-selection"),
        ("  ", "unnamed"),
        ("C# interop", "c-interop"),
        // Lower-cased with Unicode semantics before the ASCII filter, exactly
        // as `String.prototype.toLowerCase` does.
        ("Ärger", "rger"),
    ] {
        assert_eq!(slugify(name), expected, "slugify({name:?})");
    }
}

#[test]
fn the_prose_and_the_scenario_splits_land_in_the_same_places() {
    let parsed = parse_spec_file(SPEC, &capability_from_path(SPEC_PATH), SPEC_PATH);

    assert_eq!(
        parsed.requirements[0].text,
        "The system SHALL let a user export their data in a portable format. The format\nis {{example: NDJSON}} until someone decides otherwise."
    );
    let scenarios: Vec<(&str, &[String])> = parsed.requirements[0]
        .scenarios()
        .iter()
        .map(|s| (s.name.as_str(), s.body.as_slice()))
        .collect();
    assert_eq!(
        scenarios,
        [
            (
                "Export succeeds",
                [
                    "- **WHEN** the user asks for an export".to_owned(),
                    "- **THEN** a file is produced".to_owned(),
                ]
                .as_slice()
            ),
            (
                "Export is empty",
                [
                    "- **WHEN** there is nothing to export".to_owned(),
                    "- **THEN** an empty file is produced, not an error".to_owned(),
                ]
                .as_slice()
            ),
        ]
    );

    // A blank line inside the prose survives, and the fenced block stays part
    // of the requirement's text rather than becoming a fourth requirement.
    assert_eq!(
        parsed.requirements[1].text,
        "The system SHALL notify the user when an export finishes.\n\nThe notification names the file."
    );
    assert!(parsed.requirements[2]
        .text
        .contains("### Requirement: Not a real requirement"));
    assert_eq!(
        parsed.requirements[2]
            .scenarios()
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["Round trip"]
    );
}

#[test]
fn a_requirement_heading_inside_a_code_fence_is_not_a_requirement() {
    let parsed = parse_spec_file(SPEC, &capability_from_path(SPEC_PATH), SPEC_PATH);
    // TypeScript found three. A parser that reads the fenced example finds
    // four, and shows the reviewer a requirement that does not exist.
    assert_eq!(parsed.requirements.len(), 3);
    assert!(!parsed
        .requirements
        .iter()
        .any(|r| r.name == "Not a real requirement"));
    assert!(!parsed
        .requirements
        .iter()
        .any(|r| r.scenarios().iter().any(|s| s.name == "Also fake")));
}

#[test]
fn the_rename_delta_is_read_the_same_way() {
    let parsed = parse_spec_file(SPEC, &capability_from_path(SPEC_PATH), SPEC_PATH);
    assert_eq!(parsed.renames.len(), 1);
    assert_eq!(parsed.renames[0].from, "Old name");
    assert_eq!(parsed.renames[0].to, "New name");
    assert_eq!(parsed.renames[0].capability, "export");
}

#[test]
fn the_marked_example_is_found_at_the_same_offsets() {
    use super::examples::{example_values, render_examples};
    let parsed = parse_spec_file(SPEC, &capability_from_path(SPEC_PATH), SPEC_PATH);
    let text = &parsed.requirements[0].text;
    assert_eq!(example_values(text), ["NDJSON"]);
    assert!(render_examples(text).contains("The format\nis NDJSON until someone"));
}

/// Lays the TypeScript-written sidecar out where `load_review` looks for it.
fn project_with_ts_sidecar() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    let review_dir = dir.path().join(".spec-tacular").join("review");
    fs::create_dir_all(&review_dir).expect("mkdir");
    fs::write(review_dir.join("compat.json"), SIDECAR).expect("write sidecar");
    dir
}

#[test]
fn a_sidecar_written_by_typescript_reconciles_to_the_same_states() {
    let dir = project_with_ts_sidecar();
    let parsed = parse_spec_file(SPEC, &capability_from_path(SPEC_PATH), SPEC_PATH);
    let review = load_review(dir.path(), "compat");
    let reviewed = reconcile(&parsed.requirements, &review);

    let seen: Vec<(&str, ReviewState, bool)> = reviewed
        .iter()
        .map(|r| (r.item.id.as_str(), r.state, r.drifted))
        .collect();
    // The third entry's stored hash was tampered with on the TypeScript side,
    // so both implementations must call it drift and force it back to pending.
    assert_eq!(
        seen,
        [
            ("export#data-export", ReviewState::Accepted, false),
            ("export#export-notification", ReviewState::Rejected, false),
            ("export#import", ReviewState::Pending, true),
        ]
    );

    let summary = summarize(&reviewed);
    assert_eq!(summary.total, 3);
    assert_eq!(summary.accepted, 1);
    assert_eq!(summary.rejected, 1);
    assert_eq!(summary.deferred, 0);
    assert_eq!(summary.pending, 1);
    assert_eq!(summary.drifted, 1);
    assert!(!summary.complete);
}

#[test]
fn the_notes_the_cursor_and_the_defer_reason_all_survive_the_crossing() {
    let dir = project_with_ts_sidecar();
    let review = load_review(dir.path(), "compat");

    assert_eq!(review.change, "compat");
    assert_eq!(review.schema_version, 1);
    assert_eq!(review.cursor_id(), Some("export#export-notification"));
    assert_eq!(
        review.requirements["export#export-notification"]
            .note
            .as_deref(),
        Some("too vague")
    );
    assert_eq!(
        review.requirements["export#import"].defer_reason.as_deref(),
        Some("awaiting-deployment")
    );
    assert_eq!(
        review.requirements["export#data-export"]
            .reviewed_at
            .as_deref(),
        Some("2026-09-22T21:18:18.639Z")
    );
}

#[test]
fn rewriting_a_typescript_sidecar_produces_the_same_bytes() {
    // The strongest form of the promise: open a project with the Rust binary,
    // save, and `git diff` is empty. Anything less and switching
    // implementations churns a committed file.
    let dir = project_with_ts_sidecar();
    let review = load_review(dir.path(), "compat");
    save_review(dir.path(), &review).expect("save");

    let written = fs::read_to_string(
        dir.path()
            .join(".spec-tacular")
            .join("review")
            .join("compat.json"),
    )
    .expect("read back");
    assert_eq!(written, SIDECAR);
}
