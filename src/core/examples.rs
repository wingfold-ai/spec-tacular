//! The `{{example: ...}}` notation.
//!
//! Specs come back naming endpoints, table names and classes that nobody has
//! decided yet (docs/problem-analysis.md §5). Instructions alone demonstrably
//! do not hold — OpenSpec's own schema already says "avoid implementation
//! detail" and you still get endpoint names — so the distinction is made
//! explicit instead: an unmarked concrete value is a binding contract, a marked
//! one is an illustration.
//!
//! Marking is part of the requirement's text, so it changes the hash and resets
//! acceptance. That is correct: it changes what the requirement promises.

use super::markdown::pattern;

/// A `{{example: ...}}` occurrence, with byte offsets into the original text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExampleSpan {
    /// Offset of the opening `{{`.
    pub start: usize,
    /// Offset just past the closing `}}`.
    pub end: usize,
    /// The illustrative value itself.
    pub value: String,
}

pattern!(
    /// Non-greedy, and `}` is excluded from the value so a stray brace ends
    /// the span rather than swallowing the rest of the paragraph.
    EXAMPLE,
    r"(?i)\{\{\s*example:\s*([^}]*?)\s*\}\}"
);

pub fn find_examples(text: &str) -> Vec<ExampleSpan> {
    EXAMPLE
        .captures_iter(text)
        .filter_map(|caps| {
            let whole = caps.get(0)?;
            Some(ExampleSpan {
                start: whole.start(),
                end: whole.end(),
                value: caps.get(1).map_or("", |m| m.as_str()).trim().to_owned(),
            })
        })
        .collect()
}

/// Whether an offset falls inside a marked example.
pub fn is_inside_example(spans: &[ExampleSpan], offset: usize) -> bool {
    spans.iter().any(|s| offset >= s.start && offset < s.end)
}

/// Replaces each `{{example: X}}` with `X` for reading.
///
/// The braces are noise on screen; what matters is that the reviewer knows
/// which values are illustrative, which the caller shows separately.
pub fn render_examples(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for span in find_examples(text) {
        out.push_str(&text[at..span.start]);
        out.push_str(&span.value);
        at = span.end;
    }
    out.push_str(&text[at..]);
    out
}

/// Every illustrative value in the text, in order.
pub fn example_values(text: &str) -> Vec<String> {
    find_examples(text).into_iter().map(|s| s.value).collect()
}

/// Wraps the first occurrence of `value` in `{{example: ...}}`.
///
/// Returns `None` when it cannot be done unambiguously — the value is absent,
/// or already inside a marked example. Rewriting a spec on a guess is worse
/// than declining and letting the reviewer open an editor.
pub fn mark_as_example(text: &str, value: &str) -> Option<String> {
    if value.trim().is_empty() {
        return None;
    }
    let spans = find_examples(text);

    let mut from = 0;
    loop {
        let at = from + text.get(from..)?.find(value)?;
        if !is_inside_example(&spans, at) {
            return Some(format!(
                "{}{{{{example: {value}}}}}{}",
                &text[..at],
                &text[at + value.len()..]
            ));
        }
        // Step one byte past the rejected occurrence, then back onto a
        // character boundary, so a multi-byte character cannot split a slice.
        from = at + 1;
        while from < text.len() && !text.is_char_boundary(from) {
            from += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_marked_values_with_their_offsets() {
        let text = "SHALL expose {{example: POST /v1/x}} today.";
        let spans = find_examples(text);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].value, "POST /v1/x");
        assert_eq!(
            &text[spans[0].start..spans[0].end],
            "{{example: POST /v1/x}}"
        );
    }

    #[test]
    fn is_case_and_whitespace_tolerant() {
        assert_eq!(example_values("{{ Example:  CSV }}"), vec!["CSV"]);
    }

    #[test]
    fn renders_without_the_braces_since_they_are_noise_on_screen() {
        assert_eq!(
            render_examples("Returns {{example: CSV}} data."),
            "Returns CSV data."
        );
    }

    #[test]
    fn a_stray_brace_ends_the_span_rather_than_swallowing_the_paragraph() {
        assert!(example_values("{{example: a} and then a whole lot more text").is_empty());
    }

    #[test]
    fn handles_several_in_one_text() {
        assert_eq!(
            example_values("{{example: A}} and {{example: B}}"),
            vec!["A", "B"]
        );
    }

    #[test]
    fn mark_as_example_wraps_the_first_occurrence() {
        assert_eq!(
            mark_as_example("SHALL expose POST /v1/x.", "POST /v1/x").as_deref(),
            Some("SHALL expose {{example: POST /v1/x}}.")
        );
    }

    #[test]
    fn mark_as_example_declines_when_the_value_is_absent_rather_than_guessing() {
        assert_eq!(mark_as_example("nothing here", "POST /v1/x"), None);
    }

    #[test]
    fn mark_as_example_skips_an_occurrence_already_inside_a_marked_example() {
        assert_eq!(
            mark_as_example("{{example: CSV}} and then CSV again", "CSV").as_deref(),
            Some("{{example: CSV}} and then {{example: CSV}} again")
        );
    }

    #[test]
    fn mark_as_example_declines_when_every_occurrence_is_already_marked() {
        assert_eq!(mark_as_example("{{example: CSV}}", "CSV"), None);
    }

    #[test]
    fn mark_as_example_declines_an_empty_value() {
        assert_eq!(mark_as_example("anything", "  "), None);
    }
}
