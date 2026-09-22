//! The concreteness linter.
//!
//! Flags values a requirement names that the project may not have decided yet:
//! endpoints, identifiers, file paths, library names. It cannot know whether
//! any given one is a real contract — for a CLI tool the command names *are*
//! the contract — so it is advisory by construction and never blocks a stage.
//! Its job is to put the question in front of a human at review time, where it
//! is one keystroke to answer.
//!
//! Anything inside `{{example: ...}}` is never flagged: that is the reviewer
//! having already answered.

use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use super::examples::{find_examples, is_inside_example, ExampleSpan};
use super::requirements::Requirement;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FindingKind {
    HttpEndpoint,
    UrlPath,
    Identifier,
    FilePath,
}

impl FindingKind {
    /// The name the TypeScript implementation used, kept so the two can be
    /// compared value-for-value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HttpEndpoint => "http-endpoint",
            Self::UrlPath => "url-path",
            Self::Identifier => "identifier",
            Self::FilePath => "file-path",
        }
    }
}

impl fmt::Display for FindingKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub kind: FindingKind,
    /// The flagged text, exactly as it appears — so it can be marked as an
    /// example.
    pub value: String,
    /// Byte offset into the text that was scanned.
    pub offset: usize,
    /// What to ask the reviewer.
    pub question: &'static str,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LintConfig {
    /// Values never flagged. Matched case-insensitively against the whole
    /// token, so a project can silence the vocabulary it genuinely owns.
    pub allow: Vec<String>,
    /// Technologies the project has committed to, read from the Foundation
    /// stack.
    ///
    /// There is no rule that flags library names, because no list of every
    /// library exists. The stack works the other way round: naming something
    /// the project already chose is a decision made, so it is never flagged.
    pub stack: Vec<String>,
}

impl LintConfig {
    /// The configuration that silences nothing.
    pub fn empty() -> Self {
        Self::default()
    }
}

struct Rule {
    kind: FindingKind,
    pattern: Regex,
    question: &'static str,
    /// Only flag when the match sits inside backticks.
    ///
    /// Used for PascalCase, where prose and code are otherwise
    /// indistinguishable: `PowerShell`, `OpenCode` and `CodeBuddy` are product
    /// names a spec is entitled to use, while `ToolCommandAdapter` is an
    /// internal class. Authors reliably backtick the latter and not the
    /// former, which is a better signal than anything the shape of the word
    /// provides.
    code_only: bool,
    /// Reject a match whose preceding byte is one of these.
    ///
    /// JavaScript wrote this as a lookbehind, which Rust's `regex` does not
    /// have by design. The check is the same assertion, applied to the byte
    /// before the match: because it consumes nothing, the set of match
    /// positions is identical to the lookbehind's.
    not_preceded_by: &'static str,
}

fn rule(kind: FindingKind, pattern: &str, question: &'static str) -> Rule {
    Rule {
        kind,
        pattern: Regex::new(pattern).expect("built-in pattern must compile"),
        question,
        code_only: false,
        not_preceded_by: "",
    }
}

const HTTP_VERBS: &str = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    vec![
        // A verb followed by a path is the clearest case of an interface being
        // decided inside a requirement.
        rule(
            FindingKind::HttpEndpoint,
            &format!(r"\b({HTTP_VERBS})\s+(/[A-Za-z0-9._~\-/{{}}:]*)"),
            "names an HTTP endpoint",
        ),
        // At least two segments: `/users/{id}`. One segment is usually prose
        // ("the /tmp directory") or a CLI path, and flagging it is noise.
        Rule {
            not_preceded_by: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-",
            ..rule(
                FindingKind::UrlPath,
                r"(/[A-Za-z0-9._~\-{}]+){2,}/?",
                "names a URL or path",
            )
        },
        // Starts lowercase: `skillsDir`, `existingOutputPaths`. No English word
        // has this shape, so prose never collides with it.
        rule(
            FindingKind::Identifier,
            r"\b[a-z][a-z0-9]*([A-Z][a-z0-9]*)+\b",
            "names a field or symbol",
        ),
        // Starts uppercase: `ToolCommandAdapter`, but also `PowerShell`. Only
        // flagged in code formatting — see `code_only`.
        Rule {
            code_only: true,
            ..rule(
                FindingKind::Identifier,
                r"\b[A-Z][a-z0-9]+([A-Z][a-z0-9]*)+\b",
                "names a class or symbol",
            )
        },
        rule(
            FindingKind::Identifier,
            r"\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b",
            "names a field or table",
        ),
        rule(
            FindingKind::FilePath,
            r"\b[\w.\-]+\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|sql|yaml|yml|json|toml|md)\b",
            "names a file",
        ),
    ]
});

/// Tokens shaped like findings that never are.
///
/// Platform and product names are the awkward case: `macOS` and `iOS` have the
/// exact shape of a camelCase symbol. They are spelled that way by convention,
/// not because anyone decided an interface.
static NEVER_FLAG: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "openspec",
        "spec",
        "specs",
        "readme",
        "javascript",
        "typescript",
        "github",
        "gitlab",
        "macos",
        "ios",
        "ipados",
        "watchos",
        "tvos",
        "youtube",
        "paypal",
        "ebay",
    ]
    .into_iter()
    .collect()
});

/// `Node.js`, `Vue.js`, `Next.js` — a framework, not a file.
///
/// A single capitalised word before the extension. Real file references are
/// lowercase, kebab, snake, all-caps (`README.md`) or multi-cap
/// (`CommandContent.ts`), none of which match.
fn is_product_name(value: &str) -> bool {
    static PRODUCT_NAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Z][a-z]+\.[a-z]+$").expect("built-in pattern"));
    PRODUCT_NAME.is_match(value)
}

fn trim_sentence_punctuation(value: &str) -> &str {
    value.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']'])
}

fn allowed(value: &str, config: &LintConfig) -> bool {
    let lower = value.to_lowercase();
    if NEVER_FLAG.contains(lower.as_str()) {
        return true;
    }
    if config.allow.iter().any(|a| a.to_lowercase() == lower) {
        return true;
    }
    // A library the project already committed to is a decision, not a guess.
    config.stack.iter().any(|s| s.to_lowercase() == lower)
}

/// Spans covered by inline code, so `x` can be told from plain prose.
fn backtick_spans(text: &str) -> Vec<(usize, usize)> {
    static INLINE_CODE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"`+[^`]*`+").expect("built-in pattern"));
    INLINE_CODE
        .find_iter(text)
        .map(|m| (m.start(), m.end()))
        .collect()
}

/// Scans one block of text.
///
/// Overlapping matches are collapsed: `POST /v1/export` should read as one
/// endpoint finding, not also as a bare path.
pub fn lint_text(text: &str, config: &LintConfig) -> Vec<Finding> {
    let examples: Vec<ExampleSpan> = find_examples(text);
    let code = backtick_spans(text);
    let in_code = |offset: usize| code.iter().any(|(s, e)| offset >= *s && offset < *e);

    let mut found: Vec<Finding> = Vec::new();
    let mut claimed: Vec<(usize, usize)> = Vec::new();

    for rule in RULES.iter() {
        for m in rule.pattern.find_iter(text) {
            let start = m.start();

            if !rule.not_preceded_by.is_empty() {
                let before = text[..start].chars().next_back();
                if before.is_some_and(|c| rule.not_preceded_by.contains(c)) {
                    continue;
                }
            }

            // A path's charset includes `.`, which otherwise swallows the
            // sentence's full stop — and the value has to be exact, because it
            // is what gets wrapped in `{{example: ...}}`.
            let value = trim_sentence_punctuation(m.as_str());
            if value.trim().is_empty() {
                continue;
            }
            let end = start + value.len();

            if is_inside_example(&examples, start) {
                continue;
            }
            if rule.code_only && !in_code(start) {
                continue;
            }
            if claimed.iter().any(|(s, e)| start < *e && end > *s) {
                continue;
            }
            if allowed(value, config) {
                continue;
            }
            if rule.kind == FindingKind::FilePath && is_product_name(value) {
                continue;
            }

            claimed.push((start, end));
            found.push(Finding {
                kind: rule.kind,
                value: value.trim().to_owned(),
                offset: start,
                question: rule.question,
            });
        }
    }

    found.sort_by_key(|f| f.offset);
    found
}

/// Scans a requirement's prose and every scenario body.
pub fn lint_requirement(requirement: &Requirement, config: &LintConfig) -> Vec<Finding> {
    let mut parts: Vec<&str> = vec![requirement.text.as_str()];
    for scenario in requirement.scenarios() {
        parts.extend(scenario.body.iter().map(String::as_str));
    }
    parts
        .into_iter()
        .flat_map(|part| lint_text(part, config))
        .collect()
}

/// Loads the per-project tuning.
///
/// `spec-tacular/lint.json` holds the allowlist: the vocabulary a project
/// genuinely owns and should stop being asked about. It is committed and
/// hand-edited, because only a human knows which of its own nouns are
/// contracts.
///
/// The stack comes from the Foundation. Every backticked token in
/// `foundation/stack.md` counts as a committed technology — authors reliably
/// mark them that way, and it needs no schema of its own.
pub fn load_lint_config(project_root: impl AsRef<Path>) -> LintConfig {
    let root = project_root.as_ref();

    // A broken lint config must not stop a review. The cost of ignoring it is
    // a few extra questions, which is the linter's whole failure mode.
    let allow = fs::read_to_string(root.join("spec-tacular").join("lint.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|parsed| parsed.get("allow")?.as_array().cloned())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();

    static BACKTICKED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"`([^`\n]+)`").expect("built-in pattern"));
    let stack = fs::read_to_string(
        root.join("spec-tacular")
            .join("foundation")
            .join("stack.md"),
    )
    .map(|content| {
        BACKTICKED
            .captures_iter(&content)
            .filter_map(|caps| {
                let token = caps.get(1)?.as_str().trim();
                (!token.is_empty()).then(|| token.to_owned())
            })
            .collect()
    })
    .unwrap_or_default();

    LintConfig { allow, stack }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::requirements::parse_spec_file;

    fn values(text: &str) -> Vec<String> {
        values_with(text, &LintConfig::empty())
    }

    fn values_with(text: &str, config: &LintConfig) -> Vec<String> {
        lint_text(text, config)
            .into_iter()
            .map(|f| f.value)
            .collect()
    }

    fn kinds(text: &str) -> Vec<FindingKind> {
        lint_text(text, &LintConfig::empty())
            .into_iter()
            .map(|f| f.kind)
            .collect()
    }

    // ---- what it flags -----------------------------------------------------

    #[test]
    fn an_http_endpoint() {
        assert_eq!(
            values("The system SHALL expose POST /v1/export."),
            ["POST /v1/export"]
        );
        assert_eq!(
            kinds("GET /users/{id} returns a user."),
            [FindingKind::HttpEndpoint]
        );
    }

    #[test]
    fn a_multi_segment_path() {
        assert_eq!(values("Writes to /var/lib/things."), ["/var/lib/things"]);
    }

    #[test]
    fn a_camel_case_field_or_symbol() {
        assert_eq!(
            values("The response carries existingOutputPaths."),
            ["existingOutputPaths"]
        );
    }

    #[test]
    fn a_snake_case_field() {
        assert_eq!(values("Stores the user_email column."), ["user_email"]);
    }

    #[test]
    fn a_code_file() {
        assert_eq!(values("Implemented in exporter.ts."), ["exporter.ts"]);
    }

    #[test]
    fn scans_scenarios_as_well_as_prose() {
        let parsed = parse_spec_file(
            "## ADDED Requirements

### Requirement: Export
The system SHALL export data.

#### Scenario: Works
- **WHEN** the user calls POST /v1/export
- **THEN** a file appears
",
            "cap",
            "/p/specs/cap/spec.md",
        );
        let found = lint_requirement(&parsed.requirements[0], &LintConfig::empty());
        assert_eq!(
            found.iter().map(|f| f.value.as_str()).collect::<Vec<_>>(),
            ["POST /v1/export"]
        );
    }

    // ---- what it does not flag --------------------------------------------

    #[test]
    fn ordinary_prose() {
        assert!(
            values("The system SHALL let a user export their data in a portable format.")
                .is_empty()
        );
    }

    #[test]
    fn anything_already_marked_as_an_example() {
        // The reviewer already answered the question.
        assert!(values("SHALL expose an endpoint {{example: POST /v1/export}}.").is_empty());
    }

    #[test]
    fn a_single_segment_path_which_is_usually_prose() {
        assert!(values("Writes to the /tmp directory.").is_empty());
    }

    #[test]
    fn a_pascal_case_word_in_prose_is_probably_a_product_name() {
        // PowerShell and OpenCode are names a spec may legitimately use; only
        // code formatting distinguishes them from an internal class.
        assert!(values("Runs under PowerShell and OpenCode.").is_empty());
    }

    #[test]
    fn but_does_flag_pascal_case_in_code_formatting() {
        assert_eq!(
            values("Dispatches through `ToolCommandAdapter`."),
            ["ToolCommandAdapter"]
        );
    }

    #[test]
    fn a_framework_that_merely_looks_like_a_file() {
        // `Node.js` is not a file. Real file references are lowercase, kebab,
        // all-caps or multi-cap — none of which is a single capitalised word.
        assert!(values("Requires Node.js 20.").is_empty());
        assert!(values("Built with Next.js.").is_empty());
    }

    #[test]
    fn platform_names_shaped_like_camel_case() {
        assert!(values("Runs on macOS and iOS.").is_empty());
    }

    #[test]
    fn an_acronym() {
        assert!(values("Returns HTTP and JSON.").is_empty());
    }

    #[test]
    fn a_value_on_the_project_allowlist() {
        let config = LintConfig {
            allow: vec!["tasks.md".to_owned()],
            stack: Vec::new(),
        };
        assert!(values_with("Writes tasks.md.", &config).is_empty());
    }

    #[test]
    fn a_technology_the_project_already_committed_to() {
        // Naming the stack is a decision made, not a premature one.
        let config = LintConfig {
            allow: Vec::new(),
            stack: vec!["Postgres".to_owned()],
        };
        assert!(values_with("Persists via `Postgres`.", &config).is_empty());
    }

    #[test]
    fn the_allowlist_is_case_insensitive() {
        let config = LintConfig {
            allow: vec!["tasks.md".to_owned()],
            stack: Vec::new(),
        };
        assert!(values_with("Writes TASKS.MD.", &config).is_empty());
    }

    // ---- overlaps ----------------------------------------------------------

    #[test]
    fn an_endpoint_is_one_finding_not_also_a_bare_path() {
        let findings = lint_text("SHALL expose POST /v1/export today.", &LintConfig::empty());
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, FindingKind::HttpEndpoint);
    }

    #[test]
    fn findings_come_back_in_document_order() {
        assert_eq!(
            values("First userName then POST /a/b then other_field."),
            ["userName", "POST /a/b", "other_field"]
        );
    }

    // ---- it is advisory ----------------------------------------------------

    #[test]
    fn it_reports_it_does_not_judge() {
        // Every finding is a question for a human, because the linter cannot
        // know whether a value is a real contract — for a CLI, command names
        // are.
        let findings = lint_text(
            "SHALL expose POST /v1/x with user_id in `Thing`.",
            &LintConfig::empty(),
        );
        assert!(!findings.is_empty());
        for finding in findings {
            assert!(finding.question.starts_with("names "));
        }
    }

    #[test]
    fn empty_text_is_no_findings_not_an_error() {
        assert!(lint_text("", &LintConfig::empty()).is_empty());
    }

    // ---- loadLintConfig ----------------------------------------------------

    #[test]
    fn reads_the_project_allowlist() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        fs::create_dir_all(root.join("spec-tacular")).expect("mkdir");
        fs::write(
            root.join("spec-tacular").join("lint.json"),
            r#"{"allow":["tasks.md"]}"#,
        )
        .expect("write");
        assert_eq!(load_lint_config(root).allow, ["tasks.md"]);
    }

    #[test]
    fn reads_committed_technologies_from_the_foundation_stack() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        fs::create_dir_all(root.join("spec-tacular").join("foundation")).expect("mkdir");
        fs::write(
            root.join("spec-tacular")
                .join("foundation")
                .join("stack.md"),
            "# Stack\n\nRuntime: `Bun`. Database: `Postgres`.\n",
        )
        .expect("write");
        let config = load_lint_config(root);
        assert_eq!(config.stack, ["Bun", "Postgres"]);
        // And naming one is then a decision made, not a premature one.
        assert!(lint_text("Persists via `Postgres`.", &config).is_empty());
    }

    #[test]
    fn an_absent_config_is_empty_not_an_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert_eq!(load_lint_config(dir.path()), LintConfig::empty());
    }

    #[test]
    fn a_broken_config_degrades_rather_than_stopping_a_review() {
        // The cost of ignoring it is a few extra questions, which is the
        // linter's whole failure mode anyway.
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        fs::create_dir_all(root.join("spec-tacular")).expect("mkdir");
        fs::write(root.join("spec-tacular").join("lint.json"), "{not json").expect("write");
        assert!(load_lint_config(root).allow.is_empty());
    }

    #[test]
    fn non_string_allowlist_entries_are_ignored() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        fs::create_dir_all(root.join("spec-tacular")).expect("mkdir");
        fs::write(
            root.join("spec-tacular").join("lint.json"),
            r#"{"allow":["ok",42,null]}"#,
        )
        .expect("write");
        assert_eq!(load_lint_config(root).allow, ["ok"]);
    }
}
