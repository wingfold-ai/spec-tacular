//! Flattens a change's spec deltas into one ordered review queue.
//!
//! This is the data the review loop walks: every requirement across every
//! capability in a change, in document order, each one independently
//! reviewable. The pile-of-files problem (docs/problem-analysis.md §3) is
//! solved here, not in the UI — the UI only shows one element of this list at
//! a time.

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::markdown::{
    build_code_fence_mask, normalize_content, normalize_requirement_name, normalized_lines,
    DELTA_HEADER, RENAME_FROM, RENAME_TO, REQUIREMENTS_HEADER, REQUIREMENT_HEADER, SCENARIO_HEADER,
    SECTION_HEADER,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DeltaOperation {
    Added,
    Modified,
    Removed,
    Renamed,
}

impl DeltaOperation {
    fn parse(word: &str) -> Option<Self> {
        match word.to_ascii_uppercase().as_str() {
            "ADDED" => Some(Self::Added),
            "MODIFIED" => Some(Self::Modified),
            "REMOVED" => Some(Self::Removed),
            "RENAMED" => Some(Self::Renamed),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Added => "ADDED",
            Self::Modified => "MODIFIED",
            Self::Removed => "REMOVED",
            Self::Renamed => "RENAMED",
        }
    }
}

impl fmt::Display for DeltaOperation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scenario {
    pub name: String,
    /// Body lines, verbatim, trailing blanks trimmed.
    pub body: Vec<String>,
}

/// Anything a human reviews one at a time.
///
/// A spec requirement and a design decision differ in what they say but not in
/// how they are reviewed: both are a named block of text that gets accepted,
/// rejected or deferred, and both must drop back to pending when edited. That
/// shared behaviour lives on this type so the two can never drift apart — the
/// review loop, the sidecar and drift detection are written once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewItem {
    /// `<group>#<slug>` — stable across edits that do not rename it.
    pub id: String,
    /// The capability for a requirement; `design` for a decision.
    pub capability: String,
    pub name: String,
    pub text: String,
    /// Path of the file it lives in.
    pub file: String,
    /// 1-based line of its header, so `$EDITOR` can jump to it.
    pub line: usize,
    /// Hash of the normalized block. Drift detection compares against this.
    pub hash: String,
    /// What makes this a requirement rather than a bare review item.
    ///
    /// TypeScript expressed this as a subtype and narrowed with a type guard;
    /// in Rust the same distinction is an optional payload on the one type, so
    /// the sidecar, the session and drift detection stay written once. `None`
    /// is a design decision or a Foundation ground rule.
    pub spec: Option<SpecDetail>,
}

/// The requirement-only half of a [`ReviewItem`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecDetail {
    pub operation: DeltaOperation,
    pub scenarios: Vec<Scenario>,
}

impl ReviewItem {
    /// Narrows a review item to a spec requirement.
    ///
    /// Needed wherever behaviour is requirement-specific — scenarios to
    /// render, prose to lint for premature concreteness. A design decision has
    /// neither.
    pub fn is_requirement(&self) -> bool {
        self.spec.is_some()
    }

    pub fn scenarios(&self) -> &[Scenario] {
        self.spec.as_ref().map_or(&[], |s| s.scenarios.as_slice())
    }

    pub fn operation(&self) -> Option<DeltaOperation> {
        self.spec.as_ref().map(|s| s.operation)
    }
}

/// A parsed requirement: a review item that is known to carry spec detail.
pub type Requirement = ReviewItem;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rename {
    pub from: String,
    pub to: String,
    pub capability: String,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedSpec {
    pub capability: String,
    pub requirements: Vec<Requirement>,
    pub renames: Vec<Rename>,
}

/// `Theme selection!` → `theme-selection`.
///
/// Lower-cased first, with full Unicode case folding, and only then reduced to
/// `[a-z0-9]`: `Ärger` and `ärger` have to produce the same id, or the same
/// requirement gets two entries in the sidecar depending on how it was typed.
pub fn slugify(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let trimmed = slug.trim_matches('-');
    // A name of only punctuation would otherwise collapse to the empty string
    // and collide with every other such name.
    if trimmed.is_empty() {
        "unnamed".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// Normalizes a requirement block for hashing.
///
/// Cosmetic edits — reflowing, trailing spaces, extra blank lines — must NOT
/// reset a human's acceptance, or the tool punishes people for tidying files.
/// Any change to the words must. So whitespace is collapsed and everything else
/// is preserved exactly, including case and punctuation.
pub fn normalize_for_hash(block: &str) -> String {
    normalize_content(block)
        .split('\n')
        .map(|line| {
            line.split(is_js_whitespace)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// ECMAScript's `\s`, character for character.
///
/// The hash has to be byte-identical to the TypeScript implementation's, or a
/// sidecar written by one and read by the other reports drift on every
/// requirement. Rust's `char::is_whitespace` is the Unicode `White_Space`
/// property, which differs from `\s` at exactly two characters: it excludes
/// U+FEFF and includes U+0085.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `sha256:` plus the first 32 hex digits of the normalized block's digest.
///
/// Truncated because it is a change detector, not a signature: 128 bits is far
/// past any accident, and the full digest only makes the sidecar harder to
/// read in a diff.
pub fn hash_block(block: &str) -> String {
    let digest = Sha256::digest(normalize_for_hash(block).as_bytes());
    let hex = hex::encode(digest);
    format!("sha256:{}", &hex[..32])
}

/// Splits a requirement's body into leading prose and its scenarios.
fn split_body(body_lines: &[String], mask: &[bool]) -> (String, Vec<Scenario>) {
    let mut text_lines: Vec<&str> = Vec::new();
    let mut scenarios: Vec<Scenario> = Vec::new();
    let mut current: Option<Scenario> = None;

    for (i, line) in body_lines.iter().enumerate() {
        if !mask[i] && SCENARIO_HEADER.is_match(line) {
            if let Some(done) = current.take() {
                scenarios.push(done);
            }
            current = Some(Scenario {
                // `#### Scenario: Foo` → `Foo`; a bare `#### Foo` keeps `Foo`.
                // Both forms appear in the wild, and neither should be dropped.
                name: normalize_requirement_name(&strip_scenario_prefix(line)),
                body: Vec::new(),
            });
            continue;
        }
        match current.as_mut() {
            Some(scenario) => scenario.body.push(line.clone()),
            None => text_lines.push(line),
        }
    }
    if let Some(done) = current.take() {
        scenarios.push(done);
    }

    for scenario in &mut scenarios {
        while scenario.body.last().is_some_and(|l| l.trim().is_empty()) {
            scenario.body.pop();
        }
    }

    (text_lines.join("\n").trim().to_owned(), scenarios)
}

/// `#### Scenario: Foo` → `Foo`, `#### Foo` → `Foo`.
fn strip_scenario_prefix(line: &str) -> String {
    let without_hashes = SCENARIO_HEADER.replace(line, "");
    let rest = without_hashes.as_ref();
    let lowered = rest.to_ascii_lowercase();
    match lowered.strip_prefix("scenario:") {
        Some(_) => rest["scenario:".len()..].trim_start().to_owned(),
        None => rest.to_owned(),
    }
}

/// Parses one delta spec file.
///
/// Handles both the delta form (`## ADDED Requirements`) and a main spec
/// (`## Requirements`), because the same review loop is used for both once a
/// change is archived.
pub fn parse_spec_file(content: &str, capability: &str, file: &str) -> ParsedSpec {
    let lines = normalized_lines(content);
    let mask = build_code_fence_mask(&lines);

    let mut requirements: Vec<Requirement> = Vec::new();
    let mut renames: Vec<Rename> = Vec::new();
    // Slug collisions inside one capability would silently merge two
    // requirements into one review entry, so they are disambiguated instead.
    let mut seen: HashMap<String, usize> = HashMap::new();

    let mut operation: Option<DeltaOperation> = None;

    let mut i = 0;
    while i < lines.len() {
        let line = &lines[i];
        if mask[i] {
            i += 1;
            continue;
        }

        if let Some(delta) = DELTA_HEADER.captures(line) {
            operation = DeltaOperation::parse(&delta[1]);
            i += 1;
            continue;
        }
        if REQUIREMENTS_HEADER.is_match(line) {
            // A main spec's requirements are the accepted baseline. They are
            // surfaced as ADDED so the queue shape stays uniform.
            operation = Some(DeltaOperation::Added);
            i += 1;
            continue;
        }
        // Any other `## ` header (`## Purpose`, `## Impact`) ends the current
        // section. Without this, prose after a delta section would be swept
        // into the last requirement.
        if SECTION_HEADER.is_match(line) {
            operation = None;
            i += 1;
            continue;
        }

        if operation == Some(DeltaOperation::Renamed) {
            if let Some(from) = RENAME_FROM.captures(line) {
                // A FROM is only a rename once its TO arrives; an unpaired one
                // is malformed and is dropped rather than guessed at.
                if let Some(to) = find_next_to(&lines, &mask, i) {
                    renames.push(Rename {
                        from: normalize_requirement_name(&from[1]),
                        to,
                        capability: capability.to_owned(),
                    });
                }
            }
            i += 1;
            continue;
        }

        let Some(operation) = operation else {
            i += 1;
            continue;
        };

        let Some(header) = REQUIREMENT_HEADER.captures(line) else {
            i += 1;
            continue;
        };

        let name = normalize_requirement_name(&header[1]);
        let mut body_lines: Vec<String> = Vec::new();
        let mut body_mask: Vec<bool> = Vec::new();
        let mut j = i + 1;
        while j < lines.len() {
            let next = &lines[j];
            if !mask[j] && (REQUIREMENT_HEADER.is_match(next) || SECTION_HEADER.is_match(next)) {
                break;
            }
            body_lines.push(next.clone());
            body_mask.push(mask[j]);
            j += 1;
        }

        let (text, scenarios) = split_body(&body_lines, &body_mask);

        let base = slugify(&name);
        let count = seen.entry(base.clone()).or_insert(0);
        *count += 1;
        let slug = if *count == 1 {
            base
        } else {
            format!("{base}~{count}")
        };

        let mut block = String::with_capacity(line.len() + body_lines.len() * 16);
        block.push_str(line);
        for body_line in &body_lines {
            block.push('\n');
            block.push_str(body_line);
        }

        requirements.push(ReviewItem {
            id: format!("{capability}#{slug}"),
            capability: capability.to_owned(),
            name,
            text,
            file: file.to_owned(),
            line: i + 1,
            hash: hash_block(&block),
            spec: Some(SpecDetail {
                operation,
                scenarios,
            }),
        });

        i = j;
    }

    ParsedSpec {
        capability: capability.to_owned(),
        requirements,
        renames,
    }
}

/// The next `TO:` before any further `FROM:`. Mirrors OpenSpec's pairing rule.
fn find_next_to(lines: &[String], mask: &[bool], from: usize) -> Option<String> {
    for i in (from + 1)..lines.len() {
        let line = &lines[i];
        if mask[i] {
            continue;
        }
        if SECTION_HEADER.is_match(line) || RENAME_FROM.is_match(line) {
            return None;
        }
        if let Some(to) = RENAME_TO.captures(line) {
            return Some(normalize_requirement_name(&to[1]));
        }
    }
    None
}

/// The capability path for a spec file: its directory relative to `specs/`.
pub fn capability_from_path(spec_path: &str) -> String {
    let normalized = spec_path.replace('\\', "/");
    const MARKER: &str = "/specs/";
    let tail = match normalized.rfind(MARKER) {
        Some(at) => &normalized[at + MARKER.len()..],
        None => normalized.as_str(),
    };
    // Strip the file name — but only a real one. A path ending in `/` has no
    // file to strip, so nothing names the capability, and inventing one would
    // key review state on a guess.
    match tail.rfind('/') {
        Some(at) if at + 1 < tail.len() => tail[..at].to_owned(),
        _ => "unknown".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(md: &str) -> ParsedSpec {
        parse_with_capability(md, "cap")
    }

    fn parse_with_capability(md: &str, cap: &str) -> ParsedSpec {
        parse_spec_file(md, cap, &format!("/p/specs/{cap}/spec.md"))
    }

    fn names(spec: &ParsedSpec) -> Vec<&str> {
        spec.requirements.iter().map(|r| r.name.as_str()).collect()
    }

    #[test]
    fn reads_requirements_prose_and_scenarios_from_a_delta_section() {
        let spec = parse(
            "## ADDED Requirements\n\n\
             ### Requirement: Theme selection\n\
             The app SHALL let users switch themes.\n\n\
             #### Scenario: User toggles\n\
             - **WHEN** clicked\n\
             - **THEN** it switches\n",
        );
        assert_eq!(spec.requirements.len(), 1);
        let r = &spec.requirements[0];
        assert_eq!(r.name, "Theme selection");
        assert_eq!(r.operation(), Some(DeltaOperation::Added));
        assert_eq!(r.text, "The app SHALL let users switch themes.");
        assert_eq!(r.scenarios().len(), 1);
        assert_eq!(r.scenarios()[0].name, "User toggles");
        assert_eq!(
            r.scenarios()[0].body,
            vec!["- **WHEN** clicked", "- **THEN** it switches"]
        );
        assert_eq!(r.id, "cap#theme-selection");
        assert_eq!(r.line, 3);
    }

    #[test]
    fn tracks_the_operation_of_each_delta_section_independently() {
        let spec = parse(
            "## ADDED Requirements\n\n### Requirement: A\na\n\n\
             ## MODIFIED Requirements\n\n### Requirement: B\nb\n\n\
             ## REMOVED Requirements\n\n### Requirement: C\nc\n",
        );
        let got: Vec<_> = spec
            .requirements
            .iter()
            .map(|r| (r.name.as_str(), r.operation().expect("a requirement")))
            .collect();
        assert_eq!(
            got,
            vec![
                ("A", DeltaOperation::Added),
                ("B", DeltaOperation::Modified),
                ("C", DeltaOperation::Removed),
            ]
        );
    }

    #[test]
    fn ignores_requirements_inside_fenced_code_blocks() {
        // The schema's own instructions show example requirements in fences, so
        // a parser without fence masking invents requirements on nearly every
        // spec.
        let spec = parse(
            "## ADDED Requirements\n\n\
             ### Requirement: Real\nreal\n\n\
             ```markdown\n\
             ### Requirement: Fake\nnot real\n\n\
             #### Scenario: Fake scenario\n\
             ```\n",
        );
        assert_eq!(names(&spec), vec!["Real"]);
        assert!(spec.requirements[0].scenarios().is_empty());
    }

    #[test]
    fn a_non_delta_section_ends_the_current_one() {
        let spec = parse(
            "## ADDED Requirements\n\n### Requirement: A\na\n\n\
             ## Impact\n\nSome prose that must not be swallowed.\n\n\
             ### Requirement: NotARequirement\n",
        );
        assert_eq!(names(&spec), vec!["A"]);
        assert_eq!(spec.requirements[0].text, "a");
    }

    #[test]
    fn reads_a_main_spec_requirements_section() {
        let spec =
            parse("## Purpose\n\nSomething.\n\n## Requirements\n\n### Requirement: Baseline\nb\n");
        assert_eq!(names(&spec), vec!["Baseline"]);
        assert_eq!(
            spec.requirements[0].operation(),
            Some(DeltaOperation::Added)
        );
    }

    #[test]
    fn normalizes_crlf_and_a_bom() {
        let spec = parse("\u{feff}## ADDED Requirements\r\n\r\n### Requirement: A\r\ntext\r\n");
        assert_eq!(spec.requirements.len(), 1);
        assert_eq!(spec.requirements[0].text, "text");
    }

    #[test]
    fn accepts_a_squished_header_case_insensitively() {
        let spec = parse("## added requirements\n\n###requirement: Squished\nx\n");
        assert_eq!(names(&spec), vec!["Squished"]);
    }

    #[test]
    fn strips_a_closing_run_of_hashes_but_keeps_a_trailing_hash_in_a_name() {
        assert_eq!(
            parse("## ADDED Requirements\n\n### Requirement: Foo ###\nx\n").requirements[0].name,
            "Foo"
        );
        assert_eq!(
            parse("## ADDED Requirements\n\n### Requirement: C#\nx\n").requirements[0].name,
            "C#"
        );
    }

    #[test]
    fn disambiguates_requirement_names_that_slugify_identically() {
        // Without this they would share one id and silently merge into one
        // review entry, hiding a requirement from the human entirely.
        let spec = parse(
            "## ADDED Requirements\n\n### Requirement: Log in\na\n\n### Requirement: Log-in\nb\n",
        );
        let ids: Vec<_> = spec.requirements.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["cap#log-in", "cap#log-in~2"]);
    }

    #[test]
    fn a_bare_fourth_level_header_is_still_a_scenario_boundary() {
        let spec = parse(
            "## ADDED Requirements\n\n### Requirement: A\nprose\n\n#### Not prefixed\n- body\n",
        );
        assert_eq!(spec.requirements[0].text, "prose");
        assert_eq!(spec.requirements[0].scenarios()[0].name, "Not prefixed");
    }

    #[test]
    fn an_empty_document_yields_nothing_rather_than_failing() {
        assert!(parse("").requirements.is_empty());
        assert!(parse("# Spec Delta\n").requirements.is_empty());
    }

    #[test]
    fn pairs_from_with_its_following_to() {
        let spec = parse(
            "## RENAMED Requirements\n\n\
             - FROM: `### Requirement: Old name`\n\
             - TO: `### Requirement: New name`\n",
        );
        assert_eq!(
            spec.renames,
            vec![Rename {
                from: "Old name".to_owned(),
                to: "New name".to_owned(),
                capability: "cap".to_owned(),
            }]
        );
    }

    #[test]
    fn drops_a_from_displaced_by_another_from_before_its_to() {
        let spec = parse(
            "## RENAMED Requirements\n\n\
             - FROM: `### Requirement: A`\n\
             - FROM: `### Requirement: B`\n\
             - TO: `### Requirement: B2`\n",
        );
        assert_eq!(spec.renames.len(), 1);
        assert_eq!(spec.renames[0].from, "B");
        assert_eq!(spec.renames[0].to, "B2");
    }

    #[test]
    fn drops_an_unpaired_trailing_from() {
        let spec = parse("## RENAMED Requirements\n\n- FROM: `### Requirement: A`\n");
        assert!(spec.renames.is_empty());
    }

    #[test]
    fn a_renamed_section_produces_no_requirements() {
        let spec = parse(
            "## RENAMED Requirements\n\n- FROM: `### Requirement: A`\n- TO: `### Requirement: B`\n",
        );
        assert!(spec.requirements.is_empty());
    }

    #[test]
    fn cosmetic_whitespace_changes_do_not_change_the_hash() {
        // Reformatting a file must not silently revoke a human's acceptance.
        let a = "### Requirement: A\nThe system SHALL work.\n";
        let b = "### Requirement: A\n\n\nThe  system   SHALL work.   \n\n";
        assert_eq!(hash_block(a), hash_block(b));
    }

    #[test]
    fn a_word_change_does_change_the_hash() {
        assert_ne!(
            hash_block("### Requirement: A\nSHALL work."),
            hash_block("### Requirement: A\nSHALL NOT work.")
        );
    }

    #[test]
    fn case_is_significant() {
        assert_ne!(normalize_for_hash("SHALL"), normalize_for_hash("shall"));
    }

    #[test]
    fn a_hash_is_a_prefixed_thirty_two_digit_hex_digest() {
        let hash = hash_block("anything");
        let hex = hash.strip_prefix("sha256:").expect("the sha256: prefix");
        assert_eq!(hex.len(), 32);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn slugify_handles_punctuation_and_all_punctuation_names() {
        assert_eq!(slugify("Theme selection!"), "theme-selection");
        assert_eq!(slugify("  A / B  "), "a-b");
        assert_eq!(slugify("!!!"), "unnamed");
    }

    #[test]
    fn capability_from_path_keeps_nested_capability_paths() {
        assert_eq!(
            capability_from_path("/p/changes/c/specs/user-auth/spec.md"),
            "user-auth"
        );
        assert_eq!(
            capability_from_path("/p/changes/c/specs/identity/user-auth/spec.md"),
            "identity/user-auth"
        );
        assert_eq!(
            capability_from_path("C:\\p\\specs\\cli-view\\spec.md"),
            "cli-view"
        );
    }

    #[test]
    fn capability_from_path_falls_back_when_nothing_names_one() {
        assert_eq!(capability_from_path("spec.md"), "unknown");
        // A trailing separator names a directory, not a file, so there is no
        // file name to strip and nothing to call the capability.
        assert_eq!(capability_from_path("/p/specs/foo/"), "unknown");
    }

    #[test]
    fn slugs_fold_case_the_way_javascript_does() {
        // The id is what keys review state, so `Ärger` and `ärger` have to
        // produce one entry rather than two.
        assert_eq!(slugify("\u{c4}rger"), slugify("\u{e4}rger"));
        assert_eq!(slugify("C# interop"), "c-interop");
    }

    #[test]
    fn the_hash_collapses_every_whitespace_javascript_collapses() {
        // U+FEFF is whitespace to `\s` but not to Rust's `char::is_whitespace`;
        // U+0085 is the other way round. Both have to land on the JavaScript
        // side, or a sidecar crossing implementations reports phantom drift.
        assert_eq!(
            hash_block("a\u{feff}b"),
            hash_block("a b"),
            "U+FEFF must collapse like a space"
        );
        assert_ne!(
            hash_block("a\u{85}b"),
            hash_block("a b"),
            "U+0085 is not whitespace to JavaScript"
        );
    }
}
