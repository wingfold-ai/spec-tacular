//! Keyboard helpers shared by every screen that takes typed text.
//!
//! Kept in one place because the rules are subtle and must not diverge: a
//! prompt that treats alt-x as a typed "x", or waits on a lone escape, breaks
//! in exactly the terminals nobody tested.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// A key that contributes a character to a prompt, as opposed to a command.
///
/// Alt-chords are excluded: crossterm reports them as the same character with
/// `ALT` set, and typing a stray letter for one is the bug this guards.
pub fn is_printable(key: &KeyEvent) -> bool {
    match key.code {
        KeyCode::Char(c) => {
            !key.modifiers.contains(KeyModifiers::CONTROL)
                && !key.modifiers.contains(KeyModifiers::ALT)
                && !c.is_control()
        }
        _ => false,
    }
}

/// `ctrl+c`, not a bare escape, is the reliable cancel.
///
/// A lone ESC is the prefix of every escape sequence, so a terminal parser
/// cannot deliver it until it sees what follows — pressing it alone produces
/// no event at all, and pressing it before `x` arrives as alt-x. `Esc` is
/// still handled for terminals that do resolve it, but nothing depends on it.
pub fn is_cancel(key: &KeyEvent) -> bool {
    key.code == KeyCode::Esc || is_ctrl(key, 'c')
}

pub fn is_enter(key: &KeyEvent) -> bool {
    key.code == KeyCode::Enter
}

/// Whether this is `ctrl+<c>`.
pub fn is_ctrl(key: &KeyEvent, c: char) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char(c)
}

/// Applies a key to a line being typed. Returns `None` when the key is not
/// editing, so the caller can treat it as a command.
pub fn edit_line(draft: &str, key: &KeyEvent) -> Option<String> {
    if key.code == KeyCode::Backspace {
        let mut out = draft.to_owned();
        out.pop();
        return Some(out);
    }
    // The readline chords everyone's fingers know: clear the line, drop a word.
    if is_ctrl(key, 'u') {
        return Some(String::new());
    }
    if is_ctrl(key, 'w') {
        // `/\S+\s*$/`: the last word and any space after it. A draft that is
        // only whitespace has no word to drop and is left as it is.
        let body = draft.trim_end();
        if body.is_empty() {
            return Some(draft.to_owned());
        }
        return Some(
            body.trim_end_matches(|c: char| !c.is_whitespace())
                .to_owned(),
        );
    }
    if is_printable(key) {
        if let KeyCode::Char(c) = key.code {
            return Some(format!("{draft}{c}"));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }

    #[test]
    fn ctrl_u_clears_and_ctrl_w_drops_a_word() {
        assert_eq!(edit_line("add user login", &ctrl('u')).as_deref(), Some(""));
        assert_eq!(
            edit_line("add user login", &ctrl('w')).as_deref(),
            Some("add user ")
        );
        // The trailing space goes with the word before it, as in readline.
        assert_eq!(edit_line("add user ", &ctrl('w')).as_deref(), Some("add "));
        assert_eq!(edit_line("  ", &ctrl('w')).as_deref(), Some("  "));
    }

    #[test]
    fn a_printable_key_extends_the_draft_and_a_command_key_does_not() {
        assert_eq!(
            edit_line("ab", &key(KeyCode::Char('c'))).as_deref(),
            Some("abc")
        );
        assert_eq!(
            edit_line("ab", &key(KeyCode::Backspace)).as_deref(),
            Some("a")
        );
        assert!(edit_line("ab", &key(KeyCode::Up)).is_none());
        assert!(edit_line("ab", &key(KeyCode::Tab)).is_none());
    }

    #[test]
    fn an_alt_chord_types_nothing() {
        let alt = KeyEvent::new(KeyCode::Char('x'), KeyModifiers::ALT);
        assert!(!is_printable(&alt));
        assert!(edit_line("ab", &alt).is_none());
    }

    #[test]
    fn cancel_is_ctrl_c_and_also_escape_where_it_arrives() {
        assert!(is_cancel(&ctrl('c')));
        assert!(is_cancel(&key(KeyCode::Esc)));
        assert!(!is_cancel(&key(KeyCode::Char('c'))));
    }
}
