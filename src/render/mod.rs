//! Rendering the model as text.
//!
//! Shared by `--print` and by the TUI, so the two can never disagree about
//! what anything looks like.

/// A requirement, its progress bar and its counts, as text. The TUI's review
/// screen draws the same parts styled, from `noun`, `wrap`, the bar and the
/// counts; `render_requirement` — the whole item as one plain string — has
/// no caller outside its tests.
#[allow(dead_code)]
pub mod requirement;
pub mod text;
