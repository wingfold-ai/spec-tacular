//! Rendering the model as text.
//!
//! Shared by `--print` and by the TUI, so the two can never disagree about
//! what anything looks like.

/// The review screen's rendering. Its caller is the TUI, in stage 6.
#[allow(dead_code)]
pub mod requirement;
pub mod text;
