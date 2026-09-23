//! One palette, shared by every screen so the UI reads as one system.
//!
//! The values are the TypeScript `src/tui/theme.ts` constants, unchanged: the
//! two implementations are meant to look like one program while the port is in
//! flight, and a colour that drifts is the easiest way to notice they are not.

use ratatui::style::Color;

/// `#7aa2f7` — the accent: focus, the current stage, a heading.
pub const ACCENT: Color = Color::Rgb(0x7a, 0xa2, 0xf7);
/// `#bb9af7` — the second accent: a label above a body of text.
pub const ACCENT2: Color = Color::Rgb(0xbb, 0x9a, 0xf7);
/// `#565f89` — anything secondary.
pub const DIM: Color = Color::Rgb(0x56, 0x5f, 0x89);
/// `#c0caf5` — body text.
pub const TEXT: Color = Color::Rgb(0xc0, 0xca, 0xf5);
/// `#e0af68` — a warning, and the notice line.
pub const WARN: Color = Color::Rgb(0xe0, 0xaf, 0x68);
/// `#f7768e` — an error.
pub const ERR: Color = Color::Rgb(0xf7, 0x76, 0x8e);
/// `#9ece6a` — accepted, done.
pub const OK: Color = Color::Rgb(0x9e, 0xce, 0x6a);
/// `#1a1b26` — the background.
pub const BG: Color = Color::Rgb(0x1a, 0x1b, 0x26);
/// `#1f2335` — panels sit one step above the background.
pub const PANEL: Color = Color::Rgb(0x1f, 0x23, 0x35);
/// `#3b4261` — a panel's border.
pub const BORDER: Color = Color::Rgb(0x3b, 0x42, 0x61);
/// `#2f3549` — a selected row or a focused button.
pub const HIGHLIGHT: Color = Color::Rgb(0x2f, 0x35, 0x49);
/// `#1a1b26` — text on an accent-filled button.
pub const ON_ACCENT: Color = Color::Rgb(0x1a, 0x1b, 0x26);

/// The logo's gradient, cycled to animate it.
pub const GRADIENT: [Color; 10] = [
    Color::Rgb(0x7a, 0xa2, 0xf7),
    Color::Rgb(0x7d, 0xa6, 0xff),
    Color::Rgb(0x89, 0xb4, 0xfa),
    Color::Rgb(0x9d, 0x7c, 0xd8),
    Color::Rgb(0xbb, 0x9a, 0xf7),
    Color::Rgb(0xc0, 0xa8, 0xff),
    Color::Rgb(0xbb, 0x9a, 0xf7),
    Color::Rgb(0x9d, 0x7c, 0xd8),
    Color::Rgb(0x89, 0xb4, 0xfa),
    Color::Rgb(0x7d, 0xa6, 0xff),
];
