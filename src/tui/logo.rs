//! The start screen's wordmark.
//!
//! The TypeScript start screen drew `spec-tacular` with opentui's `ascii_font`
//! in the `block` face, falling back to `tiny` on a narrow terminal. Ratatui
//! has no font renderer, so the two faces' glyphs are embedded here — the same
//! `cfonts` shapes, character for character, so the two implementations show
//! the same logo. Only the twelve letters `spec-tacular` needs are carried;
//! a whole font would be dead weight in a binary whose size is the point.

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};

use super::theme::GRADIENT;

/// The word itself.
pub const LOGO: &str = "spec-tacular";

/// `block`: six rows tall, and what the start screen shows when it fits.
const BLOCK: &[(char, &[&str])] = &[
    (
        's',
        &[
            "███████╗",
            "██╔════╝",
            "███████╗",
            "╚════██║",
            "███████║",
            "╚══════╝",
        ],
    ),
    (
        'p',
        &[
            "██████╗ ",
            "██╔══██╗",
            "██████╔╝",
            "██╔═══╝ ",
            "██║     ",
            "╚═╝     ",
        ],
    ),
    (
        'e',
        &[
            "███████╗",
            "██╔════╝",
            "█████╗  ",
            "██╔══╝  ",
            "███████╗",
            "╚══════╝",
        ],
    ),
    (
        'c',
        &[
            " ██████╗",
            "██╔════╝",
            "██║     ",
            "██║     ",
            "╚██████╗",
            " ╚═════╝",
        ],
    ),
    (
        't',
        &[
            "████████╗",
            "╚══██╔══╝",
            "   ██║   ",
            "   ██║   ",
            "   ██║   ",
            "   ╚═╝   ",
        ],
    ),
    (
        'a',
        &[
            " █████╗ ",
            "██╔══██╗",
            "███████║",
            "██╔══██║",
            "██║  ██║",
            "╚═╝  ╚═╝",
        ],
    ),
    (
        'u',
        &[
            "██╗   ██╗",
            "██║   ██║",
            "██║   ██║",
            "██║   ██║",
            "╚██████╔╝",
            " ╚═════╝ ",
        ],
    ),
    (
        'l',
        &[
            "██╗     ",
            "██║     ",
            "██║     ",
            "██║     ",
            "███████╗",
            "╚══════╝",
        ],
    ),
    (
        'r',
        &[
            "██████╗ ",
            "██╔══██╗",
            "██████╔╝",
            "██╔══██╗",
            "██║  ██║",
            "╚═╝  ╚═╝",
        ],
    ),
    (
        '-',
        &["      ", "      ", "█████╗", "╚════╝", "      ", "      "],
    ),
];

/// `tiny`: two rows, for a terminal too narrow for `block`.
const TINY: &[(char, &[&str])] = &[
    ('s', &["█▀▀", "▄▄█"]),
    ('p', &["█▀█", "█▀▀"]),
    ('e', &["█▀▀", "██▄"]),
    ('c', &["█▀▀", "█▄▄"]),
    ('t', &["▀█▀", " █ "]),
    ('a', &["▄▀█", "█▀█"]),
    ('u', &["█ █", "█▄█"]),
    ('l', &["█  ", "█▄▄"]),
    ('r', &["█▀█", "█▀▄"]),
    ('-', &["▄▄", "  "]),
];

/// Which face a given terminal width can carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Face {
    Block,
    Tiny,
}

impl Face {
    fn glyphs(self) -> &'static [(char, &'static [&'static str])] {
        match self {
            Self::Block => BLOCK,
            Self::Tiny => TINY,
        }
    }

    pub fn rows(self) -> usize {
        match self {
            Self::Block => 6,
            Self::Tiny => 2,
        }
    }
}

fn glyph(face: Face, c: char) -> Option<&'static [&'static str]> {
    face.glyphs()
        .iter()
        .find(|(ch, _)| *ch == c)
        .map(|(_, rows)| *rows)
}

/// How wide `text` is in `face`, with one blank column between letters.
pub fn width(face: Face, text: &str) -> usize {
    let mut total = 0;
    for (i, c) in text.chars().enumerate() {
        if i > 0 {
            total += 1;
        }
        total += glyph(face, c).map_or(0, |rows| rows[0].chars().count());
    }
    total
}

/// The face that fits in `available` columns.
///
/// The TypeScript switched at a hard-coded 104 columns; measuring the word is
/// the same rule stated in terms of the thing it is actually about.
pub fn face_for(available: u16) -> Face {
    if width(Face::Block, LOGO) <= usize::from(available) {
        Face::Block
    } else {
        Face::Tiny
    }
}

/// The logo as rendered lines: typed in one letter per tick, then holding,
/// with the gradient drifting one step every third tick.
///
/// Each letter is one span, so the gradient is per letter exactly as the
/// TypeScript `ascii_font` `color` array made it.
pub fn logo_lines(face: Face, tick: usize) -> Vec<Line<'static>> {
    let typed: String = LOGO.chars().take(tick.saturating_add(1)).collect();
    let shift = tick / 3;

    (0..face.rows())
        .map(|row| {
            let mut spans: Vec<Span<'static>> = Vec::new();
            for (i, c) in typed.chars().enumerate() {
                if i > 0 {
                    spans.push(Span::raw(" "));
                }
                let Some(rows) = glyph(face, c) else { continue };
                let color: Color = GRADIENT[(i + shift) % GRADIENT.len()];
                spans.push(Span::styled(
                    rows[row].to_owned(),
                    Style::default().fg(color),
                ));
            }
            Line::from(spans)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_letter_of_the_word_has_a_glyph_in_both_faces() {
        for face in [Face::Block, Face::Tiny] {
            for c in LOGO.chars() {
                assert!(glyph(face, c).is_some(), "{face:?} is missing {c:?}");
            }
        }
    }

    #[test]
    fn a_glyphs_rows_are_all_the_same_width() {
        for face in [Face::Block, Face::Tiny] {
            for (c, rows) in face.glyphs() {
                assert_eq!(rows.len(), face.rows(), "{c:?} has the wrong row count");
                let w = rows[0].chars().count();
                assert!(
                    rows.iter().all(|r| r.chars().count() == w),
                    "{c:?} is ragged in {face:?}"
                );
            }
        }
    }

    #[test]
    fn a_narrow_terminal_gets_the_compact_face() {
        assert_eq!(face_for(200), Face::Block);
        assert_eq!(face_for(40), Face::Tiny);
        // The block face is the one the TypeScript needed ~104 columns for.
        assert!(width(Face::Block, LOGO) > 100);
    }

    #[test]
    fn it_types_itself_in_then_holds() {
        let first = logo_lines(Face::Block, 0);
        assert!(first[0].to_string().starts_with("███████╗"));
        assert_eq!(first[0].to_string().trim_end().chars().count(), 8);

        let whole = logo_lines(Face::Block, 99);
        assert_eq!(
            whole[0].to_string().chars().count(),
            width(Face::Block, LOGO)
        );
        assert_eq!(whole.len(), 6);
    }
}
