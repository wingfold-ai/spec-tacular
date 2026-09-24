//! Runs a driver's one-shot structured request and returns its value.
//!
//! Unlike a job this is not detached: it is short, its result is consumed by
//! the running TUI, and nothing needs to survive the TUI exiting. It is still
//! asynchronous — the UI keeps drawing and taking answers while it runs.
//!
//! Lands in stage 8.
