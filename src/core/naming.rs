//! Names for a new change, proposed from what it is meant to do.
//!
//! Asking for a kebab-case name before anything else puts the hardest, least
//! important question first. The description comes first instead; a name is
//! proposed from it — instantly from its words, then better from a model — and
//! the developer adjusts it.
//!
//! The instant proposal lands here with the new-change prompt in stage 5. The
//! model-backed half — the prompt, its schema and the filter over what comes
//! back — waits for the advisor in stage 8.

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
    fn a_name_the_description_already_spells_is_kept_whole() {
        assert_eq!(
            name_from_description("add-user-login please", &[]),
            "add-login-please"
        );
    }
}
