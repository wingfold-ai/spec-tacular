//! Names for a new change, proposed from what it is meant to do.
//!
//! Asking for a kebab-case name before anything else puts the hardest, least
//! important question first. The description comes first instead; a name is
//! proposed from it — instantly from its words, then better from a model — and
//! the developer adjusts it.
//!
//! Both halves are here: the instant name from the description's own words,
//! and the model-backed one — its prompt, its schema and the filter over what
//! comes back, so a model can never propose a name OpenSpec would refuse or
//! one that is already taken.

use serde_json::{json, Value};

use super::guide::validate_change_name;

/// Words that carry no meaning in a change name.
const FILLER: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "to", "of", "for", "in", "on", "at", "by", "with",
    "from", "as", "is", "are", "be", "it", "its", "this", "that", "we", "i", "our", "my", "so",
    "can", "should", "will", "want", "need", "let", "lets", "users", "user", "able", "into",
    "when", "which", "their", "them", "they", "have", "has", "new", "also", "more",
];

/// A name from the description's own words, with no model: the fallback, and
/// what is shown while a better one is on its way.
pub fn name_from_description(description: &str, taken: &[String]) -> String {
    let lowered: String = description
        .chars()
        .map(|c| {
            let c = c.to_ascii_lowercase();
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect();

    let words: Vec<&str> = lowered
        .split(|c: char| c.is_whitespace() || c == '-')
        .filter(|w| w.chars().count() > 1 && !FILLER.contains(w))
        .take(4)
        .collect();

    let base = if words.is_empty() {
        "new-change".to_owned()
    } else {
        words.join("-")
    };
    unique(&base, taken)
}

/// `name`, or `name-2`, `name-3`… when it is taken.
pub fn unique(name: &str, taken: &[String]) -> String {
    if !taken.iter().any(|t| t == name) {
        return name.to_owned();
    }
    for i in 2.. {
        let candidate = format!("{name}-{i}");
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("the loop returns for some i")
}

/// What a name proposal answers in: the best name and a few alternatives.
pub fn name_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string" },
            "alternatives": { "type": "array", "items": { "type": "string" } },
        },
        "required": ["name", "alternatives"],
    })
}

/// Asks for a name for the change `description` describes.
pub fn build_name_prompt(description: &str, taken: &[String]) -> String {
    let mut lines = vec![
        "Name a change in a spec-driven project. The name is a directory name and how".to_owned(),
        "the team will refer to the change: kebab-case, lowercase, 2 to 4 words, verb".to_owned(),
        "first where natural (add-user-login, fix-export-timeout, migrate-to-postgres).".to_owned(),
        String::new(),
        format!("The change: {description}"),
    ];
    if !taken.is_empty() {
        lines.push(String::new());
        lines.push(format!("Already taken: {}", taken.join(", ")));
    }
    lines.push(String::new());
    lines.push("Return the best name and 2 alternatives.".to_owned());
    lines.join("\n")
}

/// Only names OpenSpec would accept, not already taken, best first, each once.
pub fn parse_names(raw: &Value, taken: &[String]) -> Vec<String> {
    let Some(record) = raw.as_object() else {
        return Vec::new();
    };
    let alternatives = record
        .get("alternatives")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut names: Vec<String> = Vec::new();
    for value in record.get("name").into_iter().chain(alternatives) {
        let name = match value {
            Value::String(s) => s.trim().to_lowercase(),
            Value::Null => String::new(),
            other => other.to_string().trim().to_lowercase(),
        };
        if validate_change_name(&name).is_none() && !taken.contains(&name) && !names.contains(&name)
        {
            names.push(name);
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn taken(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[test]
    fn it_keeps_the_words_that_carry_meaning() {
        assert_eq!(
            name_from_description("Let users sign in with email and password", &[]),
            "sign-email-password"
        );
        assert_eq!(
            name_from_description("Fix the export timeout on large accounts", &[]),
            "fix-export-timeout-large"
        );
        assert_eq!(name_from_description("!!!", &[]), "new-change");
    }

    #[test]
    fn it_never_proposes_a_name_that_is_taken() {
        assert_eq!(
            unique("add-login", &taken(&["add-login", "add-login-2"])),
            "add-login-3"
        );
        assert_eq!(
            name_from_description("add login", &taken(&["add-login"])),
            "add-login-2"
        );
    }

    #[test]
    fn the_models_names_are_filtered_to_valid_free_ones() {
        let names = parse_names(
            &json!({
                "name": "add-user-login",
                "alternatives": ["Add Login", "taken-one", "user-sign-in", "add-user-login"],
            }),
            &taken(&["taken-one"]),
        );
        assert_eq!(names, ["add-user-login", "user-sign-in"]);
        assert!(parse_names(&Value::Null, &[]).is_empty());
    }

    #[test]
    fn the_prompt_carries_the_description_and_what_is_taken() {
        let prompt = build_name_prompt("Let users sign in", &taken(&["add-export"]));
        assert!(prompt.contains("The change: Let users sign in"));
        assert!(prompt.contains("Already taken: add-export"));
        assert!(!build_name_prompt("x", &[]).contains("Already taken"));
    }

    #[test]
    fn a_name_the_description_already_spells_is_kept_whole() {
        assert_eq!(
            name_from_description("add-user-login please", &[]),
            "add-login-please"
        );
    }
}
