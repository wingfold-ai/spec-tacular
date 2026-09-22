//! The review session: a cursor over a change's requirement queue, plus the
//! decisions made against it.
//!
//! Pure and I/O-free on purpose. The review loop is the product
//! (docs/problem-analysis.md §3), so its behaviour — what "next" means, what a
//! decision does to the cursor, where you land when you come back — is defined
//! here and tested without a terminal. The TUI only draws the current item.
//!
//! Lands in stage 2.
