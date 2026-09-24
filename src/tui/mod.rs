//! The TUI shell.
//!
//! Two regions never leave the screen — the pipeline bar and the status line —
//! because "always visible" is the requirement this exists to meet
//! (docs/tui-design.md, "The constant frame").
//!
//! Kept thin: all derivation lives in `core/`, which is why the review loop's
//! behaviour is tested without a terminal and the screens only draw. In the
//! Rust port this is Ratatui over crossterm, driven by a tokio event loop, and
//! ctrl+c is a key the application handles rather than a signal that kills it.
//!
//! Lands in stage 5.
