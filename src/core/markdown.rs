//! Markdown primitives, deliberately mirroring OpenSpec's own parsers.
//!
//! These patterns and normalization rules are ported from
//! `src/core/parsers/{requirement-blocks,requirement-text,spec-structure,code-fence}.ts`
//! in @fission-ai/openspec. spec-tacular must agree with OpenSpec about what a
//! requirement *is* — a requirement this parser cannot see is one a human can
//! never review, and one it invents is one that does not exist. Any divergence
//! here is a bug, so the rules are kept together and cited rather than
//! re-derived.

use std::sync::LazyLock;

use regex::Regex;

/// Declares a lazily compiled pattern.
///
/// The pattern is part of the program's source, so a compile failure is a bug
/// in this file rather than anything a user can provoke — which is the one
/// place a panic is the honest response.
macro_rules! pattern {
    ($(#[$meta:meta])* $name:ident, $re:expr) => {
        $(#[$meta])*
        pub static $name: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new($re).expect("built-in pattern must compile")
        });
    };
}
pub(crate) use pattern;

pattern!(
    /// `## ADDED Requirements` and friends.
    DELTA_HEADER,
    r"(?i)^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$"
);

pattern!(
    /// `## Requirements`, the main (non-delta) spec section.
    REQUIREMENTS_HEADER,
    r"(?i)^##\s+Requirements\s*$"
);

pattern!(
    /// Any `## ` section header.
    SECTION_HEADER,
    r"^##\s+"
);

pattern!(
    /// `### Requirement: <name>`. The missing space in `###Requirement:` is accepted.
    REQUIREMENT_HEADER,
    r"(?i)^###\s*Requirement:\s*(.+)\s*$"
);

pattern!(
    /// `#### Scenario: <name>` — and any other `#### ` header inside a requirement.
    SCENARIO_HEADER,
    r"^####\s+"
);

pattern!(
    /// ``FROM: `### Requirement: <name>` `` in a RENAMED section.
    RENAME_FROM,
    r"^\s*[-*+]?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$"
);

pattern!(
    /// ``TO: `### Requirement: <name>` `` in a RENAMED section.
    RENAME_TO,
    r"^\s*[-*+]?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$"
);

/// Strips a leading BOM and normalizes CRLF/CR to LF.
pub fn normalize_content(content: &str) -> String {
    let body = content.strip_prefix('\u{feff}').unwrap_or(content);

    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            // `\r\n` and a lone `\r` both collapse to one `\n`.
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

/// `normalize_content`, already split into lines.
///
/// Everything downstream works line by line, and splitting on `\n` after the
/// CR normalization is the only correct order — the other way round leaves a
/// stray `\r` at the end of every line of a Windows-authored spec.
pub fn normalized_lines(content: &str) -> Vec<String> {
    normalize_content(content)
        .split('\n')
        .map(str::to_owned)
        .collect()
}

/// An ATX heading may close with a run of `#`. `### Requirement: Foo ###` names
/// `Foo`, but `C#` keeps its `#` — only a run preceded by a space or tab closes
/// the heading, which is why this is `[ \t]` and not `\s`.
pub fn normalize_requirement_name(name: &str) -> String {
    static CLOSING_HASHES: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[ \t]+#+[ \t]*$").expect("built-in pattern must compile"));
    CLOSING_HASHES.replace(name, "").trim().to_owned()
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ActiveFence {
    marker: char,
    length: usize,
}

/// The `` ``` `` or `~~~` that opens a fence, plus its length: a longer run is
/// needed to close it, which is how a fence can contain a shorter one.
fn opening_fence(line: &str) -> Option<ActiveFence> {
    let run = fence_run(line)?;
    Some(ActiveFence {
        marker: run.0,
        length: run.1,
    })
}

fn closes_fence(line: &str, fence: ActiveFence) -> bool {
    // A closing fence carries nothing but whitespace after the run.
    match fence_run(line) {
        Some((marker, length)) => {
            let after = line.trim_start().trim_start_matches(marker);
            after.trim().is_empty() && marker == fence.marker && length >= fence.length
        }
        None => false,
    }
}

/// The leading run of at least three backticks or tildes, if the line has one.
fn fence_run(line: &str) -> Option<(char, usize)> {
    let rest = line.trim_start();
    let marker = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let length = rest.chars().take_while(|c| *c == marker).count();
    (length >= 3).then_some((marker, length))
}

/// Per-line mask marking lines inside a fenced code block, fences included.
///
/// Without this, a `### Requirement:` shown as an *example* inside a fenced
/// block — which the schema's own instructions do — parses as a real
/// requirement. OpenSpec had exactly that bug; the mask is how it was fixed.
pub fn build_code_fence_mask<S: AsRef<str>>(lines: &[S]) -> Vec<bool> {
    let mut mask = vec![false; lines.len()];
    let mut active: Option<ActiveFence> = None;

    for (i, line) in lines.iter().enumerate() {
        let line = line.as_ref();
        match active {
            None => {
                if let Some(fence) = opening_fence(line) {
                    active = Some(fence);
                    mask[i] = true;
                }
            }
            Some(fence) => {
                mask[i] = true;
                if closes_fence(line, fence) {
                    active = None;
                }
            }
        }
    }
    mask
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_crlf_cr_and_a_bom() {
        assert_eq!(normalize_content("\u{feff}a\r\nb\rc\n"), "a\nb\nc\n");
    }

    #[test]
    fn strips_a_closing_run_of_hashes_but_keeps_a_trailing_hash() {
        assert_eq!(normalize_requirement_name("Foo ###"), "Foo");
        assert_eq!(normalize_requirement_name("C#"), "C#");
    }

    #[test]
    fn masks_fenced_blocks_including_the_fences() {
        let lines = normalized_lines("a\n```\ninside\n```\nb\n");
        assert_eq!(
            build_code_fence_mask(&lines),
            vec![false, true, true, true, false, false]
        );
    }

    #[test]
    fn a_shorter_run_does_not_close_a_longer_fence() {
        let lines = normalized_lines("````\n```\nstill inside\n````\nout\n");
        assert_eq!(
            build_code_fence_mask(&lines),
            vec![true, true, true, true, false, false]
        );
    }

    #[test]
    fn a_tilde_fence_is_not_closed_by_backticks() {
        let lines = normalized_lines("~~~\n```\n~~~\nout\n");
        assert_eq!(
            build_code_fence_mask(&lines),
            vec![true, true, true, false, false]
        );
    }

    #[test]
    fn an_unterminated_fence_masks_the_rest_of_the_file() {
        let lines = normalized_lines("```\n### Requirement: Fake\n");
        assert_eq!(build_code_fence_mask(&lines), vec![true, true, true]);
    }
}
