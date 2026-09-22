//! Plain-text rendering of the pipeline.
//!
//! Exists so the overview works without a TTY — in CI, over a pipe, in a remote
//! session — and so the layout can be unit-tested without driving a terminal.
//! The TUI renders the same model; this is the reference output, not a fallback
//! afterthought.
//!
//! Lands in stage 3.
